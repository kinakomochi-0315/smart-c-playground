use std::{
    collections::{HashMap, HashSet, VecDeque},
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
    },
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use bytes::Bytes;
use executor_protocol::{
    SOURCE_FILE_MAX_COUNT, SOURCE_FILES_MAX_BYTES, is_valid_source_file_name,
    v1::{
        ApiMessage, CancelJob, CompilerOutput, ErrorEvent, ExitEvent, JobAssignment, JobCommand,
        JobEvent, JobPhase, OutputStream as ProtocolOutputStream, PhaseEvent,
        SourceFile as ProtocolSourceFile, TerminalResize, api_message, job_command, job_event,
    },
};
use tokio::sync::{Mutex, Notify, RwLock, broadcast, mpsc};
use tonic::Status;
use uuid::Uuid;

use crate::{
    config::AppConfig,
    model::{
        ApiError, CreateExecutionRequest, ExecutionPhase, ExitReason, OutputStream, ServerMessage,
        SourceFile, TerminalSize,
    },
    ticket::{IssuedTicket, TicketSigner},
};

const COMPILER_OUTPUT_LIMIT_BYTES: usize = 256 * 1024;
const TERMINAL_OUTPUT_LIMIT_BYTES: usize = 1024 * 1024;

/// WebSocketへ配送する実行イベントです。
#[derive(Clone, Debug)]
pub(crate) enum BrowserEvent {
    /// JSONとして送る制御・状態イベントです。
    Text(ServerMessage),
    /// PTYから届いた生のバイト列です。
    Binary(Bytes),
}

impl BrowserEvent {
    /// イベント送信後にWebSocketを閉じるべきかを返します。
    pub(crate) fn closes_socket(&self) -> bool {
        matches!(self, Self::Text(ServerMessage::Exit { .. }))
    }
}

/// 実行セッションの共有状態です。
pub(crate) struct Session {
    pub(crate) id: Uuid,
    pub(crate) files: Vec<SourceFile>,
    pub(crate) visitor_id: String,
    pub(crate) client_ip: String,
    pub(crate) path: String,
    pub(crate) terminal: TerminalSize,
    pub(crate) ticket_expires_unix: u64,
    pub(crate) events: broadcast::Sender<BrowserEvent>,
    inner: Mutex<SessionInner>,
}

struct SessionInner {
    phase: ExecutionPhase,
    assigned_worker: Option<String>,
    ticket_consumed: bool,
    socket_connected: bool,
    pending_activation: bool,
    limits_reserved: bool,
    finished: bool,
    limits_released: bool,
    stdin_bytes: usize,
    compiler_output_bytes: usize,
    terminal_output_bytes: usize,
}

struct WorkerHandle {
    connection_id: Uuid,
    sender: mpsc::Sender<Result<ApiMessage, Status>>,
    architecture: String,
    backend: String,
    current_job: Option<Uuid>,
    recently_completed_job: Option<(Uuid, Instant)>,
    last_seen: Instant,
}

#[derive(Default)]
struct LimitState {
    by_visitor: HashMap<String, usize>,
    by_ip: HashMap<String, usize>,
    pending_activations: usize,
}

#[derive(Default)]
struct Metrics {
    created_total: AtomicU64,
    completed_total: AtomicU64,
    rejected_total: AtomicU64,
    compiler_output_bytes: AtomicU64,
    terminal_output_bytes: AtomicU64,
    worker_disconnects_total: AtomicU64,
}

/// executor-api全体で共有するインメモリ状態です。
pub struct AppState {
    config: AppConfig,
    ticket_signer: TicketSigner,
    sessions: RwLock<HashMap<Uuid, Arc<Session>>>,
    queue: Mutex<VecDeque<Uuid>>,
    workers: Mutex<HashMap<String, WorkerHandle>>,
    limits: Mutex<LimitState>,
    dispatch_notify: Notify,
    metrics: Metrics,
}

impl AppState {
    /// 設定から空の状態を作ります。
    pub fn new(config: AppConfig) -> Arc<Self> {
        Arc::new(Self {
            ticket_signer: TicketSigner::new(config.ticket_secret.clone(), config.ticket_ttl),
            config,
            sessions: RwLock::new(HashMap::new()),
            queue: Mutex::new(VecDeque::new()),
            workers: Mutex::new(HashMap::new()),
            limits: Mutex::new(LimitState::default()),
            dispatch_notify: Notify::new(),
            metrics: Metrics::default(),
        })
    }

    /// 内部APIトークンの期待値を返します。
    pub fn internal_token(&self) -> &str {
        &self.config.internal_token
    }

    /// WebSocket接続で許可するOriginを返します。
    pub fn web_origin(&self) -> &str {
        &self.config.web_origin
    }

    /// Worker gRPC接続で期待する共有トークンを返します。
    pub fn worker_token(&self) -> &str {
        &self.config.worker_token
    }

    /// 入力を検証してWebSocket接続待ちの実行セッションを作ります。
    pub async fn create_execution(
        &self,
        request: CreateExecutionRequest,
    ) -> Result<(Arc<Session>, IssuedTicket), ApiError> {
        validate_request(&request)?;

        let id = Uuid::new_v4();
        let path = format!("/ws/executions/{id}");
        let ticket = self.ticket_signer.issue(id, &request.visitor_id, &path);
        let (events, _) = broadcast::channel(256);
        let session = Arc::new(Session {
            id,
            files: request.files,
            visitor_id: request.visitor_id,
            client_ip: request.client_ip,
            path,
            terminal: request.terminal,
            ticket_expires_unix: ticket.expires_unix,
            events,
            inner: Mutex::new(SessionInner {
                phase: ExecutionPhase::Queued,
                assigned_worker: None,
                ticket_consumed: false,
                socket_connected: false,
                pending_activation: false,
                limits_reserved: false,
                finished: false,
                limits_released: false,
                stdin_bytes: 0,
                compiler_output_bytes: 0,
                terminal_output_bytes: 0,
            }),
        });

        let mut sessions = self.sessions.write().await;
        if sessions.len() >= self.config.session_capacity {
            self.metrics.rejected_total.fetch_add(1, Ordering::Relaxed);
            return Err(ApiError::too_many_requests(
                "execution_session_capacity_exceeded",
                "実行セッション数の上限に達しています。少し待ってから再試行してください",
            ));
        }
        sessions.insert(id, Arc::clone(&session));
        drop(sessions);

        self.metrics.created_total.fetch_add(1, Ordering::Relaxed);

        Ok((session, ticket))
    }

    /// IDからセッションを取得します。
    pub(crate) async fn session(&self, id: Uuid) -> Option<Arc<Session>> {
        self.sessions.read().await.get(&id).cloned()
    }

    /// 署名チケットを一回だけ消費し、WebSocket接続を許可します。
    pub(crate) async fn consume_ticket(
        &self,
        session: &Arc<Session>,
        ticket: &str,
    ) -> Result<(), ApiError> {
        self.ticket_signer
            .verify(ticket, session.id, &session.visitor_id, &session.path)
            .map_err(|error| ApiError::conflict("invalid_execution_ticket", error.to_string()))?;

        let mut inner = session.inner.lock().await;
        if inner.ticket_consumed {
            return Err(ApiError::conflict(
                "execution_ticket_already_used",
                "この接続チケットは既に使用されています",
            ));
        }
        if inner.finished {
            return Err(ApiError::conflict(
                "execution_already_finished",
                "この実行は既に終了しています",
            ));
        }

        // 接続前にキューへ入れると、購読開始前の端末出力が失われるため、
        // ここでは枠だけ予約し、実際のenqueueはon_upgrade後に行います。
        let queue = self.queue.lock().await;
        let mut limits = self.limits.lock().await;
        if queue.len() + limits.pending_activations >= self.config.queue_capacity {
            self.metrics.rejected_total.fetch_add(1, Ordering::Relaxed);
            return Err(ApiError::too_many_requests(
                "execution_queue_full",
                "実行待ちが上限に達しています。少し待ってから再試行してください",
            ));
        }
        let visitor_count = limits
            .by_visitor
            .get(&session.visitor_id)
            .copied()
            .unwrap_or_default();
        if visitor_count >= self.config.visitor_concurrency {
            self.metrics.rejected_total.fetch_add(1, Ordering::Relaxed);
            return Err(ApiError::too_many_requests(
                "visitor_concurrency_exceeded",
                "このブラウザでは既に実行中のプログラムがあります",
            ));
        }
        let ip_count = limits
            .by_ip
            .get(&session.client_ip)
            .copied()
            .unwrap_or_default();
        if ip_count >= self.config.ip_concurrency {
            self.metrics.rejected_total.fetch_add(1, Ordering::Relaxed);
            return Err(ApiError::too_many_requests(
                "ip_concurrency_exceeded",
                "この接続元では同時実行数の上限に達しています",
            ));
        }
        *limits
            .by_visitor
            .entry(session.visitor_id.clone())
            .or_default() += 1;
        *limits.by_ip.entry(session.client_ip.clone()).or_default() += 1;
        limits.pending_activations += 1;

        inner.ticket_consumed = true;
        inner.pending_activation = true;
        inner.limits_reserved = true;
        drop(limits);
        drop(queue);
        Ok(())
    }

    /// WebSocket受信側の購読後にセッションをキューへ投入します。
    pub(crate) async fn activate_session(&self, session: &Arc<Session>) -> Result<usize, ApiError> {
        {
            let mut inner = session.inner.lock().await;
            if !inner.ticket_consumed || !inner.pending_activation || inner.finished {
                return Err(ApiError::conflict(
                    "execution_cannot_activate",
                    "実行セッションを開始できません",
                ));
            }
            inner.pending_activation = false;
            inner.socket_connected = true;
        }
        let mut queue = self.queue.lock().await;
        let mut limits = self.limits.lock().await;
        limits.pending_activations = limits.pending_activations.saturating_sub(1);
        queue.push_back(session.id);
        let position = queue.len();
        drop(limits);
        drop(queue);

        let _ = session
            .events
            .send(BrowserEvent::Text(ServerMessage::Phase {
                phase: ExecutionPhase::Queued,
                position: Some(position),
            }));
        self.dispatch_notify.notify_one();
        Ok(position)
    }

    /// WebSocketへ最初に送る現在状態を返します。
    pub(crate) async fn phase_snapshot(&self, session: &Arc<Session>) -> ServerMessage {
        let inner = session.inner.lock().await;
        ServerMessage::Phase {
            phase: inner.phase,
            position: None,
        }
    }

    /// stdinを実行中Workerへ転送します。
    pub(crate) async fn send_stdin(
        &self,
        session: &Arc<Session>,
        data: Bytes,
    ) -> Result<(), ApiError> {
        if data.len() > 8 * 1024 {
            return Err(ApiError::too_large("stdinフレームは8KiB以下にしてください"));
        }

        {
            let mut inner = session.inner.lock().await;
            if inner.phase != ExecutionPhase::Running || inner.finished {
                return Err(ApiError::conflict(
                    "execution_not_running",
                    "プログラムが実行中のときだけ入力できます",
                ));
            }
            let next = inner.stdin_bytes.saturating_add(data.len());
            if next > 64 * 1024 {
                return Err(ApiError::too_large("stdinの累計上限64KiBを超えました"));
            }
            inner.stdin_bytes = next;
        }

        self.send_command(session, job_command::Action::Stdin(data.to_vec()))
            .await
    }

    /// PTYサイズ変更をWorkerへ転送します。
    pub(crate) async fn resize(
        &self,
        session: &Arc<Session>,
        cols: u16,
        rows: u16,
    ) -> Result<(), ApiError> {
        validate_terminal(TerminalSize { cols, rows })?;
        self.send_command(
            session,
            job_command::Action::Resize(TerminalResize {
                cols: u32::from(cols),
                rows: u32::from(rows),
            }),
        )
        .await
    }

    /// 利用者操作または切断をWorkerへ伝えます。
    pub(crate) async fn cancel_execution(
        &self,
        session: &Arc<Session>,
        reason: &str,
    ) -> Result<(), ApiError> {
        let assigned_worker = {
            let inner = session.inner.lock().await;
            if inner.finished {
                return Ok(());
            }
            inner.assigned_worker.clone()
        };

        if assigned_worker.is_none() {
            self.queue.lock().await.retain(|id| *id != session.id);
            self.complete_session(
                session,
                ExecutionPhase::Cancelled,
                None,
                None,
                ExitReason::Cancelled,
            )
            .await;
            return Ok(());
        }

        self.send_command(
            session,
            job_command::Action::Cancel(CancelJob {
                reason: reason.to_owned(),
            }),
        )
        .await
    }

    /// 利用者起因の入力過多を当該セッションの資源制限として停止します。
    pub(crate) async fn resource_limit_execution(
        &self,
        session: &Arc<Session>,
        reason: &str,
    ) -> Result<(), ApiError> {
        let assigned_worker = {
            let inner = session.inner.lock().await;
            if inner.finished {
                return Ok(());
            }
            inner.assigned_worker.clone()
        };

        if assigned_worker.is_none() {
            self.queue.lock().await.retain(|id| *id != session.id);
            self.complete_session(
                session,
                ExecutionPhase::ResourceLimited,
                None,
                None,
                ExitReason::ResourceLimited,
            )
            .await;
            return Ok(());
        }

        self.send_command(
            session,
            job_command::Action::Cancel(CancelJob {
                reason: format!("resource_limit:{reason}"),
            }),
        )
        .await
    }

    async fn send_command(
        &self,
        session: &Arc<Session>,
        action: job_command::Action,
    ) -> Result<(), ApiError> {
        let worker_id = session
            .inner
            .lock()
            .await
            .assigned_worker
            .clone()
            .ok_or_else(|| {
                ApiError::conflict(
                    "execution_not_assigned",
                    "実行Workerがまだ割り当てられていません",
                )
            })?;
        let (sender, connection_id) = self
            .workers
            .lock()
            .await
            .get(&worker_id)
            .map(|worker| (worker.sender.clone(), worker.connection_id))
            .ok_or_else(|| {
                ApiError::unavailable("worker_unavailable", "実行Workerへ接続できません")
            })?;
        let message = ApiMessage {
            payload: Some(api_message::Payload::Command(JobCommand {
                job_id: session.id.to_string(),
                action: Some(action),
            })),
        };
        match sender.try_send(Ok(message)) {
            Ok(()) => Ok(()),
            Err(mpsc::error::TrySendError::Full(_)) => Err(ApiError::too_many_requests(
                "execution_command_backpressure",
                "端末への入力頻度が高すぎます",
            )),
            Err(mpsc::error::TrySendError::Closed(_)) => {
                self.unregister_worker(
                    &worker_id,
                    connection_id,
                    "実行Workerへの操作channelが閉じました",
                )
                .await;
                Err(ApiError::unavailable(
                    "worker_unavailable",
                    "実行Workerへ接続できません",
                ))
            }
        }
    }

    /// Workerを登録してジョブ配送対象へ加えます。
    pub(crate) async fn register_worker(
        &self,
        worker_id: String,
        architecture: String,
        backend: String,
        sender: mpsc::Sender<Result<ApiMessage, Status>>,
    ) -> Result<Uuid, Status> {
        if worker_id.is_empty() || worker_id.len() > 128 {
            return Err(Status::invalid_argument("worker_idが不正です"));
        }
        if architecture.is_empty() || backend.is_empty() {
            return Err(Status::invalid_argument("Worker能力が不足しています"));
        }
        if self.config.require_nsjail_workers && backend != "nsjail" {
            return Err(Status::failed_precondition(
                "productionではNsJail Workerだけを登録できます",
            ));
        }

        let connection_id = Uuid::new_v4();
        let mut workers = self.workers.lock().await;
        if workers.contains_key(&worker_id) {
            return Err(Status::already_exists(
                "同じworker_idの接続が既に存在します",
            ));
        }
        workers.insert(
            worker_id,
            WorkerHandle {
                connection_id,
                sender,
                architecture,
                backend,
                current_job: None,
                recently_completed_job: None,
                last_seen: Instant::now(),
            },
        );
        drop(workers);
        self.dispatch_notify.notify_one();
        Ok(connection_id)
    }

    /// Worker heartbeatを反映します。
    pub(crate) async fn heartbeat(
        &self,
        worker_id: &str,
        connection_id: Uuid,
        reported_job: Option<&str>,
    ) -> Result<(), Status> {
        let mut workers = self.workers.lock().await;
        let worker = workers
            .get_mut(worker_id)
            .ok_or_else(|| Status::failed_precondition("未登録のWorkerです"))?;
        if worker.connection_id != connection_id {
            return Err(Status::failed_precondition(
                "Worker接続世代が現在の登録と一致しません",
            ));
        }
        match (worker.current_job, reported_job) {
            (Some(expected), Some(reported)) if expected.to_string() == reported => {}
            (Some(_), _) => {
                return Err(Status::failed_precondition(
                    "Workerの現在ジョブがAPI状態と一致しません",
                ));
            }
            (None, None) => {}
            (None, Some(reported)) => {
                let recent_matches = worker.recently_completed_job.is_some_and(|(job, at)| {
                    job.to_string() == reported && at.elapsed() <= Duration::from_secs(5)
                });
                if !recent_matches {
                    return Err(Status::failed_precondition(
                        "Workerが未割当のジョブを報告しました",
                    ));
                }
            }
        }
        worker.last_seen = Instant::now();
        Ok(())
    }

    /// Workerから届いた状態・出力・終了イベントを反映します。
    pub(crate) async fn handle_worker_event(
        &self,
        connection_id: Uuid,
        event: JobEvent,
    ) -> Result<(), Status> {
        let job_id = Uuid::parse_str(&event.job_id)
            .map_err(|_| Status::invalid_argument("job_idがUUIDではありません"))?;
        {
            let mut workers = self.workers.lock().await;
            let worker = workers
                .get_mut(&event.worker_id)
                .ok_or_else(|| Status::failed_precondition("未登録のWorkerです"))?;
            if worker.connection_id != connection_id {
                return Err(Status::failed_precondition(
                    "Worker接続世代が現在の登録と一致しません",
                ));
            }
            if worker.current_job != Some(job_id) {
                return Err(Status::failed_precondition(
                    "割当と異なるジョブのイベントです",
                ));
            }
            worker.last_seen = Instant::now();
        }

        let session = self
            .session(job_id)
            .await
            .ok_or_else(|| Status::not_found("実行セッションがありません"))?;
        let payload = event
            .payload
            .ok_or_else(|| Status::invalid_argument("イベント内容がありません"))?;
        match payload {
            job_event::Payload::Phase(phase) => {
                self.apply_phase(&session, phase).await?;
            }
            job_event::Payload::CompilerOutput(output) => {
                self.apply_compiler_output(&session, output).await?;
            }
            job_event::Payload::TerminalOutput(data) => {
                self.apply_terminal_output(&session, Bytes::from(data))
                    .await?;
            }
            job_event::Payload::Exit(exit) => {
                self.apply_exit(&session, exit).await?;
            }
            job_event::Payload::Error(error) => {
                self.apply_error(&session, error).await;
            }
        }
        Ok(())
    }

    async fn apply_phase(&self, session: &Arc<Session>, phase: PhaseEvent) -> Result<(), Status> {
        let phase = protocol_phase(phase.phase)
            .ok_or_else(|| Status::invalid_argument("実行フェーズが不正です"))?;
        {
            let mut inner = session.inner.lock().await;
            if inner.finished {
                return Ok(());
            }
            if !valid_transition(inner.phase, phase) {
                return Err(Status::failed_precondition("不正な実行フェーズ遷移です"));
            }
            inner.phase = phase;
        }
        let _ = session
            .events
            .send(BrowserEvent::Text(ServerMessage::Phase {
                phase,
                position: None,
            }));
        Ok(())
    }

    async fn apply_compiler_output(
        &self,
        session: &Arc<Session>,
        output: CompilerOutput,
    ) -> Result<(), Status> {
        {
            let mut inner = session.inner.lock().await;
            inner.compiler_output_bytes = inner
                .compiler_output_bytes
                .saturating_add(output.data.len());
            if inner.compiler_output_bytes > COMPILER_OUTPUT_LIMIT_BYTES {
                drop(inner);
                let _ = self
                    .cancel_execution(session, "compiler_output_limit")
                    .await;
                return Err(Status::resource_exhausted(
                    "コンパイラ出力が上限を超えました",
                ));
            }
        }
        self.metrics
            .compiler_output_bytes
            .fetch_add(output.data.len() as u64, Ordering::Relaxed);
        let stream = match ProtocolOutputStream::try_from(output.stream) {
            Ok(ProtocolOutputStream::Stdout) => OutputStream::Stdout,
            Ok(ProtocolOutputStream::Stderr) => OutputStream::Stderr,
            _ => return Err(Status::invalid_argument("出力streamが不正です")),
        };
        let _ = session
            .events
            .send(BrowserEvent::Text(ServerMessage::CompilerOutput {
                stream,
                data: String::from_utf8_lossy(&output.data).into_owned(),
            }));
        Ok(())
    }

    async fn apply_terminal_output(
        &self,
        session: &Arc<Session>,
        data: Bytes,
    ) -> Result<(), Status> {
        {
            let mut inner = session.inner.lock().await;
            inner.terminal_output_bytes = inner.terminal_output_bytes.saturating_add(data.len());
            if inner.terminal_output_bytes > TERMINAL_OUTPUT_LIMIT_BYTES {
                drop(inner);
                let _ = self
                    .cancel_execution(session, "terminal_output_limit")
                    .await;
                return Err(Status::resource_exhausted("端末出力が上限を超えました"));
            }
        }
        self.metrics
            .terminal_output_bytes
            .fetch_add(data.len() as u64, Ordering::Relaxed);
        let _ = session.events.send(BrowserEvent::Binary(data));
        Ok(())
    }

    async fn apply_exit(&self, session: &Arc<Session>, exit: ExitEvent) -> Result<(), Status> {
        let reason = protocol_exit_reason(exit.reason)
            .ok_or_else(|| Status::invalid_argument("終了理由が不正です"))?;
        let phase = phase_for_exit(reason);
        self.complete_session(session, phase, exit.code, exit.signal, reason)
            .await;
        Ok(())
    }

    async fn apply_error(&self, session: &Arc<Session>, error: ErrorEvent) {
        let _ = session
            .events
            .send(BrowserEvent::Text(ServerMessage::Error {
                code: error.code,
                message: error.message,
                retryable: error.retryable,
            }));
    }

    async fn complete_session(
        &self,
        session: &Arc<Session>,
        phase: ExecutionPhase,
        code: Option<i32>,
        signal: Option<i32>,
        reason: ExitReason,
    ) {
        let worker_id = {
            let mut inner = session.inner.lock().await;
            if inner.finished {
                return;
            }
            inner.phase = phase;
            inner.finished = true;
            inner.assigned_worker.take()
        };

        let _ = session
            .events
            .send(BrowserEvent::Text(ServerMessage::Phase {
                phase,
                position: None,
            }));
        let _ = session.events.send(BrowserEvent::Text(ServerMessage::Exit {
            code,
            signal,
            reason,
        }));
        self.release_limits(session).await;

        if let Some(worker_id) = worker_id {
            if let Some(worker) = self.workers.lock().await.get_mut(&worker_id) {
                if worker.current_job == Some(session.id) {
                    worker.current_job = None;
                    worker.recently_completed_job = Some((session.id, Instant::now()));
                }
            }
        }
        self.metrics.completed_total.fetch_add(1, Ordering::Relaxed);
        self.sessions.write().await.remove(&session.id);
        self.dispatch_notify.notify_one();
    }

    async fn release_limits(&self, session: &Arc<Session>) {
        let was_pending = {
            let mut inner = session.inner.lock().await;
            if inner.limits_released || !inner.limits_reserved {
                return;
            }
            inner.limits_released = true;
            let was_pending = inner.pending_activation;
            inner.pending_activation = false;
            inner.limits_reserved = false;
            was_pending
        };
        let mut limits = self.limits.lock().await;
        if was_pending {
            limits.pending_activations = limits.pending_activations.saturating_sub(1);
        }
        decrement(&mut limits.by_visitor, &session.visitor_id);
        decrement(&mut limits.by_ip, &session.client_ip);
    }

    /// Worker切断時に実行中ジョブを失敗させます。
    pub(crate) async fn unregister_worker(
        &self,
        worker_id: &str,
        connection_id: Uuid,
        detail: &str,
    ) {
        let worker = {
            let mut workers = self.workers.lock().await;
            if workers
                .get(worker_id)
                .is_some_and(|worker| worker.connection_id == connection_id)
            {
                workers.remove(worker_id)
            } else {
                None
            }
        };
        let Some(worker) = worker else {
            return;
        };
        self.metrics
            .worker_disconnects_total
            .fetch_add(1, Ordering::Relaxed);
        if let Some(job_id) = worker.current_job
            && let Some(session) = self.session(job_id).await
        {
            let _ = session
                .events
                .send(BrowserEvent::Text(ServerMessage::Error {
                    code: "worker_disconnected".to_owned(),
                    message: detail.to_owned(),
                    retryable: true,
                }));
            self.complete_session(
                &session,
                ExecutionPhase::Exited,
                None,
                None,
                ExitReason::InternalError,
            )
            .await;
        }
        self.dispatch_notify.notify_one();
    }

    /// 待機ジョブを空いているWorkerへ順次割り当てます。
    pub async fn run_dispatcher(self: Arc<Self>) {
        loop {
            let notified = self.dispatch_notify.notified();
            while self.try_dispatch_one().await {}
            notified.await;
        }
    }

    async fn try_dispatch_one(&self) -> bool {
        let Some(job_id) = self.queue.lock().await.pop_front() else {
            return false;
        };
        let Some(session) = self.session(job_id).await else {
            return true;
        };
        let message = ApiMessage {
            payload: Some(api_message::Payload::Assignment(JobAssignment {
                job_id: job_id.to_string(),
                terminal_cols: u32::from(session.terminal.cols),
                terminal_rows: u32::from(session.terminal.rows),
                files: session
                    .files
                    .iter()
                    .map(|file| ProtocolSourceFile {
                        name: file.name.clone(),
                        content: file.content.as_bytes().to_vec(),
                    })
                    .collect(),
            })),
        };
        let mut inner = session.inner.lock().await;
        if inner.finished {
            return true;
        }
        let mut failed_worker = None;
        let assigned = {
            let mut workers = self.workers.lock().await;
            let running = workers
                .values()
                .filter(|worker| worker.current_job.is_some())
                .count();
            if running >= self.config.global_concurrency {
                false
            } else {
                let candidate = workers
                    .iter_mut()
                    .find(|(_, worker)| worker.current_job.is_none())
                    .map(|(id, worker)| (id.clone(), worker));
                match candidate {
                    Some((worker_id, worker)) => {
                        if worker.sender.try_send(Ok(message)).is_ok() {
                            worker.current_job = Some(job_id);
                            inner.assigned_worker = Some(worker_id);
                            true
                        } else {
                            failed_worker = Some((worker_id, worker.connection_id));
                            false
                        }
                    }
                    None => false,
                }
            }
        };
        drop(inner);
        if assigned {
            return true;
        }
        self.queue.lock().await.push_front(job_id);
        if let Some((worker_id, connection_id)) = failed_worker {
            self.unregister_worker(
                &worker_id,
                connection_id,
                "実行Workerへの割当送信が滞留しました",
            )
            .await;
            true
        } else {
            false
        }
    }

    /// 期限切れセッションとheartbeat停止Workerを定期的に掃除します。
    pub async fn run_maintenance(self: Arc<Self>) {
        let mut interval = tokio::time::interval(Duration::from_secs(5));
        loop {
            interval.tick().await;
            self.maintenance_once().await;
        }
    }

    async fn maintenance_once(&self) {
        let stale_workers = {
            let workers = self.workers.lock().await;
            workers
                .iter()
                .filter(|(_, worker)| worker.last_seen.elapsed() > self.config.worker_stale_after)
                .map(|(id, worker)| (id.clone(), worker.connection_id))
                .collect::<Vec<_>>()
        };
        for (worker_id, connection_id) in stale_workers {
            self.unregister_worker(
                &worker_id,
                connection_id,
                "実行Workerのheartbeatが途絶えました",
            )
            .await;
        }

        let now = unix_now();
        let sessions = self
            .sessions
            .read()
            .await
            .values()
            .cloned()
            .collect::<Vec<_>>();
        for session in sessions {
            let (socket_connected, finished) = {
                let inner = session.inner.lock().await;
                (inner.socket_connected, inner.finished)
            };
            if !socket_connected && !finished && now >= session.ticket_expires_unix {
                let _ = self.cancel_execution(&session, "ticket_expired").await;
            }
        }
    }

    /// Worker接続があり新しい実行を受け付けられるかを返します。
    pub async fn is_ready(&self) -> bool {
        self.workers
            .lock()
            .await
            .values()
            .filter(|worker| worker.last_seen.elapsed() <= self.config.worker_stale_after)
            .count()
            >= self.config.minimum_ready_workers
    }

    /// Prometheus text exposition形式の指標を返します。
    pub async fn render_metrics(&self) -> String {
        let sessions = self.sessions.read().await;
        let active = sessions.len();
        drop(sessions);
        let queued = self.queue.lock().await.len();
        let workers = self.workers.lock().await;
        let worker_total = workers.len();
        let worker_busy = workers
            .values()
            .filter(|worker| worker.current_job.is_some())
            .count();
        let nsjail_workers = workers
            .values()
            .filter(|worker| worker.backend == "nsjail")
            .count();
        let architecture_labels =
            workers
                .values()
                .fold(HashMap::<String, usize>::new(), |mut counts, worker| {
                    *counts.entry(worker.architecture.clone()).or_default() += 1;
                    counts
                });
        drop(workers);

        let mut output = format!(
            concat!(
                "# TYPE smart_c_executions_created_total counter\n",
                "smart_c_executions_created_total {}\n",
                "# TYPE smart_c_executions_completed_total counter\n",
                "smart_c_executions_completed_total {}\n",
                "# TYPE smart_c_executions_rejected_total counter\n",
                "smart_c_executions_rejected_total {}\n",
                "# TYPE smart_c_compiler_output_bytes_total counter\n",
                "smart_c_compiler_output_bytes_total {}\n",
                "# TYPE smart_c_terminal_output_bytes_total counter\n",
                "smart_c_terminal_output_bytes_total {}\n",
                "# TYPE smart_c_worker_disconnects_total counter\n",
                "smart_c_worker_disconnects_total {}\n",
                "# TYPE smart_c_sessions gauge\n",
                "smart_c_sessions {}\n",
                "# TYPE smart_c_queue_depth gauge\n",
                "smart_c_queue_depth {}\n",
                "# TYPE smart_c_workers gauge\n",
                "smart_c_workers {}\n",
                "# TYPE smart_c_workers_busy gauge\n",
                "smart_c_workers_busy {}\n",
                "# TYPE smart_c_workers_nsjail gauge\n",
                "smart_c_workers_nsjail {}\n",
            ),
            self.metrics.created_total.load(Ordering::Relaxed),
            self.metrics.completed_total.load(Ordering::Relaxed),
            self.metrics.rejected_total.load(Ordering::Relaxed),
            self.metrics.compiler_output_bytes.load(Ordering::Relaxed),
            self.metrics.terminal_output_bytes.load(Ordering::Relaxed),
            self.metrics
                .worker_disconnects_total
                .load(Ordering::Relaxed),
            active,
            queued,
            worker_total,
            worker_busy,
            nsjail_workers,
        );
        output.push_str("# TYPE smart_c_workers_by_architecture gauge\n");
        for (architecture, count) in architecture_labels {
            // Worker自身が送る値なので、Prometheusラベル用に危険な文字を除きます。
            let architecture = architecture
                .chars()
                .filter(|character| {
                    character.is_ascii_alphanumeric() || matches!(character, '_' | '-' | '.')
                })
                .take(64)
                .collect::<String>();
            output.push_str(&format!(
                "smart_c_workers_by_architecture{{architecture=\"{architecture}\"}} {count}\n"
            ));
        }
        output
    }
}

fn validate_request(request: &CreateExecutionRequest) -> Result<(), ApiError> {
    if request.files.is_empty() || request.files.len() > SOURCE_FILE_MAX_COUNT {
        return Err(ApiError::bad_request(
            "source_files_count_invalid",
            format!("ファイル数は1から{SOURCE_FILE_MAX_COUNT}件にしてください"),
        ));
    }

    let mut names = HashSet::new();
    let mut total_bytes = 0_usize;
    let mut has_main = false;
    for file in &request.files {
        if !is_valid_source_file_name(&file.name) {
            return Err(ApiError::bad_request(
                "source_file_name_invalid",
                "ファイル名は英数字、ハイフン、アンダースコアを使った.cまたは.hにしてください",
            ));
        }
        if !names.insert(file.name.to_ascii_lowercase()) {
            return Err(ApiError::bad_request(
                "source_file_name_duplicate",
                "同じファイル名を複数指定できません",
            ));
        }
        if file.content.contains('\0') {
            return Err(ApiError::bad_request(
                "source_contains_nul",
                "ファイル内容にNUL文字は使用できません",
            ));
        }
        has_main |= file.name == "main.c";
        total_bytes = total_bytes.saturating_add(file.content.len());
    }
    if !has_main {
        return Err(ApiError::bad_request(
            "main_source_missing",
            "main.cは必須です",
        ));
    }
    if total_bytes == 0 {
        return Err(ApiError::bad_request(
            "source_empty",
            "C言語ソースを入力してください",
        ));
    }
    if total_bytes > SOURCE_FILES_MAX_BYTES {
        return Err(ApiError::too_large(
            "全ファイルの合計は64KiB以下にしてください",
        ));
    }
    if request.visitor_id.is_empty() || request.visitor_id.len() > 128 {
        return Err(ApiError::bad_request(
            "visitor_id_invalid",
            "visitorIdが不正です",
        ));
    }
    if request.client_ip.is_empty() || request.client_ip.len() > 64 {
        return Err(ApiError::bad_request(
            "client_ip_invalid",
            "clientIpが不正です",
        ));
    }
    validate_terminal(request.terminal)
}

fn validate_terminal(terminal: TerminalSize) -> Result<(), ApiError> {
    if !(20..=240).contains(&terminal.cols) || !(5..=80).contains(&terminal.rows) {
        return Err(ApiError::bad_request(
            "terminal_size_invalid",
            "端末サイズは20〜240桁、5〜80行の範囲にしてください",
        ));
    }
    Ok(())
}

fn valid_transition(from: ExecutionPhase, to: ExecutionPhase) -> bool {
    matches!(
        (from, to),
        (ExecutionPhase::Queued, ExecutionPhase::Compiling)
            | (ExecutionPhase::Compiling, ExecutionPhase::CompileFailed)
            | (ExecutionPhase::Compiling, ExecutionPhase::Running)
            | (ExecutionPhase::Compiling, ExecutionPhase::TimedOut)
            | (ExecutionPhase::Compiling, ExecutionPhase::ResourceLimited)
            | (ExecutionPhase::Compiling, ExecutionPhase::Cancelled)
            | (ExecutionPhase::Running, ExecutionPhase::Exited)
            | (ExecutionPhase::Running, ExecutionPhase::TimedOut)
            | (ExecutionPhase::Running, ExecutionPhase::ResourceLimited)
            | (ExecutionPhase::Running, ExecutionPhase::Cancelled)
            | (ExecutionPhase::Running, ExecutionPhase::SandboxViolation)
    ) || from == to
}

fn protocol_phase(value: i32) -> Option<ExecutionPhase> {
    match JobPhase::try_from(value) {
        Ok(JobPhase::Queued) => Some(ExecutionPhase::Queued),
        Ok(JobPhase::Compiling) => Some(ExecutionPhase::Compiling),
        Ok(JobPhase::CompileFailed) => Some(ExecutionPhase::CompileFailed),
        Ok(JobPhase::Running) => Some(ExecutionPhase::Running),
        Ok(JobPhase::Exited) => Some(ExecutionPhase::Exited),
        Ok(JobPhase::TimedOut) => Some(ExecutionPhase::TimedOut),
        Ok(JobPhase::ResourceLimited) => Some(ExecutionPhase::ResourceLimited),
        Ok(JobPhase::Cancelled) => Some(ExecutionPhase::Cancelled),
        Ok(JobPhase::SandboxViolation) => Some(ExecutionPhase::SandboxViolation),
        _ => None,
    }
}

fn protocol_exit_reason(value: i32) -> Option<ExitReason> {
    match executor_protocol::v1::ExitReason::try_from(value) {
        Ok(executor_protocol::v1::ExitReason::Completed) => Some(ExitReason::Completed),
        Ok(executor_protocol::v1::ExitReason::CompileFailed) => Some(ExitReason::CompileFailed),
        Ok(executor_protocol::v1::ExitReason::TimedOut) => Some(ExitReason::TimedOut),
        Ok(executor_protocol::v1::ExitReason::ResourceLimited) => Some(ExitReason::ResourceLimited),
        Ok(executor_protocol::v1::ExitReason::Cancelled) => Some(ExitReason::Cancelled),
        Ok(executor_protocol::v1::ExitReason::SandboxViolation) => {
            Some(ExitReason::SandboxViolation)
        }
        Ok(executor_protocol::v1::ExitReason::InternalError) => Some(ExitReason::InternalError),
        _ => None,
    }
}

fn phase_for_exit(reason: ExitReason) -> ExecutionPhase {
    match reason {
        ExitReason::Completed => ExecutionPhase::Exited,
        ExitReason::CompileFailed => ExecutionPhase::CompileFailed,
        ExitReason::TimedOut => ExecutionPhase::TimedOut,
        ExitReason::ResourceLimited => ExecutionPhase::ResourceLimited,
        ExitReason::Cancelled => ExecutionPhase::Cancelled,
        ExitReason::SandboxViolation => ExecutionPhase::SandboxViolation,
        ExitReason::InternalError => ExecutionPhase::Exited,
    }
}

fn decrement(map: &mut HashMap<String, usize>, key: &str) {
    if let Some(value) = map.get_mut(key) {
        *value = value.saturating_sub(1);
        if *value == 0 {
            map.remove(key);
        }
    }
}

fn unix_now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(visitor: &str, ip: &str) -> CreateExecutionRequest {
        CreateExecutionRequest {
            files: vec![SourceFile {
                name: "main.c".to_owned(),
                content: "int main(void) { return 0; }".to_owned(),
            }],
            terminal: TerminalSize {
                cols: 100,
                rows: 30,
            },
            visitor_id: visitor.to_owned(),
            client_ip: ip.to_owned(),
        }
    }

    #[test]
    fn source_file_validation_rejects_paths_and_missing_main() {
        let mut invalid_path = request("visitor", "192.0.2.1");
        invalid_path.files[0].name = "../main.c".to_owned();
        assert!(validate_request(&invalid_path).is_err());

        let mut missing_main = request("visitor", "192.0.2.1");
        missing_main.files[0].name = "aaa.c".to_owned();
        assert!(validate_request(&missing_main).is_err());
    }

    #[tokio::test]
    async fn visitor_can_only_have_one_active_execution() {
        let state = AppState::new(AppConfig::for_test());
        let (first, first_ticket) = state
            .create_execution(request("visitor", "192.0.2.1"))
            .await
            .expect("1件目は作成できます");
        state
            .consume_ticket(&first, &first_ticket.value)
            .await
            .expect("1件目の枠を予約できます");
        let (second, second_ticket) = state
            .create_execution(request("visitor", "192.0.2.2"))
            .await
            .expect("未接続セッションは作成できます");
        let error = state
            .consume_ticket(&second, &second_ticket.value)
            .await
            .expect_err("2件目の接続は拒否されます");

        assert!(error.to_string().contains("visitor_concurrency_exceeded"));
    }

    #[tokio::test]
    async fn ticket_can_only_be_consumed_once() {
        let state = AppState::new(AppConfig::for_test());
        let (session, ticket) = state
            .create_execution(request("visitor", "192.0.2.1"))
            .await
            .expect("実行を作成できます");

        state
            .consume_ticket(&session, &ticket.value)
            .await
            .expect("初回は使用できます");
        let error = state
            .consume_ticket(&session, &ticket.value)
            .await
            .expect_err("再利用は拒否されます");
        assert!(error.to_string().contains("execution_ticket_already_used"));
    }

    #[tokio::test]
    async fn global_session_capacity_bounds_unconnected_source_memory() {
        let mut config = AppConfig::for_test();
        config.session_capacity = 2;
        let state = AppState::new(config);
        state
            .create_execution(request("visitor-a", "192.0.2.1"))
            .await
            .expect("1件目は作成できます");
        state
            .create_execution(request("visitor-b", "192.0.2.2"))
            .await
            .expect("2件目は作成できます");
        let error = match state
            .create_execution(request("visitor-c", "192.0.2.3"))
            .await
        {
            Ok(_) => panic!("全体上限を超えるセッションは拒否されます"),
            Err(error) => error,
        };

        assert!(
            error
                .to_string()
                .contains("execution_session_capacity_exceeded")
        );
    }

    #[tokio::test]
    async fn expired_unconnected_session_is_removed_immediately() {
        let mut config = AppConfig::for_test();
        config.session_capacity = 1;
        config.ticket_ttl = Duration::ZERO;
        let state = AppState::new(config);
        state
            .create_execution(request("visitor-a", "192.0.2.1"))
            .await
            .expect("セッションを作成できます");
        tokio::time::sleep(Duration::from_secs(1)).await;
        state.maintenance_once().await;

        assert!(state.sessions.read().await.is_empty());
        state
            .create_execution(request("visitor-b", "192.0.2.2"))
            .await
            .expect("期限切れ削除後は新規作成できます");
    }

    #[tokio::test]
    async fn old_worker_connection_cannot_remove_new_generation() {
        let state = AppState::new(AppConfig::for_test());
        let (first_sender, _) = mpsc::channel(4);
        let first_generation = state
            .register_worker(
                "worker".to_owned(),
                "test".to_owned(),
                "direct".to_owned(),
                first_sender,
            )
            .await
            .expect("最初のWorkerを登録できます");
        state
            .unregister_worker("worker", first_generation, "test disconnect")
            .await;

        let (second_sender, _) = mpsc::channel(4);
        let second_generation = state
            .register_worker(
                "worker".to_owned(),
                "test".to_owned(),
                "direct".to_owned(),
                second_sender,
            )
            .await
            .expect("新しい世代を登録できます");
        state
            .unregister_worker("worker", first_generation, "old stream teardown")
            .await;

        assert_eq!(
            state
                .workers
                .lock()
                .await
                .get("worker")
                .map(|worker| worker.connection_id),
            Some(second_generation)
        );
    }

    #[tokio::test]
    async fn duplicate_worker_registration_is_atomic() {
        let state = AppState::new(AppConfig::for_test());
        let (first_sender, _) = mpsc::channel(4);
        let (second_sender, _) = mpsc::channel(4);
        let first = state.register_worker(
            "worker".to_owned(),
            "test".to_owned(),
            "direct".to_owned(),
            first_sender,
        );
        let second = state.register_worker(
            "worker".to_owned(),
            "test".to_owned(),
            "direct".to_owned(),
            second_sender,
        );
        let (first, second) = tokio::join!(first, second);

        assert_ne!(first.is_ok(), second.is_ok());
        assert_eq!(state.workers.lock().await.len(), 1);
    }

    #[tokio::test]
    async fn readiness_requires_configured_worker_count() {
        let mut config = AppConfig::for_test();
        config.minimum_ready_workers = 2;
        let state = AppState::new(config);
        let (first_sender, _) = mpsc::channel(4);
        state
            .register_worker(
                "worker-1".to_owned(),
                "test".to_owned(),
                "direct".to_owned(),
                first_sender,
            )
            .await
            .expect("1台目のWorkerを登録できます");
        assert!(!state.is_ready().await);

        let (second_sender, _) = mpsc::channel(4);
        state
            .register_worker(
                "worker-2".to_owned(),
                "test".to_owned(),
                "direct".to_owned(),
                second_sender,
            )
            .await
            .expect("2台目のWorkerを登録できます");
        assert!(state.is_ready().await);
    }

    #[tokio::test]
    async fn finished_queued_session_is_not_assigned() {
        let state = AppState::new(AppConfig::for_test());
        let (session, ticket) = state
            .create_execution(request("visitor", "192.0.2.1"))
            .await
            .expect("実行を作成できます");
        state
            .consume_ticket(&session, &ticket.value)
            .await
            .expect("実行枠を予約できます");
        state
            .activate_session(&session)
            .await
            .expect("実行をqueueへ追加できます");
        session.inner.lock().await.finished = true;
        let (worker_sender, mut worker_receiver) = mpsc::channel(4);
        state
            .register_worker(
                "worker".to_owned(),
                "test".to_owned(),
                "direct".to_owned(),
                worker_sender,
            )
            .await
            .expect("Workerを登録できます");

        assert!(state.try_dispatch_one().await);
        assert!(worker_receiver.try_recv().is_err());
        assert!(
            state
                .workers
                .lock()
                .await
                .get("worker")
                .is_some_and(|worker| worker.current_job.is_none())
        );
    }

    #[tokio::test]
    async fn assignment_is_enqueued_before_cancel_command() {
        let state = AppState::new(AppConfig::for_test());
        let (session, ticket) = state
            .create_execution(request("visitor", "192.0.2.1"))
            .await
            .expect("実行を作成できます");
        state
            .consume_ticket(&session, &ticket.value)
            .await
            .expect("実行枠を予約できます");
        state
            .activate_session(&session)
            .await
            .expect("実行をqueueへ追加できます");
        let (worker_sender, mut worker_receiver) = mpsc::channel(4);
        state
            .register_worker(
                "worker".to_owned(),
                "test".to_owned(),
                "direct".to_owned(),
                worker_sender,
            )
            .await
            .expect("Workerを登録できます");

        assert!(state.try_dispatch_one().await);
        state
            .cancel_execution(&session, "test cancel")
            .await
            .expect("cancelを送れます");

        let first = worker_receiver.recv().await.expect("assignmentがあります");
        let second = worker_receiver.recv().await.expect("cancelがあります");
        assert!(matches!(
            first.expect("正常メッセージです").payload,
            Some(api_message::Payload::Assignment(_))
        ));
        assert!(matches!(
            second.expect("正常メッセージです").payload,
            Some(api_message::Payload::Command(_))
        ));
    }

    #[tokio::test]
    async fn client_command_backpressure_keeps_worker_registered() {
        let state = AppState::new(AppConfig::for_test());
        let (session, ticket) = state
            .create_execution(request("visitor", "192.0.2.1"))
            .await
            .expect("実行を作成できます");
        state
            .consume_ticket(&session, &ticket.value)
            .await
            .expect("実行枠を予約できます");
        state
            .activate_session(&session)
            .await
            .expect("実行をqueueへ追加できます");
        let (worker_sender, _worker_receiver) = mpsc::channel(1);
        state
            .register_worker(
                "worker".to_owned(),
                "test".to_owned(),
                "direct".to_owned(),
                worker_sender,
            )
            .await
            .expect("Workerを登録できます");
        assert!(state.try_dispatch_one().await);
        session.inner.lock().await.phase = ExecutionPhase::Running;

        let error = state
            .send_stdin(&session, Bytes::from_static(b"x"))
            .await
            .expect_err("満杯channelでは入力を拒否します");
        assert!(error.to_string().contains("execution_command_backpressure"));
        assert!(state.workers.lock().await.contains_key("worker"));
    }

    #[test]
    fn only_expected_state_transitions_are_allowed() {
        assert!(valid_transition(
            ExecutionPhase::Queued,
            ExecutionPhase::Compiling
        ));
        assert!(valid_transition(
            ExecutionPhase::Compiling,
            ExecutionPhase::Running
        ));
        assert!(!valid_transition(
            ExecutionPhase::Queued,
            ExecutionPhase::Running
        ));
        assert!(!valid_transition(
            ExecutionPhase::Exited,
            ExecutionPhase::Running
        ));
    }
}
