use std::{
    env,
    path::{Path, PathBuf},
    time::Duration,
};

use thiserror::Error;
use uuid::Uuid;

/// Workerイメージに組み込む対話実行用support objectの固定パスです。
const RUNTIME_SUPPORT_OBJECT_PATH: &str = "/usr/local/lib/smart-c/runtime-support.o";

/// 実行方法を選択します。
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum BackendKind {
    /// NsJailで名前空間・RLIMIT・seccompを適用します。
    NsJail,
    /// 開発とテストに限りホスト上で直接起動します。
    Direct,
}

impl BackendKind {
    /// Worker登録で送る安定した名前です。
    pub fn as_str(self) -> &'static str {
        match self {
            Self::NsJail => "nsjail",
            Self::Direct => "direct",
        }
    }
}

/// executor-workerの起動設定です。
#[derive(Clone, Debug)]
pub struct WorkerConfig {
    /// executor-apiのgRPC URLです。
    pub api_grpc_url: String,
    /// Workerを識別する名前です。
    pub worker_id: String,
    /// gRPC接続で送るWorker共有トークンです。
    pub worker_token: String,
    /// WorkerイメージのCPUアーキテクチャです。
    pub architecture: String,
    /// 実行バックエンドです。
    pub backend: BackendKind,
    /// APIへ登録する前にsandbox smoke testを必須実行するかどうかです。
    pub require_startup_smoke: bool,
    /// 一時workspaceを作る親ディレクトリです。
    pub workspace_root: PathBuf,
    /// clang実行ファイルです。
    pub clang_path: PathBuf,
    /// Clang組み込みheaderのincludeディレクトリです。
    pub clang_resource_include: PathBuf,
    /// Clangへ指定するmusl target tripleです。
    pub musl_target: String,
    /// musl標準headerのincludeディレクトリです。
    pub musl_include: PathBuf,
    /// 静的リンクに使うmusl-gccです。
    pub musl_cc_path: PathBuf,
    /// 対話実行向けのstdio設定を含む静的リンク用objectです。
    pub runtime_support_object: PathBuf,
    /// NsJail実行ファイルです。
    pub nsjail_path: PathBuf,
    /// コンパイル用NsJail設定です。
    pub nsjail_compile_config: PathBuf,
    /// 実行用NsJail設定です。
    pub nsjail_runtime_config: PathBuf,
    /// コンパイル用seccompポリシーです。
    pub nsjail_compile_seccomp: PathBuf,
    /// 実行用seccompポリシーです。
    pub nsjail_runtime_seccomp: PathBuf,
    /// コンパイル全体のwall time上限です。
    pub compile_timeout: Duration,
    /// 実行のwall time上限です。
    pub runtime_timeout: Duration,
    /// コンパイラ出力の上限です。
    pub compile_output_limit: usize,
    /// PTY出力の上限です。
    pub runtime_output_limit: usize,
}

impl WorkerConfig {
    /// 環境変数を読み、productionではNsJail以外をfail-closedにします。
    pub fn from_env() -> Result<Self, ConfigError> {
        let environment = env::var("SMART_C_ENV").unwrap_or_else(|_| "development".to_owned());
        let backend_name = env::var("EXECUTOR_BACKEND").unwrap_or_else(|_| {
            if environment == "production" {
                "nsjail".to_owned()
            } else {
                "direct".to_owned()
            }
        });
        let backend = match backend_name.as_str() {
            "nsjail" => BackendKind::NsJail,
            "direct" if environment != "production" => BackendKind::Direct,
            "direct" => return Err(ConfigError::DirectBackendInProduction),
            _ => return Err(ConfigError::InvalidBackend(backend_name)),
        };
        let workspace_root = env::var_os("EXECUTOR_WORKSPACE_ROOT")
            .map(PathBuf::from)
            .unwrap_or_else(|| {
                if environment == "production" {
                    PathBuf::from("/work")
                } else {
                    env::temp_dir().join("smart-c-workspaces")
                }
            });
        let worker_token = match env::var("EXECUTOR_WORKER_TOKEN") {
            Ok(value) if !value.is_empty() => value,
            _ if environment == "production" => {
                return Err(ConfigError::MissingWorkerToken);
            }
            _ => "development-worker-token".to_owned(),
        };
        if !is_visible_ascii(&worker_token) {
            return Err(ConfigError::InvalidWorkerToken);
        }
        if environment == "production" && worker_token.len() < 32 {
            return Err(ConfigError::WeakWorkerToken);
        }
        let config = Self {
            api_grpc_url: env::var("EXECUTOR_API_GRPC_URL")
                .unwrap_or_else(|_| "http://127.0.0.1:50051".to_owned()),
            worker_id: env::var("EXECUTOR_WORKER_ID").unwrap_or_else(|_| {
                env::var("HOSTNAME").unwrap_or_else(|_| format!("worker-{}", Uuid::new_v4()))
            }),
            worker_token,
            architecture: env::consts::ARCH.to_owned(),
            backend,
            require_startup_smoke: environment == "production",
            workspace_root,
            clang_path: path_env("SMART_C_CLANG", "/usr/bin/clang"),
            clang_resource_include: path_env(
                "SMART_C_CLANG_RESOURCE_INCLUDE",
                "/usr/lib/clang/18/include",
            ),
            musl_target: env::var("SMART_C_MUSL_TARGET")
                .unwrap_or_else(|_| default_musl_target(env::consts::ARCH)),
            musl_include: path_env(
                "SMART_C_MUSL_INCLUDE",
                &format!("/usr/include/{}", default_musl_target(env::consts::ARCH)),
            ),
            musl_cc_path: path_env("SMART_C_MUSL_CC", "/usr/bin/musl-gcc"),
            runtime_support_object: PathBuf::from(RUNTIME_SUPPORT_OBJECT_PATH),
            nsjail_path: path_env("NSJAIL_BIN", "/usr/local/bin/nsjail"),
            nsjail_compile_config: path_env(
                "NSJAIL_COMPILE_CONFIG",
                "/etc/smart-c/nsjail/compile.cfg",
            ),
            nsjail_runtime_config: path_env(
                "NSJAIL_RUNTIME_CONFIG",
                "/etc/smart-c/nsjail/runtime.cfg",
            ),
            nsjail_compile_seccomp: path_env(
                "NSJAIL_COMPILE_SECCOMP",
                "/etc/smart-c/nsjail/compile.seccomp",
            ),
            nsjail_runtime_seccomp: path_env(
                "NSJAIL_RUNTIME_SECCOMP",
                "/etc/smart-c/nsjail/runtime.seccomp",
            ),
            compile_timeout: Duration::from_secs(5),
            runtime_timeout: Duration::from_secs(120),
            compile_output_limit: 256 * 1024,
            runtime_output_limit: 1024 * 1024,
        };
        config.validate_preconditions()?;
        Ok(config)
    }

    /// 起動時に必要なバイナリと設定が揃っているか確認します。
    pub fn validate_preconditions(&self) -> Result<(), ConfigError> {
        std::fs::create_dir_all(&self.workspace_root).map_err(|source| ConfigError::Workspace {
            path: self.workspace_root.clone(),
            source,
        })?;

        require_file(&self.clang_path)?;
        require_directory(&self.clang_resource_include)?;
        require_directory(&self.musl_include)?;
        require_file(&self.musl_cc_path)?;
        require_file(&self.runtime_support_object)?;
        if self.backend == BackendKind::NsJail {
            for path in [
                &self.nsjail_path,
                &self.nsjail_compile_config,
                &self.nsjail_runtime_config,
                &self.nsjail_compile_seccomp,
                &self.nsjail_runtime_seccomp,
            ] {
                require_file(path)?;
            }
        }
        Ok(())
    }

    /// 単体テスト用の直接実行設定です。
    #[cfg(test)]
    pub fn for_test(root: PathBuf) -> Self {
        Self {
            api_grpc_url: "http://127.0.0.1:50051".to_owned(),
            worker_id: "test-worker".to_owned(),
            worker_token: "test-worker-token".to_owned(),
            architecture: env::consts::ARCH.to_owned(),
            backend: BackendKind::Direct,
            require_startup_smoke: false,
            workspace_root: root,
            clang_path: PathBuf::from("/usr/bin/clang"),
            clang_resource_include: PathBuf::from("/usr/lib/clang/18/include"),
            musl_target: default_musl_target(env::consts::ARCH),
            musl_include: PathBuf::from(format!(
                "/usr/include/{}",
                default_musl_target(env::consts::ARCH)
            )),
            musl_cc_path: PathBuf::from("/usr/bin/musl-gcc"),
            runtime_support_object: PathBuf::from(RUNTIME_SUPPORT_OBJECT_PATH),
            nsjail_path: PathBuf::from("/usr/local/bin/nsjail"),
            nsjail_compile_config: PathBuf::from("/etc/smart-c/nsjail/compile.cfg"),
            nsjail_runtime_config: PathBuf::from("/etc/smart-c/nsjail/runtime.cfg"),
            nsjail_compile_seccomp: PathBuf::from("/etc/smart-c/nsjail/compile.seccomp"),
            nsjail_runtime_seccomp: PathBuf::from("/etc/smart-c/nsjail/runtime.seccomp"),
            compile_timeout: Duration::from_secs(5),
            runtime_timeout: Duration::from_secs(120),
            compile_output_limit: 256 * 1024,
            runtime_output_limit: 1024 * 1024,
        }
    }
}

/// Worker設定が安全に使えない理由です。
#[derive(Debug, Error)]
pub enum ConfigError {
    /// backend名が未対応です。
    #[error("EXECUTOR_BACKEND は nsjail または direct にしてください: {0}")]
    InvalidBackend(String),
    /// productionでdirect backendが指定されました。
    #[error("productionではEXECUTOR_BACKEND=nsjailが必須です")]
    DirectBackendInProduction,
    /// 本番用Worker共有トークンがありません。
    #[error("productionではEXECUTOR_WORKER_TOKENが必須です")]
    MissingWorkerToken,
    /// 本番用Worker共有トークンが短すぎます。
    #[error("productionではEXECUTOR_WORKER_TOKENを32バイト以上にしてください")]
    WeakWorkerToken,
    /// gRPC metadataへ格納できないWorker共有トークンです。
    #[error("EXECUTOR_WORKER_TOKENは空白や制御文字を含まないASCII文字列にしてください")]
    InvalidWorkerToken,
    /// 必要なファイルがありません。
    #[error("実行に必要なファイルがありません: {0}")]
    MissingFile(PathBuf),
    /// 必要なディレクトリがありません。
    #[error("実行に必要なディレクトリがありません: {0}")]
    MissingDirectory(PathBuf),
    /// workspaceを準備できません。
    #[error("workspaceディレクトリ {path} を準備できません: {source}")]
    Workspace {
        /// 対象パスです。
        path: PathBuf,
        /// OSエラーです。
        source: std::io::Error,
    },
}

fn path_env(name: &str, default: &str) -> PathBuf {
    env::var_os(name)
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(default))
}

fn require_file(path: &Path) -> Result<(), ConfigError> {
    if path.is_file() {
        Ok(())
    } else {
        Err(ConfigError::MissingFile(path.to_path_buf()))
    }
}

fn require_directory(path: &Path) -> Result<(), ConfigError> {
    if path.is_dir() {
        Ok(())
    } else {
        Err(ConfigError::MissingDirectory(path.to_path_buf()))
    }
}

fn default_musl_target(architecture: &str) -> String {
    match architecture {
        "x86_64" => "x86_64-linux-musl".to_owned(),
        "aarch64" => "aarch64-linux-musl".to_owned(),
        other => format!("{other}-linux-musl"),
    }
}

/// gRPC metadataへ安全に格納できる文字列か確認します。
fn is_visible_ascii(value: &str) -> bool {
    !value.is_empty() && value.bytes().all(|byte| (0x21..=0x7e).contains(&byte))
}

#[cfg(test)]
mod tests {
    use std::fs;

    use tempfile::tempdir;

    use super::{ConfigError, WorkerConfig, is_visible_ascii};

    #[test]
    fn validates_worker_token_characters() {
        assert!(is_visible_ascii("valid-worker-token_123"));
        assert!(!is_visible_ascii(""));
        assert!(!is_visible_ascii("contains space"));
        assert!(!is_visible_ascii("contains\nnewline"));
        assert!(!is_visible_ascii("日本語"));
    }

    /// runtime support objectが欠落したWorker設定を起動前検証で拒否します。
    #[test]
    fn rejects_missing_runtime_support_object() {
        let root = tempdir().expect("tempdirを作れます");
        let mut config = WorkerConfig::for_test(root.path().join("workspaces"));
        config.clang_path = root.path().join("clang");
        config.clang_resource_include = root.path().join("clang-resource-include");
        config.musl_include = root.path().join("musl-include");
        config.musl_cc_path = root.path().join("musl-gcc");
        config.runtime_support_object = root.path().join("missing-runtime-support.o");

        fs::write(&config.clang_path, []).expect("clangの代替fileを作れます");
        fs::create_dir(&config.clang_resource_include)
            .expect("clang resource includeの代替directoryを作れます");
        fs::create_dir(&config.musl_include).expect("musl includeの代替directoryを作れます");
        fs::write(&config.musl_cc_path, []).expect("musl-gccの代替fileを作れます");

        let error = config
            .validate_preconditions()
            .expect_err("support objectの欠落を拒否します");

        assert!(matches!(
            error,
            ConfigError::MissingFile(path) if path == config.runtime_support_object
        ));
    }
}
