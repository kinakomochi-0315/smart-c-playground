use std::{
    collections::HashSet,
    io::{Read, Write},
    path::Path,
    process::Stdio,
    time::{Duration, Instant},
};

use executor_protocol::{
    SOURCE_FILE_MAX_COUNT, SOURCE_FILES_MAX_BYTES, is_valid_source_file_name,
    v1::{
        CompilerOutput, ErrorEvent, ExitEvent, ExitReason, JobAssignment, JobEvent, JobPhase,
        OutputStream, PhaseEvent, SourceFile, WorkerMessage, job_event, worker_message,
    },
};
use portable_pty::{
    Child as PtyChild, CommandBuilder, ExitStatus as PtyExitStatus, PtySize, native_pty_system,
};
use tempfile::{Builder as TempBuilder, TempDir};
use thiserror::Error;
use tokio::{
    io::{AsyncRead, AsyncReadExt},
    process::{Child, Command},
    sync::mpsc,
};
use tracing::warn;
use uuid::Uuid;

use crate::{
    backend::{CommandFactory, CommandSpec},
    config::WorkerConfig,
};

/// APIから実行中ジョブへ届く操作です。
#[derive(Debug)]
pub(crate) enum JobControl {
    /// PTYの標準入力へ書き込みます。
    Input(Vec<u8>),
    /// PTYサイズを変更します。
    Resize {
        /// 桁数です。
        cols: u16,
        /// 行数です。
        rows: u16,
    },
    /// 利用者起因の入力過多としてプロセスを停止します。
    ResourceLimit,
    /// プロセスを停止します。
    Cancel,
}

/// 1件の割当をコンパイルし、成功時はPTY上で実行します。
pub(crate) async fn execute_assignment(
    config: WorkerConfig,
    assignment: JobAssignment,
    mut controls: mpsc::Receiver<JobControl>,
    outbound: mpsc::Sender<WorkerMessage>,
) {
    let worker_id = config.worker_id.clone();
    let job_id = assignment.job_id.clone();
    if let Err(error) = execute_inner(&config, assignment, &mut controls, &outbound).await {
        warn!(%job_id, %error, "実行ジョブが内部エラーで終了しました");
        let _ = send_payload(
            &outbound,
            &worker_id,
            &job_id,
            job_event::Payload::Error(ErrorEvent {
                code: error.code().to_owned(),
                message: error.to_string(),
                retryable: error.retryable(),
            }),
        )
        .await;
        let _ = send_exit(
            &outbound,
            &worker_id,
            &job_id,
            None,
            None,
            ExitReason::InternalError,
        )
        .await;
    }
}

async fn execute_inner(
    config: &WorkerConfig,
    assignment: JobAssignment,
    controls: &mut mpsc::Receiver<JobControl>,
    outbound: &mpsc::Sender<WorkerMessage>,
) -> Result<(), ExecutionError> {
    let job_id = Uuid::parse_str(&assignment.job_id)
        .map_err(|_| ExecutionError::InvalidAssignment("job_idがUUIDではありません"))?;
    validate_source_files(&assignment.files)?;
    let mut dimensions = Dimensions::try_from_assignment(&assignment)?;
    let workspace = JobWorkspace::new(&config.workspace_root, job_id)?;
    for file in &assignment.files {
        tokio::fs::write(workspace.path().join(&file.name), &file.content).await?;
    }
    let source_files = assignment
        .files
        .iter()
        .filter(|file| file.name.ends_with(".c"))
        .map(|file| file.name.clone())
        .collect::<Vec<_>>();
    let factory = CommandFactory::new(config.clone());

    send_phase(
        outbound,
        &config.worker_id,
        &assignment.job_id,
        JobPhase::Compiling,
    )
    .await?;
    let compile_started = Instant::now();
    for command in [
        factory.compile(workspace.path(), &source_files),
        factory.link(workspace.path(), &source_files),
    ] {
        let remaining = config
            .compile_timeout
            .checked_sub(compile_started.elapsed())
            .unwrap_or(Duration::ZERO);
        if remaining.is_zero() {
            finish_compile_limit(
                outbound,
                &config.worker_id,
                &assignment.job_id,
                ExitReason::TimedOut,
            )
            .await?;
            return Ok(());
        }
        match run_compile_process(
            command,
            remaining,
            config.compile_output_limit,
            controls,
            &mut dimensions,
            outbound,
            &config.worker_id,
            &assignment.job_id,
        )
        .await?
        {
            CompileOutcome::Exited(Some(0)) => {}
            CompileOutcome::Exited(code) => {
                send_phase(
                    outbound,
                    &config.worker_id,
                    &assignment.job_id,
                    JobPhase::CompileFailed,
                )
                .await?;
                send_exit(
                    outbound,
                    &config.worker_id,
                    &assignment.job_id,
                    code,
                    None,
                    ExitReason::CompileFailed,
                )
                .await?;
                return Ok(());
            }
            CompileOutcome::TimedOut => {
                finish_compile_limit(
                    outbound,
                    &config.worker_id,
                    &assignment.job_id,
                    ExitReason::TimedOut,
                )
                .await?;
                return Ok(());
            }
            CompileOutcome::OutputLimited | CompileOutcome::ResourceLimited => {
                finish_compile_limit(
                    outbound,
                    &config.worker_id,
                    &assignment.job_id,
                    ExitReason::ResourceLimited,
                )
                .await?;
                return Ok(());
            }
            CompileOutcome::Cancelled => {
                send_phase(
                    outbound,
                    &config.worker_id,
                    &assignment.job_id,
                    JobPhase::Cancelled,
                )
                .await?;
                send_exit(
                    outbound,
                    &config.worker_id,
                    &assignment.job_id,
                    None,
                    None,
                    ExitReason::Cancelled,
                )
                .await?;
                return Ok(());
            }
        }
    }

    send_phase(
        outbound,
        &config.worker_id,
        &assignment.job_id,
        JobPhase::Running,
    )
    .await?;
    let runtime = run_pty_process(
        factory.runtime(workspace.path()),
        dimensions,
        config.runtime_timeout,
        config.runtime_output_limit,
        controls,
        outbound,
        &config.worker_id,
        &assignment.job_id,
    )
    .await?;
    let (phase, reason) = match runtime.reason {
        RuntimeReason::Completed => (JobPhase::Exited, ExitReason::Completed),
        RuntimeReason::TimedOut => (JobPhase::TimedOut, ExitReason::TimedOut),
        RuntimeReason::ResourceLimited => (JobPhase::ResourceLimited, ExitReason::ResourceLimited),
        RuntimeReason::Cancelled => (JobPhase::Cancelled, ExitReason::Cancelled),
        RuntimeReason::SandboxViolation => {
            (JobPhase::SandboxViolation, ExitReason::SandboxViolation)
        }
    };
    send_phase(outbound, &config.worker_id, &assignment.job_id, phase).await?;
    send_exit(
        outbound,
        &config.worker_id,
        &assignment.job_id,
        runtime.code,
        runtime.signal,
        reason,
    )
    .await?;
    Ok(())
}

/// Worker境界でファイル構造・名前・合計サイズを再検証します。
fn validate_source_files(files: &[SourceFile]) -> Result<(), ExecutionError> {
    if files.is_empty() || files.len() > SOURCE_FILE_MAX_COUNT {
        return Err(ExecutionError::InvalidAssignment(
            "filesは1〜16件にしてください",
        ));
    }

    let mut names = HashSet::new();
    let mut total_bytes = 0_usize;
    let mut has_main = false;
    for file in files {
        if !is_valid_source_file_name(&file.name) {
            return Err(ExecutionError::InvalidAssignment(
                "安全な.cまたは.hのファイル名を指定してください",
            ));
        }
        if !names.insert(file.name.to_ascii_lowercase()) {
            return Err(ExecutionError::InvalidAssignment(
                "同じファイル名を複数指定できません",
            ));
        }
        if file.content.contains(&0) {
            return Err(ExecutionError::InvalidAssignment(
                "ファイル内容にNUL文字は使用できません",
            ));
        }
        has_main |= file.name == "main.c";
        total_bytes = total_bytes.saturating_add(file.content.len());
    }
    if !has_main {
        return Err(ExecutionError::InvalidAssignment("main.cは必須です"));
    }
    if total_bytes == 0 || total_bytes > SOURCE_FILES_MAX_BYTES {
        return Err(ExecutionError::InvalidAssignment(
            "全ファイルの合計は1〜65536バイトにしてください",
        ));
    }
    Ok(())
}

async fn finish_compile_limit(
    outbound: &mpsc::Sender<WorkerMessage>,
    worker_id: &str,
    job_id: &str,
    reason: ExitReason,
) -> Result<(), ExecutionError> {
    let phase = match reason {
        ExitReason::TimedOut => JobPhase::TimedOut,
        ExitReason::ResourceLimited => JobPhase::ResourceLimited,
        _ => JobPhase::CompileFailed,
    };
    send_phase(outbound, worker_id, job_id, phase).await?;
    send_exit(outbound, worker_id, job_id, None, None, reason).await
}

#[derive(Clone, Copy)]
struct Dimensions {
    cols: u16,
    rows: u16,
}

impl Dimensions {
    fn try_from_assignment(assignment: &JobAssignment) -> Result<Self, ExecutionError> {
        let cols = u16::try_from(assignment.terminal_cols)
            .map_err(|_| ExecutionError::InvalidAssignment("terminal colsが不正です"))?;
        let rows = u16::try_from(assignment.terminal_rows)
            .map_err(|_| ExecutionError::InvalidAssignment("terminal rowsが不正です"))?;
        if !(20..=240).contains(&cols) || !(5..=80).contains(&rows) {
            return Err(ExecutionError::InvalidAssignment(
                "端末サイズが許可範囲外です",
            ));
        }
        Ok(Self { cols, rows })
    }
}

struct JobWorkspace {
    directory: TempDir,
}

impl JobWorkspace {
    fn new(root: &Path, job_id: Uuid) -> Result<Self, ExecutionError> {
        let directory = TempBuilder::new()
            .prefix(&format!("job-{job_id}-"))
            .tempdir_in(root)?;
        Ok(Self { directory })
    }

    fn path(&self) -> &Path {
        self.directory.path()
    }
}

enum CompileOutcome {
    Exited(Option<i32>),
    TimedOut,
    OutputLimited,
    ResourceLimited,
    Cancelled,
}

enum PipeEvent {
    Data(OutputStream, Vec<u8>),
    Closed,
}

#[allow(clippy::too_many_arguments)]
async fn run_compile_process(
    spec: CommandSpec,
    timeout: Duration,
    output_limit: usize,
    controls: &mut mpsc::Receiver<JobControl>,
    dimensions: &mut Dimensions,
    outbound: &mpsc::Sender<WorkerMessage>,
    worker_id: &str,
    job_id: &str,
) -> Result<CompileOutcome, ExecutionError> {
    let mut command = Command::new(&spec.program);
    command
        .args(&spec.args)
        .current_dir(&spec.cwd)
        .env_clear()
        .envs(spec.environment)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    let mut child = command.spawn().map_err(|source| ExecutionError::Spawn {
        program: spec.program,
        source,
    })?;
    let stdout = child
        .stdout
        .take()
        .ok_or(ExecutionError::MissingPipe("stdout"))?;
    let stderr = child
        .stderr
        .take()
        .ok_or(ExecutionError::MissingPipe("stderr"))?;
    let (pipe_sender, mut pipe_receiver) = mpsc::channel(64);
    tokio::spawn(read_pipe(stdout, OutputStream::Stdout, pipe_sender.clone()));
    tokio::spawn(read_pipe(stderr, OutputStream::Stderr, pipe_sender));

    let deadline = tokio::time::Instant::now() + timeout;
    let mut ticker = tokio::time::interval(Duration::from_millis(20));
    let mut bytes_sent = 0_usize;
    let mut pipes_closed = 0_u8;
    let mut exit_code: Option<Option<i32>> = None;
    let mut drain_deadline = None;

    loop {
        tokio::select! {
            _ = tokio::time::sleep_until(deadline), if exit_code.is_none() => {
                kill_and_reap(&mut child).await;
                return Ok(CompileOutcome::TimedOut);
            }
            _ = async {
                if let Some(deadline) = drain_deadline {
                    tokio::time::sleep_until(deadline).await;
                }
            }, if drain_deadline.is_some() => {
                return Ok(CompileOutcome::Exited(exit_code.flatten()));
            }
            control = controls.recv(), if exit_code.is_none() => {
                match control {
                    Some(JobControl::Cancel) | None => {
                        kill_and_reap(&mut child).await;
                        return Ok(CompileOutcome::Cancelled);
                    }
                    Some(JobControl::ResourceLimit) => {
                        kill_and_reap(&mut child).await;
                        return Ok(CompileOutcome::ResourceLimited);
                    }
                    Some(JobControl::Resize { cols, rows }) => {
                        dimensions.cols = cols;
                        dimensions.rows = rows;
                    }
                    Some(JobControl::Input(_)) => {
                        // コンパイル中の入力はAPI側でも拒否します。
                    }
                }
            }
            event = pipe_receiver.recv() => {
                match event {
                    Some(PipeEvent::Data(stream, data)) => {
                        bytes_sent = bytes_sent.saturating_add(data.len());
                        if bytes_sent > output_limit {
                            kill_and_reap(&mut child).await;
                            return Ok(CompileOutcome::OutputLimited);
                        }
                        send_payload(
                            outbound,
                            worker_id,
                            job_id,
                            job_event::Payload::CompilerOutput(CompilerOutput {
                                stream: stream as i32,
                                data,
                            }),
                        ).await?;
                    }
                    Some(PipeEvent::Closed) => {
                        pipes_closed = pipes_closed.saturating_add(1);
                        if pipes_closed >= 2 && exit_code.is_some() {
                            return Ok(CompileOutcome::Exited(exit_code.flatten()));
                        }
                    }
                    None if exit_code.is_some() => {
                        return Ok(CompileOutcome::Exited(exit_code.flatten()));
                    }
                    None => {}
                }
            }
            _ = ticker.tick(), if exit_code.is_none() => {
                if let Some(status) = child.try_wait()? {
                    exit_code = Some(status.code());
                    drain_deadline = Some(
                        tokio::time::Instant::now() + Duration::from_millis(200)
                    );
                    if pipes_closed >= 2 {
                        return Ok(CompileOutcome::Exited(exit_code.flatten()));
                    }
                }
            }
        }
    }
}

async fn read_pipe<R>(mut reader: R, stream: OutputStream, sender: mpsc::Sender<PipeEvent>)
where
    R: AsyncRead + Unpin,
{
    let mut buffer = vec![0_u8; 4096];
    loop {
        match reader.read(&mut buffer).await {
            Ok(0) => break,
            Ok(length) => {
                if sender
                    .send(PipeEvent::Data(stream, buffer[..length].to_vec()))
                    .await
                    .is_err()
                {
                    return;
                }
            }
            Err(_) => break,
        }
    }
    let _ = sender.send(PipeEvent::Closed).await;
}

async fn kill_and_reap(child: &mut Child) {
    let _ = child.kill().await;
    let _ = child.wait().await;
}

struct RuntimeOutcome {
    code: Option<i32>,
    signal: Option<i32>,
    reason: RuntimeReason,
}

#[derive(Debug)]
enum RuntimeReason {
    Completed,
    TimedOut,
    ResourceLimited,
    Cancelled,
    SandboxViolation,
}

enum PtyReadEvent {
    Data(Vec<u8>),
    Closed,
    Failed(String),
}

enum PtyWriteEvent {
    Failed(String),
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
struct ProcessExit {
    code: Option<i32>,
    signal: Option<i32>,
}

/// PTY childが正常経路以外で破棄されても必ず停止・回収するガードです。
struct PtyChildGuard {
    child: Option<Box<dyn PtyChild + Send + Sync>>,
}

impl PtyChildGuard {
    /// 起動済みPTY childをガード対象にします。
    fn new(child: Box<dyn PtyChild + Send + Sync>) -> Self {
        Self { child: Some(child) }
    }

    /// 非同期ループを止めずに終了状態を確認します。
    fn try_wait(&mut self) -> std::io::Result<Option<PtyExitStatus>> {
        let status = self
            .child
            .as_mut()
            .expect("回収前のchildだけをpollします")
            .try_wait()?;
        if status.is_some() {
            self.child.take();
        }
        Ok(status)
    }

    /// 実行中ならkillし、終了状態を回収します。
    fn terminate_and_reap(&mut self) {
        let Some(mut child) = self.child.take() else {
            return;
        };
        let _ = child.kill();
        let _ = child.wait();
    }
}

impl Drop for PtyChildGuard {
    fn drop(&mut self) {
        self.terminate_and_reap();
    }
}

#[allow(clippy::too_many_arguments)]
async fn run_pty_process(
    spec: CommandSpec,
    dimensions: Dimensions,
    timeout: Duration,
    output_limit: usize,
    controls: &mut mpsc::Receiver<JobControl>,
    outbound: &mpsc::Sender<WorkerMessage>,
    worker_id: &str,
    job_id: &str,
) -> Result<RuntimeOutcome, ExecutionError> {
    let pair = native_pty_system()
        .openpty(PtySize {
            rows: dimensions.rows,
            cols: dimensions.cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|error| ExecutionError::Pty(error.to_string()))?;
    let mut command = CommandBuilder::new(&spec.program);
    command.args(&spec.args);
    command.cwd(&spec.cwd);
    command.env_clear();
    for (name, value) in spec.environment {
        command.env(name, value);
    }
    let child = pair
        .slave
        .spawn_command(command)
        .map_err(|error| ExecutionError::Pty(error.to_string()))?;
    let mut child = PtyChildGuard::new(child);
    drop(pair.slave);
    let mut reader = pair
        .master
        .try_clone_reader()
        .map_err(|error| ExecutionError::Pty(error.to_string()))?;
    let mut writer = pair
        .master
        .take_writer()
        .map_err(|error| ExecutionError::Pty(error.to_string()))?;
    let (writer_sender, mut writer_receiver) = mpsc::channel::<Vec<u8>>(8);
    let (writer_event_sender, mut writer_event_receiver) = mpsc::channel(1);
    std::thread::Builder::new()
        .name(format!("pty-writer-{job_id}"))
        .spawn(move || {
            while let Some(data) = writer_receiver.blocking_recv() {
                if let Err(error) = writer.write_all(&data).and_then(|_| writer.flush()) {
                    let _ =
                        writer_event_sender.blocking_send(PtyWriteEvent::Failed(error.to_string()));
                    return;
                }
            }
        })
        .map_err(ExecutionError::Thread)?;
    let master = pair.master;
    let (reader_sender, mut reader_receiver) = mpsc::channel(64);
    std::thread::Builder::new()
        .name(format!("pty-{job_id}"))
        .spawn(move || {
            let mut buffer = vec![0_u8; 4096];
            loop {
                match reader.read(&mut buffer) {
                    Ok(0) => break,
                    Ok(length) => {
                        if reader_sender
                            .blocking_send(PtyReadEvent::Data(buffer[..length].to_vec()))
                            .is_err()
                        {
                            return;
                        }
                    }
                    Err(error) => {
                        let _ =
                            reader_sender.blocking_send(PtyReadEvent::Failed(error.to_string()));
                        return;
                    }
                }
            }
            let _ = reader_sender.blocking_send(PtyReadEvent::Closed);
        })
        .map_err(ExecutionError::Thread)?;

    let deadline = tokio::time::Instant::now() + timeout;
    let mut ticker = tokio::time::interval(Duration::from_millis(20));
    let mut bytes_sent = 0_usize;
    let mut process_exit: Option<ProcessExit> = None;
    let mut drain_deadline = None;

    loop {
        tokio::select! {
            _ = tokio::time::sleep_until(deadline), if process_exit.is_none() => {
                child.terminate_and_reap();
                return Ok(RuntimeOutcome {
                    code: None,
                    signal: None,
                    reason: RuntimeReason::TimedOut,
                });
            }
            _ = async {
                if let Some(deadline) = drain_deadline {
                    tokio::time::sleep_until(deadline).await;
                }
            }, if drain_deadline.is_some() => {
                return Ok(classify_runtime_exit(
                    process_exit.expect("終了後だけdrainします")
                ));
            }
            control = controls.recv(), if process_exit.is_none() => {
                match control {
                    Some(JobControl::Input(data)) => {
                        match writer_sender.try_send(data) {
                            Ok(()) => {}
                            Err(mpsc::error::TrySendError::Full(_)) => {
                                child.terminate_and_reap();
                                return Ok(RuntimeOutcome {
                                    code: None,
                                    signal: None,
                                    reason: RuntimeReason::ResourceLimited,
                                });
                            }
                            Err(mpsc::error::TrySendError::Closed(_)) => {
                                child.terminate_and_reap();
                                return Err(ExecutionError::Pty(
                                    "PTY stdin writerが終了しました".to_owned()
                                ));
                            }
                        }
                    }
                    Some(JobControl::Resize { cols, rows }) => {
                        master
                            .resize(PtySize {
                                rows,
                                cols,
                                pixel_width: 0,
                                pixel_height: 0,
                            })
                            .map_err(|error| ExecutionError::Pty(error.to_string()))?;
                    }
                    Some(JobControl::Cancel) | None => {
                        child.terminate_and_reap();
                        return Ok(RuntimeOutcome {
                            code: None,
                            signal: None,
                            reason: RuntimeReason::Cancelled,
                        });
                    }
                    Some(JobControl::ResourceLimit) => {
                        child.terminate_and_reap();
                        return Ok(RuntimeOutcome {
                            code: None,
                            signal: None,
                            reason: RuntimeReason::ResourceLimited,
                        });
                    }
                }
            }
            event = reader_receiver.recv() => {
                match event {
                    Some(PtyReadEvent::Data(data)) => {
                        bytes_sent = bytes_sent.saturating_add(data.len());
                        if bytes_sent > output_limit {
                            child.terminate_and_reap();
                            return Ok(RuntimeOutcome {
                                code: None,
                                signal: None,
                                reason: RuntimeReason::ResourceLimited,
                            });
                        }
                        send_payload(
                            outbound,
                            worker_id,
                            job_id,
                            job_event::Payload::TerminalOutput(data),
                        ).await?;
                    }
                    Some(PtyReadEvent::Closed) | None if process_exit.is_some() => {
                        return Ok(classify_runtime_exit(
                            process_exit.expect("終了済み状態があります")
                        ));
                    }
                    Some(PtyReadEvent::Failed(error)) if process_exit.is_none() => {
                        child.terminate_and_reap();
                        return Err(ExecutionError::Pty(error));
                    }
                    Some(PtyReadEvent::Failed(_)) | Some(PtyReadEvent::Closed) | None => {}
                }
            }
            writer_event = writer_event_receiver.recv(), if process_exit.is_none() => {
                match writer_event {
                    Some(PtyWriteEvent::Failed(error)) => {
                        if let Some(status) = child
                            .try_wait()
                            .map_err(|wait_error| ExecutionError::Pty(wait_error.to_string()))?
                        {
                            return Ok(classify_runtime_exit(process_exit_status(&status)));
                        }
                        child.terminate_and_reap();
                        return Err(ExecutionError::Pty(error));
                    }
                    None => {
                        child.terminate_and_reap();
                        return Err(ExecutionError::Pty(
                            "PTY stdin writer threadが終了しました".to_owned()
                        ));
                    }
                }
            }
            _ = ticker.tick(), if process_exit.is_none() => {
                if let Some(status) = child
                    .try_wait()
                    .map_err(|error| ExecutionError::Pty(error.to_string()))?
                {
                    process_exit = Some(process_exit_status(&status));
                    drain_deadline = Some(
                        tokio::time::Instant::now() + Duration::from_millis(200)
                    );
                }
            }
        }
    }
}

fn process_exit_status(status: &PtyExitStatus) -> ProcessExit {
    if let Some(signal) = status.signal() {
        ProcessExit {
            code: None,
            signal: signal_number(signal),
        }
    } else {
        ProcessExit {
            code: Some(i32::try_from(status.exit_code()).unwrap_or(i32::MAX)),
            signal: None,
        }
    }
}

fn signal_number(name: &str) -> Option<i32> {
    match name {
        "Hangup" | "SIGHUP" => Some(1),
        "Interrupt" | "SIGINT" => Some(2),
        "Quit" | "SIGQUIT" => Some(3),
        "Illegal instruction" | "SIGILL" => Some(4),
        "Aborted" | "SIGABRT" => Some(6),
        "Bus error" | "SIGBUS" => Some(7),
        "Floating point exception" | "SIGFPE" => Some(8),
        "Killed" | "SIGKILL" => Some(9),
        "Segmentation fault" | "SIGSEGV" => Some(11),
        "Broken pipe" | "SIGPIPE" => Some(13),
        "Terminated" | "SIGTERM" => Some(15),
        "CPU time limit exceeded" | "SIGXCPU" => Some(24),
        "File size limit exceeded" | "SIGXFSZ" => Some(25),
        "Bad system call" | "SIGSYS" => Some(31),
        _ => name
            .strip_prefix("Signal ")
            .and_then(|number| number.parse().ok()),
    }
}

fn classify_runtime_exit(exit: ProcessExit) -> RuntimeOutcome {
    let reason = match (exit.code, exit.signal) {
        // Linuxの128+SIGSYSはseccomp違反、SIGKILL/SIGXCPU/SIGXFSZは資源制限として扱います。
        (Some(159), _) | (_, Some(31)) => RuntimeReason::SandboxViolation,
        (Some(137 | 152 | 153), _) | (_, Some(9 | 24 | 25)) => RuntimeReason::ResourceLimited,
        _ => RuntimeReason::Completed,
    };
    RuntimeOutcome {
        code: exit.code,
        signal: exit.signal,
        reason,
    }
}

async fn send_phase(
    outbound: &mpsc::Sender<WorkerMessage>,
    worker_id: &str,
    job_id: &str,
    phase: JobPhase,
) -> Result<(), ExecutionError> {
    send_payload(
        outbound,
        worker_id,
        job_id,
        job_event::Payload::Phase(PhaseEvent {
            phase: phase as i32,
        }),
    )
    .await
}

async fn send_exit(
    outbound: &mpsc::Sender<WorkerMessage>,
    worker_id: &str,
    job_id: &str,
    code: Option<i32>,
    signal: Option<i32>,
    reason: ExitReason,
) -> Result<(), ExecutionError> {
    send_payload(
        outbound,
        worker_id,
        job_id,
        job_event::Payload::Exit(ExitEvent {
            code,
            signal,
            reason: reason as i32,
        }),
    )
    .await
}

async fn send_payload(
    outbound: &mpsc::Sender<WorkerMessage>,
    worker_id: &str,
    job_id: &str,
    payload: job_event::Payload,
) -> Result<(), ExecutionError> {
    let message = WorkerMessage {
        payload: Some(worker_message::Payload::Event(JobEvent {
            worker_id: worker_id.to_owned(),
            job_id: job_id.to_owned(),
            payload: Some(payload),
        })),
    };
    match tokio::time::timeout(Duration::from_millis(250), outbound.send(message)).await {
        Ok(Ok(())) => Ok(()),
        Ok(Err(_)) => Err(ExecutionError::ApiDisconnected),
        Err(_) => Err(ExecutionError::ApiBackpressure),
    }
}

/// 実行処理を継続できない理由です。
#[derive(Debug, Error)]
pub(crate) enum ExecutionError {
    /// APIからの割当内容が不正です。
    #[error("実行割当が不正です: {0}")]
    InvalidAssignment(&'static str),
    /// ファイル操作に失敗しました。
    #[error("workspace操作に失敗しました: {0}")]
    Io(#[from] std::io::Error),
    /// プロセスを起動できません。
    #[error("{program} を起動できません: {source}")]
    Spawn {
        /// 実行ファイルです。
        program: String,
        /// OSエラーです。
        source: std::io::Error,
    },
    /// 子プロセスのpipeがありません。
    #[error("子プロセスの{0} pipeがありません")]
    MissingPipe(&'static str),
    /// PTY操作に失敗しました。
    #[error("PTY操作に失敗しました: {0}")]
    Pty(String),
    /// PTY reader threadを作れません。
    #[error("PTY reader threadを作れません: {0}")]
    Thread(std::io::Error),
    /// APIとのstreamが切断されました。
    #[error("executor-apiとの接続が切断されました")]
    ApiDisconnected,
    /// API送信channelのbackpressureが解消しません。
    #[error("executor-apiへの送信が250ms以内に完了しません")]
    ApiBackpressure,
}

impl ExecutionError {
    fn code(&self) -> &'static str {
        match self {
            Self::InvalidAssignment(_) => "invalid_assignment",
            Self::Io(_) => "workspace_io_failed",
            Self::Spawn { .. } => "process_spawn_failed",
            Self::MissingPipe(_) => "process_pipe_missing",
            Self::Pty(_) => "pty_failed",
            Self::Thread(_) => "pty_thread_failed",
            Self::ApiDisconnected => "api_disconnected",
            Self::ApiBackpressure => "api_backpressure",
        }
    }

    fn retryable(&self) -> bool {
        !matches!(self, Self::InvalidAssignment(_))
    }
}

#[cfg(test)]
mod tests {
    use std::fs;

    use tempfile::tempdir;

    use super::*;

    #[test]
    fn assignment_file_validation_accepts_flat_multi_file_project() {
        let files = vec![
            SourceFile {
                name: "main.c".to_owned(),
                content: b"int main(void) { return answer(); }".to_vec(),
            },
            SourceFile {
                name: "answer.h".to_owned(),
                content: b"int answer(void);".to_vec(),
            },
            SourceFile {
                name: "answer.c".to_owned(),
                content: b"int answer(void) { return 0; }".to_vec(),
            },
        ];

        assert!(validate_source_files(&files).is_ok());
    }

    #[test]
    fn workspace_is_removed_when_guard_is_dropped() {
        let root = tempdir().expect("root tempdirを作れます");
        let path = {
            let workspace =
                JobWorkspace::new(root.path(), Uuid::new_v4()).expect("workspaceを作れます");
            let path = workspace.path().to_path_buf();
            fs::write(path.join("main.c"), "int main(void){}").expect("fileを書けます");
            assert!(path.exists());
            path
        };

        assert!(!path.exists());
    }

    #[test]
    fn sandbox_exit_codes_are_classified() {
        assert!(matches!(
            classify_runtime_exit(ProcessExit {
                code: Some(159),
                signal: None,
            })
            .reason,
            RuntimeReason::SandboxViolation
        ));
        assert!(matches!(
            classify_runtime_exit(ProcessExit {
                code: Some(152),
                signal: None,
            })
            .reason,
            RuntimeReason::ResourceLimited
        ));
        assert!(matches!(
            classify_runtime_exit(ProcessExit {
                code: Some(7),
                signal: None,
            })
            .reason,
            RuntimeReason::Completed
        ));
        assert!(matches!(
            classify_runtime_exit(ProcessExit {
                code: None,
                signal: Some(31),
            })
            .reason,
            RuntimeReason::SandboxViolation
        ));
        assert!(matches!(
            classify_runtime_exit(ProcessExit {
                code: None,
                signal: Some(24),
            })
            .reason,
            RuntimeReason::ResourceLimited
        ));
    }

    #[test]
    fn portable_signal_names_are_converted_to_numbers() {
        assert_eq!(signal_number("Bad system call"), Some(31));
        assert_eq!(signal_number("CPU time limit exceeded"), Some(24));
        assert_eq!(signal_number("Signal 9"), Some(9));
        assert_eq!(signal_number("unknown"), None);
    }

    #[tokio::test]
    async fn pty_forwards_interactive_input_and_output() {
        let root = tempdir().expect("tempdirを作れます");
        let spec = CommandSpec {
            program: "/bin/cat".to_owned(),
            args: Vec::new(),
            cwd: root.path().to_path_buf(),
            environment: Vec::new(),
        };
        let (control_sender, mut control_receiver) = mpsc::channel(4);
        let (outbound_sender, mut outbound_receiver) = mpsc::channel(8);
        let task = tokio::spawn(async move {
            run_pty_process(
                spec,
                Dimensions { cols: 80, rows: 24 },
                Duration::from_secs(3),
                1024,
                &mut control_receiver,
                &outbound_sender,
                "worker",
                "job",
            )
            .await
        });

        control_sender
            .send(JobControl::Input(b"hello\n".to_vec()))
            .await
            .expect("stdinを送れます");
        let saw_output = tokio::time::timeout(Duration::from_secs(2), async {
            loop {
                let message = outbound_receiver.recv().await.expect("出力があります");
                if let Some(worker_message::Payload::Event(event)) = message.payload
                    && let Some(job_event::Payload::TerminalOutput(data)) = event.payload
                    && data.windows(5).any(|window| window == b"hello")
                {
                    break true;
                }
            }
        })
        .await
        .expect("時間内にPTY出力があります");
        assert!(saw_output);

        control_sender
            .send(JobControl::Cancel)
            .await
            .expect("停止を送れます");
        let outcome = task
            .await
            .expect("PTY taskが完了します")
            .expect("PTY実行に成功します");
        assert!(matches!(outcome.reason, RuntimeReason::Cancelled));
    }

    #[tokio::test]
    async fn pty_resource_limit_control_stops_only_current_job() {
        let root = tempdir().expect("tempdirを作れます");
        let spec = CommandSpec {
            program: "/bin/cat".to_owned(),
            args: Vec::new(),
            cwd: root.path().to_path_buf(),
            environment: Vec::new(),
        };
        let (control_sender, mut control_receiver) = mpsc::channel(1);
        let (outbound_sender, _outbound_receiver) = mpsc::channel(8);
        let task = tokio::spawn(async move {
            run_pty_process(
                spec,
                Dimensions { cols: 80, rows: 24 },
                Duration::from_secs(3),
                1024,
                &mut control_receiver,
                &outbound_sender,
                "worker",
                "job",
            )
            .await
        });

        control_sender
            .send(JobControl::ResourceLimit)
            .await
            .expect("資源制限停止を送れます");
        let outcome = task
            .await
            .expect("PTY taskが完了します")
            .expect("PTY実行に成功します");
        assert!(matches!(outcome.reason, RuntimeReason::ResourceLimited));
    }

    #[tokio::test]
    async fn pty_child_is_reaped_when_output_channel_disconnects() {
        let root = tempdir().expect("tempdirを作れます");
        let pid_file = root.path().join("child.pid");
        let spec = CommandSpec {
            program: "/bin/sh".to_owned(),
            args: vec![
                "-c".to_owned(),
                "echo $$ > \"$PID_FILE\"; printf ready; while :; do :; done".to_owned(),
            ],
            cwd: root.path().to_path_buf(),
            environment: vec![(
                "PID_FILE".to_owned(),
                pid_file.to_string_lossy().into_owned(),
            )],
        };
        let (_control_sender, mut control_receiver) = mpsc::channel(1);
        let (outbound_sender, outbound_receiver) = mpsc::channel(1);
        drop(outbound_receiver);

        let result = tokio::time::timeout(
            Duration::from_secs(3),
            run_pty_process(
                spec,
                Dimensions { cols: 80, rows: 24 },
                Duration::from_secs(10),
                1024,
                &mut control_receiver,
                &outbound_sender,
                "worker",
                "job",
            ),
        )
        .await
        .expect("切断後にPTY処理が終了します");
        assert!(matches!(result, Err(ExecutionError::ApiDisconnected)));

        let pid = fs::read_to_string(&pid_file)
            .expect("child PIDが記録されます")
            .trim()
            .to_owned();
        let alive = std::process::Command::new("/bin/kill")
            .args(["-0", &pid])
            .stderr(Stdio::null())
            .status()
            .expect("kill -0を実行できます")
            .success();
        assert!(!alive, "PTY childが切断後も生存しています: {pid}");
    }

    #[tokio::test]
    async fn pty_stdin_backpressure_is_bounded_and_reaped() {
        let root = tempdir().expect("tempdirを作れます");
        let pid_file = root.path().join("blocked-child.pid");
        let spec = CommandSpec {
            program: "/bin/sh".to_owned(),
            args: vec![
                "-c".to_owned(),
                "echo $$ > \"$PID_FILE\"; printf ready; kill -STOP $$".to_owned(),
            ],
            cwd: root.path().to_path_buf(),
            environment: vec![(
                "PID_FILE".to_owned(),
                pid_file.to_string_lossy().into_owned(),
            )],
        };
        let (control_sender, mut control_receiver) = mpsc::channel(8);
        let (outbound_sender, mut outbound_receiver) = mpsc::channel(8);
        let task = tokio::spawn(async move {
            run_pty_process(
                spec,
                Dimensions { cols: 80, rows: 24 },
                Duration::from_millis(250),
                1024,
                &mut control_receiver,
                &outbound_sender,
                "worker",
                "job",
            )
            .await
        });

        tokio::time::timeout(Duration::from_secs(2), async {
            loop {
                let message = outbound_receiver.recv().await.expect("PTY出力があります");
                if let Some(worker_message::Payload::Event(event)) = message.payload
                    && let Some(job_event::Payload::TerminalOutput(data)) = event.payload
                    && data.windows(5).any(|window| window == b"ready")
                {
                    break;
                }
            }
        })
        .await
        .expect("停止前のready出力を確認できます");
        for _ in 0..8 {
            control_sender
                .send(JobControl::Input(vec![b'A'; 8 * 1024]))
                .await
                .expect("上限内のstdinを送れます");
        }
        let outcome = tokio::time::timeout(Duration::from_secs(3), task)
            .await
            .expect("stdin backpressure中もPTY処理が終了します")
            .expect("PTY taskが完了します")
            .expect("PTY終了結果を取得できます");
        assert!(
            matches!(
                outcome.reason,
                RuntimeReason::TimedOut | RuntimeReason::ResourceLimited
            ),
            "unexpected runtime reason: {:?}",
            outcome.reason
        );

        let pid = fs::read_to_string(&pid_file)
            .expect("child PIDが記録されます")
            .trim()
            .to_owned();
        let alive = std::process::Command::new("/bin/kill")
            .args(["-0", &pid])
            .stderr(Stdio::null())
            .status()
            .expect("kill -0を実行できます")
            .success();
        assert!(!alive, "stdin停止中のPTY childが残っています: {pid}");
    }

    #[tokio::test]
    async fn pty_output_backpressure_is_bounded_and_reaped() {
        let root = tempdir().expect("tempdirを作れます");
        let pid_file = root.path().join("output-child.pid");
        let spec = CommandSpec {
            program: "/bin/sh".to_owned(),
            args: vec![
                "-c".to_owned(),
                "echo $$ > \"$PID_FILE\"; printf ready; while :; do :; done".to_owned(),
            ],
            cwd: root.path().to_path_buf(),
            environment: vec![(
                "PID_FILE".to_owned(),
                pid_file.to_string_lossy().into_owned(),
            )],
        };
        let (_control_sender, mut control_receiver) = mpsc::channel(1);
        let (outbound_sender, _outbound_receiver) = mpsc::channel(1);
        outbound_sender
            .send(WorkerMessage { payload: None })
            .await
            .expect("送信channelを事前に満杯にできます");

        let result = tokio::time::timeout(
            Duration::from_secs(3),
            run_pty_process(
                spec,
                Dimensions { cols: 80, rows: 24 },
                Duration::from_secs(10),
                1024,
                &mut control_receiver,
                &outbound_sender,
                "worker",
                "job",
            ),
        )
        .await
        .expect("API backpressure中もPTY処理が終了します");
        assert!(matches!(result, Err(ExecutionError::ApiBackpressure)));

        let pid = fs::read_to_string(&pid_file)
            .expect("child PIDが記録されます")
            .trim()
            .to_owned();
        let alive = std::process::Command::new("/bin/kill")
            .args(["-0", &pid])
            .stderr(Stdio::null())
            .status()
            .expect("kill -0を実行できます")
            .success();
        assert!(!alive, "output停止中のPTY childが残っています: {pid}");
    }
}
