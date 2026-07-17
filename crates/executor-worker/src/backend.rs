use std::path::{Path, PathBuf};

use crate::config::{BackendKind, WorkerConfig};

/// shellを介さず起動するコマンドの完全な指定です。
#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct CommandSpec {
    /// 実行ファイルです。
    pub(crate) program: String,
    /// 引数です。
    pub(crate) args: Vec<String>,
    /// ホスト側の作業ディレクトリです。
    pub(crate) cwd: PathBuf,
    /// 明示的に許可する環境変数です。
    pub(crate) environment: Vec<(String, String)>,
}

/// 設定に応じてdirectまたはNsJailコマンドを組み立てます。
#[derive(Clone)]
pub(crate) struct CommandFactory {
    config: WorkerConfig,
}

impl CommandFactory {
    /// Worker設定からfactoryを作ります。
    pub(crate) fn new(config: WorkerConfig) -> Self {
        Self { config }
    }

    /// `main.c` を `main.o` へコンパイルするコマンドです。
    pub(crate) fn compile(&self, workspace: &Path) -> CommandSpec {
        let compiler = self.config.clang_path.to_string_lossy().into_owned();
        let args = vec![
            format!("--target={}", self.config.musl_target),
            "-nostdinc".to_owned(),
            "-isystem".to_owned(),
            self.config
                .clang_resource_include
                .to_string_lossy()
                .into_owned(),
            "-isystem".to_owned(),
            self.config.musl_include.to_string_lossy().into_owned(),
            "-std=c17".to_owned(),
            "-O0".to_owned(),
            "-Wall".to_owned(),
            "-Wextra".to_owned(),
            "-Wpedantic".to_owned(),
            "-fno-color-diagnostics".to_owned(),
            "-c".to_owned(),
            "main.c".to_owned(),
            "-o".to_owned(),
            "main.o".to_owned(),
        ];
        self.wrap_compile(workspace, compiler, args)
    }

    /// `main.o` をmusl静的実行ファイルへリンクするコマンドです。
    pub(crate) fn link(&self, workspace: &Path) -> CommandSpec {
        let linker = self.config.musl_cc_path.to_string_lossy().into_owned();
        let args = vec![
            "-static".to_owned(),
            "main.o".to_owned(),
            "-lm".to_owned(),
            "-o".to_owned(),
            "main".to_owned(),
        ];
        self.wrap_compile(workspace, linker, args)
    }

    /// コンパイル済みプログラムをPTYで起動するコマンドです。
    pub(crate) fn runtime(&self, workspace: &Path) -> CommandSpec {
        match self.config.backend {
            BackendKind::Direct => CommandSpec {
                program: workspace.join("main").to_string_lossy().into_owned(),
                args: Vec::new(),
                cwd: workspace.to_path_buf(),
                environment: runtime_environment(),
            },
            BackendKind::NsJail => {
                let mount = format!("{}:/workspace", workspace.to_string_lossy());
                CommandSpec {
                    program: self.config.nsjail_path.to_string_lossy().into_owned(),
                    args: vec![
                        "--config".to_owned(),
                        self.config
                            .nsjail_runtime_config
                            .to_string_lossy()
                            .into_owned(),
                        "--bindmount_ro".to_owned(),
                        mount,
                        "--seccomp_policy".to_owned(),
                        self.config
                            .nsjail_runtime_seccomp
                            .to_string_lossy()
                            .into_owned(),
                        "--".to_owned(),
                        "/workspace/main".to_owned(),
                    ],
                    cwd: workspace.to_path_buf(),
                    environment: Vec::new(),
                }
            }
        }
    }

    fn wrap_compile(&self, workspace: &Path, program: String, args: Vec<String>) -> CommandSpec {
        match self.config.backend {
            BackendKind::Direct => CommandSpec {
                program,
                args,
                cwd: workspace.to_path_buf(),
                environment: compile_environment(),
            },
            BackendKind::NsJail => {
                let jail_program = jail_program_path(&program);
                let mount = format!("{}:/workspace", workspace.to_string_lossy());
                let mut jail_args = vec![
                    "--config".to_owned(),
                    self.config
                        .nsjail_compile_config
                        .to_string_lossy()
                        .into_owned(),
                    "--bindmount".to_owned(),
                    mount,
                    "--seccomp_policy".to_owned(),
                    self.config
                        .nsjail_compile_seccomp
                        .to_string_lossy()
                        .into_owned(),
                    "--".to_owned(),
                    jail_program,
                ];
                jail_args.extend(args);
                CommandSpec {
                    program: self.config.nsjail_path.to_string_lossy().into_owned(),
                    args: jail_args,
                    cwd: workspace.to_path_buf(),
                    environment: Vec::new(),
                }
            }
        }
    }
}

fn jail_program_path(host_path: &str) -> String {
    // Workerイメージではtoolchainを同じ絶対パスでread-only bindする前提です。
    host_path.to_owned()
}

fn compile_environment() -> Vec<(String, String)> {
    vec![
        (
            "PATH".to_owned(),
            "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin".to_owned(),
        ),
        ("HOME".to_owned(), "/nonexistent".to_owned()),
        ("LC_ALL".to_owned(), "C".to_owned()),
        ("TMPDIR".to_owned(), "/tmp".to_owned()),
    ]
}

fn runtime_environment() -> Vec<(String, String)> {
    vec![
        ("HOME".to_owned(), "/nonexistent".to_owned()),
        ("LANG".to_owned(), "C.UTF-8".to_owned()),
        ("LC_ALL".to_owned(), "C.UTF-8".to_owned()),
        ("TERM".to_owned(), "xterm-256color".to_owned()),
    ]
}

#[cfg(test)]
mod tests {
    use tempfile::tempdir;

    use super::*;

    #[test]
    fn direct_compile_never_uses_shell() {
        let root = tempdir().expect("tempdirを作れます");
        let config = WorkerConfig::for_test(root.path().to_path_buf());
        let spec = CommandFactory::new(config).compile(root.path());

        assert_eq!(spec.program, "/usr/bin/clang");
        assert!(
            spec.args
                .iter()
                .any(|argument| argument.starts_with("--target="))
        );
        assert!(spec.args.contains(&"-nostdinc".to_owned()));
        assert!(spec.args.contains(&"-std=c17".to_owned()));
        assert!(!spec.args.iter().any(|arg| arg == "-c" && arg.contains(';')));
    }

    #[test]
    fn nsjail_runtime_mounts_workspace_read_only() {
        let root = tempdir().expect("tempdirを作れます");
        let mut config = WorkerConfig::for_test(root.path().to_path_buf());
        config.backend = BackendKind::NsJail;
        let spec = CommandFactory::new(config).runtime(root.path());

        assert_eq!(spec.program, "/usr/local/bin/nsjail");
        let bind_index = spec
            .args
            .iter()
            .position(|arg| arg == "--bindmount_ro")
            .expect("read-only bindがあります");
        assert!(spec.args[bind_index + 1].ends_with(":/workspace"));
        assert_eq!(
            spec.args.last().map(String::as_str),
            Some("/workspace/main")
        );
    }
}
