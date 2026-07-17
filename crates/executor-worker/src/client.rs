use std::{
    panic::AssertUnwindSafe,
    sync::Arc,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use executor_protocol::v1::{
    ApiMessage, ErrorEvent, ExitEvent, ExitReason, JobEvent, WorkerHeartbeat, WorkerMessage,
    WorkerRegistration, api_message, executor_control_client::ExecutorControlClient, job_command,
    job_event, worker_message,
};
use futures_util::FutureExt;
use thiserror::Error;
use tokio::{
    sync::{RwLock, mpsc},
    task::JoinHandle,
};
use tokio_stream::wrappers::ReceiverStream;
use tonic::{Request, metadata::MetadataValue};
use tracing::{info, warn};

use crate::{
    config::WorkerConfig,
    execution::{JobControl, execute_assignment},
};

/// executor-apiへ接続し、切断時は安全にジョブを止めて再接続します。
pub async fn run_worker(config: WorkerConfig) -> Result<(), ClientError> {
    loop {
        match connect_once(config.clone()).await {
            Ok(()) => warn!("executor-apiとのstreamが終了したため再接続します"),
            Err(error) => warn!(%error, "executor-apiへ接続できません。再試行します"),
        }
        tokio::time::sleep(Duration::from_secs(1)).await;
    }
}

async fn connect_once(config: WorkerConfig) -> Result<(), ClientError> {
    let mut client = ExecutorControlClient::connect(config.api_grpc_url.clone()).await?;
    let (outbound, outbound_receiver) = mpsc::channel(256);
    outbound
        .send(WorkerMessage {
            payload: Some(worker_message::Payload::Registration(WorkerRegistration {
                worker_id: config.worker_id.clone(),
                architecture: config.architecture.clone(),
                backend: config.backend.as_str().to_owned(),
            })),
        })
        .await
        .map_err(|_| ClientError::OutboundClosed)?;
    let mut request = Request::new(ReceiverStream::new(outbound_receiver));
    request.metadata_mut().insert(
        "x-worker-token",
        MetadataValue::try_from(config.worker_token.as_str())
            .map_err(|_| ClientError::InvalidWorkerToken)?,
    );
    let mut inbound = client.work(request).await?.into_inner();
    info!(
        worker_id = config.worker_id,
        backend = config.backend.as_str(),
        "executor-apiへ接続しました"
    );

    let current_job = Arc::new(RwLock::new(None::<String>));
    let heartbeat = tokio::spawn(send_heartbeats(
        config.worker_id.clone(),
        Arc::clone(&current_job),
        outbound.clone(),
    ));
    let (completion_sender, mut completion_receiver) = mpsc::channel::<String>(4);
    let mut active: Option<ActiveJob> = None;

    loop {
        tokio::select! {
            biased;
            completed = completion_receiver.recv(), if active.is_some() => {
                if let Some(completed) = completed
                    && active.as_ref().is_some_and(|job| job.id == completed)
                {
                    active = None;
                    *current_job.write().await = None;
                }
            }
            message = inbound.message() => {
                let Some(message) = message? else {
                    break;
                };
                handle_api_message(
                    &config,
                    message,
                    &outbound,
                    &completion_sender,
                    &current_job,
                    &mut active,
                ).await?;
            }
        }
    }

    heartbeat.abort();
    if let Some(mut active) = active {
        let _ = active.controls.send(JobControl::Cancel).await;
        if tokio::time::timeout(Duration::from_secs(2), &mut active.handle)
            .await
            .is_err()
        {
            active.handle.abort();
        }
    }
    Ok(())
}

async fn handle_api_message(
    config: &WorkerConfig,
    message: ApiMessage,
    outbound: &mpsc::Sender<WorkerMessage>,
    completion: &mpsc::Sender<String>,
    current_job: &Arc<RwLock<Option<String>>>,
    active: &mut Option<ActiveJob>,
) -> Result<(), ClientError> {
    match message
        .payload
        .ok_or(ClientError::Protocol("APIメッセージ内容がありません"))?
    {
        api_message::Payload::Assignment(assignment) => {
            if active.is_some() {
                return Err(ClientError::Protocol(
                    "処理中Workerへ別のジョブが割り当てられました",
                ));
            }
            let id = assignment.job_id.clone();
            let (control_sender, control_receiver) = mpsc::channel(64);
            let config = config.clone();
            let outbound = outbound.clone();
            let panic_outbound = outbound.clone();
            let completion = completion.clone();
            let completed_id = id.clone();
            let panic_worker_id = config.worker_id.clone();
            let panic_job_id = id.clone();
            *current_job.write().await = Some(id.clone());
            let handle = tokio::spawn(async move {
                let result = AssertUnwindSafe(execute_assignment(
                    config,
                    assignment,
                    control_receiver,
                    outbound,
                ))
                .catch_unwind()
                .await;
                if result.is_err() {
                    send_panic_exit(&panic_outbound, &panic_worker_id, &panic_job_id).await;
                }
                let _ = completion.send(completed_id).await;
            });
            *active = Some(ActiveJob {
                id,
                controls: control_sender,
                handle,
            });
        }
        api_message::Payload::Command(command) => {
            let active = active.as_ref().ok_or(ClientError::Protocol(
                "実行中でないWorkerへ操作が届きました",
            ))?;
            if command.job_id != active.id {
                return Err(ClientError::Protocol("現在ジョブと異なる操作が届きました"));
            }
            let control = match command
                .action
                .ok_or(ClientError::Protocol("ジョブ操作内容がありません"))?
            {
                job_command::Action::Stdin(data) => {
                    if data.len() > 8 * 1024 {
                        return Err(ClientError::Protocol("stdinフレームが8KiBを超えています"));
                    }
                    JobControl::Input(data)
                }
                job_command::Action::Resize(resize) => {
                    let cols = u16::try_from(resize.cols)
                        .map_err(|_| ClientError::Protocol("colsが不正です"))?;
                    let rows = u16::try_from(resize.rows)
                        .map_err(|_| ClientError::Protocol("rowsが不正です"))?;
                    if !(20..=240).contains(&cols) || !(5..=80).contains(&rows) {
                        return Err(ClientError::Protocol("端末サイズが許可範囲外です"));
                    }
                    JobControl::Resize { cols, rows }
                }
                job_command::Action::Cancel(cancel) => {
                    if cancel.reason.starts_with("resource_limit:") {
                        JobControl::ResourceLimit
                    } else {
                        JobControl::Cancel
                    }
                }
            };
            active
                .controls
                .send(control)
                .await
                .map_err(|_| ClientError::JobControlClosed)?;
        }
    }
    Ok(())
}

async fn send_heartbeats(
    worker_id: String,
    current_job: Arc<RwLock<Option<String>>>,
    outbound: mpsc::Sender<WorkerMessage>,
) {
    let mut interval = tokio::time::interval(Duration::from_secs(5));
    loop {
        interval.tick().await;
        let message = WorkerMessage {
            payload: Some(worker_message::Payload::Heartbeat(WorkerHeartbeat {
                worker_id: worker_id.clone(),
                job_id: current_job.read().await.clone(),
                unix_time_seconds: unix_now(),
            })),
        };
        if outbound.send(message).await.is_err() {
            break;
        }
    }
}

struct ActiveJob {
    id: String,
    controls: mpsc::Sender<JobControl>,
    handle: JoinHandle<()>,
}

/// WorkerとAPI間の接続を維持できない理由です。
#[derive(Debug, Error)]
pub enum ClientError {
    /// gRPC transportを確立できません。
    #[error("gRPC transport error: {0}")]
    Transport(#[from] tonic::transport::Error),
    /// gRPC streamがエラーを返しました。
    #[error("gRPC status: {0}")]
    Status(#[from] tonic::Status),
    /// APIへ送信するchannelが閉じました。
    #[error("API送信channelが閉じました")]
    OutboundClosed,
    /// APIから契約外のメッセージを受信しました。
    #[error("プロトコル違反: {0}")]
    Protocol(&'static str),
    /// 実行タスクが既に終了して操作を受け取れません。
    #[error("実行タスクの操作channelが閉じました")]
    JobControlClosed,
    /// Worker共有トークンがgRPC metadataに使えません。
    #[error("EXECUTOR_WORKER_TOKENはASCII文字列にしてください")]
    InvalidWorkerToken,
}

async fn send_panic_exit(outbound: &mpsc::Sender<WorkerMessage>, worker_id: &str, job_id: &str) {
    let error = WorkerMessage {
        payload: Some(worker_message::Payload::Event(JobEvent {
            worker_id: worker_id.to_owned(),
            job_id: job_id.to_owned(),
            payload: Some(job_event::Payload::Error(ErrorEvent {
                code: "worker_task_panicked".to_owned(),
                message: "実行Workerのジョブ処理が異常終了しました".to_owned(),
                retryable: true,
            })),
        })),
    };
    let exit = WorkerMessage {
        payload: Some(worker_message::Payload::Event(JobEvent {
            worker_id: worker_id.to_owned(),
            job_id: job_id.to_owned(),
            payload: Some(job_event::Payload::Exit(ExitEvent {
                code: None,
                signal: None,
                reason: ExitReason::InternalError as i32,
            })),
        })),
    };
    let _ = outbound.send(error).await;
    let _ = outbound.send(exit).await;
}

fn unix_now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64
}

#[cfg(test)]
mod tests {
    use executor_protocol::v1::{JobCommand, TerminalResize};

    use super::*;

    #[tokio::test]
    async fn rejects_command_for_different_job() {
        let root = tempfile::tempdir().expect("tempdirを作れます");
        let config = WorkerConfig::for_test(root.path().to_path_buf());
        let (outbound, _) = mpsc::channel(1);
        let (completion, _) = mpsc::channel(1);
        let current_job = Arc::new(RwLock::new(Some("job-a".to_owned())));
        let (controls, _) = mpsc::channel(1);
        let mut active = Some(ActiveJob {
            id: "job-a".to_owned(),
            controls,
            handle: tokio::spawn(async {}),
        });
        let message = ApiMessage {
            payload: Some(api_message::Payload::Command(JobCommand {
                job_id: "job-b".to_owned(),
                action: Some(job_command::Action::Resize(TerminalResize {
                    cols: 100,
                    rows: 30,
                })),
            })),
        };

        let result = handle_api_message(
            &config,
            message,
            &outbound,
            &completion,
            &current_job,
            &mut active,
        )
        .await;
        assert!(matches!(result, Err(ClientError::Protocol(_))));
    }
}
