use std::{path::Path, time::Duration};

use executor_protocol::v1::{
    ExitReason, JobAssignment, JobPhase, WorkerMessage, job_event, worker_message,
};
use thiserror::Error;
use tokio::sync::mpsc;
use uuid::Uuid;

use crate::{
    config::{BackendKind, WorkerConfig},
    execution::{JobControl, execute_assignment},
};

/// 本番と同じNsJail backendで公開前の必須隔離条件を検証します。
pub async fn sandbox_smoke_test(config: WorkerConfig) -> Result<(), SmokeError> {
    if config.backend != BackendKind::NsJail {
        return Err(SmokeError::RequiresNsJail);
    }

    let normal = run_case(
        &config,
        "normal",
        r#"#include <stdio.h>
int main(void) {
    puts("SMART_C_OK");
    return 0;
}
"#,
        Duration::from_secs(15),
    )
    .await?;
    require_running("normal", &normal)?;
    require(
        normal.reason == ExitReason::Completed
            && normal.code == Some(0)
            && normal.output.contains("SMART_C_OK"),
        "normal",
        "通常のCプログラムを実行できません",
    )?;

    let toolchain_abi = run_case(
        &config,
        "toolchain-abi",
        r#"#include <ctype.h>
#include <setjmp.h>
#include <stdio.h>

static jmp_buf state;

int main(void) {
    if (setjmp(state) == 0) {
        longjmp(state, 1);
    }
    if (!isalpha('a')) {
        return 2;
    }
    puts("MUSL_ABI_OK");
    return 0;
}
"#,
        Duration::from_secs(15),
    )
    .await?;
    require_running("toolchain-abi", &toolchain_abi)?;
    require(
        toolchain_abi.reason == ExitReason::Completed
            && toolchain_abi.code == Some(0)
            && toolchain_abi.output.contains("MUSL_ABI_OK"),
        "toolchain-abi",
        "Clang compileとmusl linkのABIが一致しません",
    )?;

    let interactive_prompt = run_case_with_inputs(
        &config,
        "interactive-prompt",
        r#"#include <stdio.h>
int main(void) {
    int a;
    int b;
    printf("a: ");
    if (scanf("%d", &a) != 1) { return 2; }
    printf("b: ");
    if (scanf("%d", &b) != 1) { return 3; }
    printf("VALUES:%d,%d\n", a, b);
    return 0;
}
"#,
        Duration::from_secs(15),
        &[
            PromptInput {
                prompt: b"a: ",
                input: b"30\n",
            },
            PromptInput {
                prompt: b"b: ",
                input: b"1000\n",
            },
        ],
    )
    .await?;
    require_running("interactive-prompt", &interactive_prompt)?;
    require(
        interactive_prompt.reason == ExitReason::Completed
            && interactive_prompt.code == Some(0)
            && interactive_prompt.output.contains("a: ")
            && interactive_prompt.output.contains("b: ")
            && interactive_prompt.output.contains("VALUES:30,1000"),
        "interactive-prompt",
        "改行なしpromptを入力前に表示して値を読み取れません",
    )?;

    let host_marker = config.workspace_root.join("smart-c-host-marker");
    std::fs::write(&host_marker, b"HOST_ONLY_SECRET")?;
    let compile_source = format!(
        r#"#include <stdio.h>

#if __has_include("/proc/1/environ")
#error "PROC_VISIBLE"
#endif
#if __has_include("/etc/passwd")
#error "ETC_VISIBLE"
#endif
#if __has_include("{}")
#error "WORK_VISIBLE"
#endif

int main(void) {{
    puts("COMPILE_FS_OK");
    return 0;
}}
"#,
        host_marker.display()
    );
    let compile_filesystem_result = run_case(
        &config,
        "compile-filesystem",
        &compile_source,
        Duration::from_secs(15),
    )
    .await;
    std::fs::remove_file(&host_marker)?;
    let compile_filesystem = compile_filesystem_result?;
    require_running("compile-filesystem", &compile_filesystem)?;
    require(
        compile_filesystem.reason == ExitReason::Completed
            && compile_filesystem.code == Some(0)
            && compile_filesystem.output.contains("COMPILE_FS_OK")
            && !compile_filesystem
                .compiler_output
                .contains(&config.worker_token),
        "compile-filesystem",
        "compile jailからWorkerのroot/proc/workspaceまたはsecretが見えています",
    )?;

    for (name, source) in [
        (
            "network",
            r#"#include <stdio.h>
#include <sys/socket.h>
int main(void) {
    int fd = socket(AF_INET, SOCK_STREAM, 0);
    if (fd < 0) { puts("DENIED"); return 0; }
    puts("ESCAPED");
    return 99;
}
"#,
        ),
        (
            "fork",
            r#"#include <stdio.h>
#include <sys/types.h>
#include <unistd.h>
int main(void) {
    pid_t pid = fork();
    if (pid < 0) { puts("DENIED"); return 0; }
    puts("ESCAPED");
    return 99;
}
"#,
        ),
        (
            "ptrace",
            r#"#include <stdio.h>
#include <sys/ptrace.h>
int main(void) {
    long result = ptrace(PTRACE_TRACEME, 0, 0, 0);
    if (result < 0) { puts("DENIED"); return 0; }
    puts("ESCAPED");
    return 99;
}
"#,
        ),
        (
            "mount",
            r#"#include <stdio.h>
#include <sys/mount.h>
int main(void) {
    int result = mount("none", "/tmp", "tmpfs", 0, 0);
    if (result < 0) { puts("DENIED"); return 0; }
    puts("ESCAPED");
    return 99;
}
"#,
        ),
    ] {
        let result = run_case(&config, name, source, Duration::from_secs(15)).await?;
        require_forbidden_syscall_was_blocked(name, &result)?;
    }

    let host_file = run_case(
        &config,
        "host-file",
        r#"#include <stdio.h>
int main(void) {
    FILE *file = fopen("/etc/passwd", "r");
    if (file == NULL) { puts("DENIED"); return 0; }
    puts("LEAKED");
    fclose(file);
    return 99;
}
"#,
        Duration::from_secs(15),
    )
    .await?;
    require_running("host-file", &host_file)?;
    require(
        host_file.reason == ExitReason::Completed
            && host_file.output.contains("DENIED")
            && !host_file.output.contains("LEAKED")
            && host_file.code == Some(0),
        "host-file",
        "runtime jailからコンテナ側ファイルが見えています",
    )?;

    let cpu_limit = run_case(
        &config,
        "cpu-limit",
        "int main(void) { for (;;) {} }",
        Duration::from_secs(15),
    )
    .await?;
    require_running("cpu-limit", &cpu_limit)?;
    require(
        matches!(
            cpu_limit.reason,
            ExitReason::TimedOut | ExitReason::ResourceLimited
        ),
        "cpu-limit",
        "無限ループがCPU/wall time制限で停止しません",
    )?;

    let memory_limit = run_case(
        &config,
        "memory-limit",
        r#"#include <stdio.h>
#include <stdlib.h>
#include <string.h>
int main(void) {
    size_t total = 0;
    while (total < 256U * 1024U * 1024U) {
        void *block = malloc(1024U * 1024U);
        if (block == NULL) { puts("LIMITED"); return 0; }
        memset(block, 1, 1024U * 1024U);
        total += 1024U * 1024U;
    }
    puts("ALLOCATED");
    return 99;
}
"#,
        Duration::from_secs(15),
    )
    .await?;
    require_running("memory-limit", &memory_limit)?;
    require(
        !memory_limit.output.contains("ALLOCATED")
            && (memory_limit.reason == ExitReason::ResourceLimited
                || (memory_limit.reason == ExitReason::Completed
                    && memory_limit.code == Some(0)
                    && memory_limit.output.contains("LIMITED"))),
        "memory-limit",
        "128MiBを超えるメモリ確保が成功しました",
    )?;

    let output_limit = run_case(
        &config,
        "output-limit",
        r#"#include <stdio.h>
int main(void) {
    for (int i = 0; i < 2 * 1024 * 1024; ++i) {
        putchar('A');
    }
    return 0;
}
"#,
        Duration::from_secs(15),
    )
    .await?;
    require_running("output-limit", &output_limit)?;
    require(
        output_limit.reason == ExitReason::ResourceLimited,
        "output-limit",
        "1MiBの端末出力上限で停止しません",
    )?;

    println!("NsJail sandbox smoke test: PASS");
    Ok(())
}

struct SmokeResult {
    reason: ExitReason,
    code: Option<i32>,
    output: String,
    compiler_output: String,
    phases: Vec<JobPhase>,
}

/// promptを受信した後にPTYへ送信する入力です。
struct PromptInput {
    /// 入力送信を許可する端末出力です。
    prompt: &'static [u8],
    /// prompt受信後に送信するバイト列です。
    input: &'static [u8],
}

async fn run_case(
    config: &WorkerConfig,
    name: &'static str,
    source: &str,
    timeout: Duration,
) -> Result<SmokeResult, SmokeError> {
    run_case_with_inputs(config, name, source, timeout, &[]).await
}

/// 分割された端末出力を連結し、実行開始後のpromptに対応する入力を順番に送ります。
async fn run_case_with_inputs(
    config: &WorkerConfig,
    name: &'static str,
    source: &str,
    timeout: Duration,
    prompt_inputs: &[PromptInput],
) -> Result<SmokeResult, SmokeError> {
    let job_id = Uuid::new_v4();
    let assignment = JobAssignment {
        job_id: job_id.to_string(),
        source: source.as_bytes().to_vec(),
        terminal_cols: 80,
        terminal_rows: 24,
    };
    let (control_sender, control_receiver) = mpsc::channel::<JobControl>(4);
    let (outbound_sender, mut outbound_receiver) = mpsc::channel::<WorkerMessage>(512);
    let config_for_job = config.clone();
    let task = tokio::spawn(async move {
        execute_assignment(
            config_for_job,
            assignment,
            control_receiver,
            outbound_sender,
        )
        .await;
    });
    let deadline = tokio::time::Instant::now() + timeout;
    let mut output = Vec::new();
    let mut compiler_output = Vec::new();
    let mut phases = Vec::new();
    let mut internal_error = None;
    let mut next_input = 0_usize;
    let outcome: Result<(ExitReason, Option<i32>), SmokeError> = async {
        loop {
            let message = tokio::select! {
                message = outbound_receiver.recv() => {
                    message.ok_or(SmokeError::MissingExit(name))?
                }
                _ = tokio::time::sleep_until(deadline) => {
                    return Err(SmokeError::TimedOut(name));
                }
            };
            let Some(worker_message::Payload::Event(event)) = message.payload else {
                continue;
            };
            match event.payload {
                Some(job_event::Payload::Phase(phase)) => {
                    phases.push(
                        JobPhase::try_from(phase.phase)
                            .map_err(|_| SmokeError::InvalidPhase(name))?,
                    );
                }
                Some(job_event::Payload::CompilerOutput(data)) => {
                    compiler_output.extend_from_slice(&data.data);
                }
                Some(job_event::Payload::TerminalOutput(data)) => {
                    output.extend_from_slice(&data);
                }
                Some(job_event::Payload::Error(error)) => {
                    internal_error = Some(error.message);
                }
                Some(job_event::Payload::Exit(exit)) => {
                    let reason = ExitReason::try_from(exit.reason)
                        .map_err(|_| SmokeError::InvalidExit(name))?;
                    return Ok((reason, exit.code));
                }
                _ => {}
            }

            // compile中の偶然の一致では入力せず、runtime開始後の端末出力だけを対象にします。
            if phases.contains(&JobPhase::Running) {
                while let Some(prompt_input) = prompt_inputs.get(next_input) {
                    let saw_prompt = output
                        .windows(prompt_input.prompt.len())
                        .any(|window| window == prompt_input.prompt);
                    if !saw_prompt {
                        break;
                    }
                    control_sender
                        .send(JobControl::Input(prompt_input.input.to_vec()))
                        .await
                        .map_err(|_| SmokeError::InputDisconnected(name))?;
                    next_input += 1;
                }
            }
        }
    }
    .await;

    if outcome.is_err() {
        let _ = control_sender.try_send(JobControl::Cancel);
    }
    await_task_and_workspace_cleanup(&config.workspace_root, job_id, name, task).await?;
    let (reason, code) = outcome?;
    if let Some(message) = internal_error {
        return Err(SmokeError::Internal { name, message });
    }
    if next_input != prompt_inputs.len() {
        return Err(SmokeError::MissingPrompt(name));
    }
    Ok(SmokeResult {
        reason,
        code,
        output: String::from_utf8_lossy(&output).into_owned(),
        compiler_output: String::from_utf8_lossy(&compiler_output).into_owned(),
        phases,
    })
}

/// 実行タスクの終了とジョブworkspaceの削除を共通期限内で確認します。
async fn await_task_and_workspace_cleanup(
    root: &Path,
    job_id: Uuid,
    name: &'static str,
    task: tokio::task::JoinHandle<()>,
) -> Result<(), SmokeError> {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(2);
    let mut task = task;
    let task_result = match tokio::time::timeout_at(deadline, &mut task).await {
        Ok(result) => result,
        Err(_) => {
            task.abort();
            let _ = task.await;
            return Err(SmokeError::CleanupTimedOut(name));
        }
    };

    while workspace_exists(root, job_id)? {
        if tokio::time::Instant::now() >= deadline {
            return Err(SmokeError::CleanupTimedOut(name));
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    task_result.map_err(|_| SmokeError::TaskPanicked(name))
}

fn require_forbidden_syscall_was_blocked(
    name: &'static str,
    result: &SmokeResult,
) -> Result<(), SmokeError> {
    require_running(name, result)?;
    let blocked = !result.output.contains("ESCAPED")
        && (result.reason == ExitReason::SandboxViolation
            || (result.reason == ExitReason::Completed
                && result.code == Some(0)
                && result.output.contains("DENIED")));
    require(blocked, name, "禁止syscallが成功しました")
}

fn require_running(name: &'static str, result: &SmokeResult) -> Result<(), SmokeError> {
    if result.phases.contains(&JobPhase::Running) {
        Ok(())
    } else {
        Err(SmokeError::RuntimeNotStarted {
            name,
            compiler_output: result.compiler_output.clone(),
        })
    }
}

fn require(condition: bool, name: &'static str, detail: &'static str) -> Result<(), SmokeError> {
    if condition {
        Ok(())
    } else {
        Err(SmokeError::Assertion { name, detail })
    }
}

/// 指定ジョブのworkspaceが残っているかを確認します。
fn workspace_exists(root: &Path, job_id: Uuid) -> Result<bool, std::io::Error> {
    let job_id = job_id.to_string();
    for entry in std::fs::read_dir(root)? {
        let entry = entry?;
        if entry.file_name().to_string_lossy().contains(&job_id) {
            return Ok(true);
        }
    }
    Ok(false)
}

/// sandbox smoke testが失敗した理由です。
#[derive(Debug, Error)]
pub enum SmokeError {
    /// NsJail以外のbackendが選ばれています。
    #[error("sandbox-smoke-testにはEXECUTOR_BACKEND=nsjailが必要です")]
    RequiresNsJail,
    /// 個別ケースが時間内に完了しません。
    #[error("{0}: smoke testが時間切れになりました")]
    TimedOut(&'static str),
    /// 終了イベントがありません。
    #[error("{0}: Workerが終了イベントを送信しませんでした")]
    MissingExit(&'static str),
    /// 必要なpromptを受信する前に実行が終了しました。
    #[error("{0}: 必要なpromptをすべて受信できませんでした")]
    MissingPrompt(&'static str),
    /// promptに対応する入力を実行中ジョブへ送信できません。
    #[error("{0}: 実行中ジョブへstdinを送信できませんでした")]
    InputDisconnected(&'static str),
    /// 終了理由が契約外です。
    #[error("{0}: 終了理由が不正です")]
    InvalidExit(&'static str),
    /// 実行フェーズが契約外です。
    #[error("{0}: 実行フェーズが不正です")]
    InvalidPhase(&'static str),
    /// 実行タスクがpanicしました。
    #[error("{0}: 実行タスクがpanicしました")]
    TaskPanicked(&'static str),
    /// cleanupが時間内に完了しません。
    #[error("{0}: cleanupが時間内に完了しません")]
    CleanupTimedOut(&'static str),
    /// Worker内部エラーです。
    #[error("{name}: Worker内部エラー: {message}")]
    Internal {
        /// ケース名です。
        name: &'static str,
        /// エラー内容です。
        message: String,
    },
    /// コンパイルまたはsandbox準備に失敗し、runtimeへ到達しませんでした。
    #[error("{name}: runtimeへ到達しませんでした。compiler output: {compiler_output}")]
    RuntimeNotStarted {
        /// ケース名です。
        name: &'static str,
        /// 失敗理由を含むコンパイラ出力です。
        compiler_output: String,
    },
    /// セキュリティ条件を満たしません。
    #[error("{name}: {detail}")]
    Assertion {
        /// ケース名です。
        name: &'static str,
        /// 失敗内容です。
        detail: &'static str,
    },
    /// workspace確認に失敗しました。
    #[error("workspaceを確認できません: {0}")]
    Io(#[from] std::io::Error),
}
