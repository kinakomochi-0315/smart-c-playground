use std::{pin::Pin, sync::Arc};

use executor_protocol::v1::{
    ApiMessage, WorkerMessage,
    executor_control_server::{ExecutorControl, ExecutorControlServer},
    worker_message,
};
use futures_util::Stream;
use subtle::ConstantTimeEq;
use tokio::sync::mpsc;
use tokio_stream::wrappers::ReceiverStream;
use tonic::{Request, Response, Status, Streaming};
use tracing::{info, warn};

use crate::state::AppState;

/// Worker向けgRPCサービスを生成します。
pub(crate) fn service(state: Arc<AppState>) -> ExecutorControlServer<GrpcService> {
    ExecutorControlServer::new(GrpcService { state })
}

/// Workerの双方向streamを受け持つgRPC実装です。
pub(crate) struct GrpcService {
    state: Arc<AppState>,
}

#[tonic::async_trait]
impl ExecutorControl for GrpcService {
    type WorkStream = Pin<Box<dyn Stream<Item = Result<ApiMessage, Status>> + Send + 'static>>;

    async fn work(
        &self,
        request: Request<Streaming<WorkerMessage>>,
    ) -> Result<Response<Self::WorkStream>, Status> {
        if !authorize_worker(&request, self.state.worker_token()) {
            return Err(Status::unauthenticated(
                "Worker共有トークンが正しくありません",
            ));
        }
        let mut inbound = request.into_inner();
        let first = tokio::time::timeout(std::time::Duration::from_secs(5), inbound.message())
            .await
            .map_err(|_| Status::deadline_exceeded("Worker登録が時間内に届きませんでした"))??
            .ok_or_else(|| Status::invalid_argument("Worker登録がありません"))?;
        let registration = match first.payload {
            Some(worker_message::Payload::Registration(registration)) => registration,
            _ => {
                return Err(Status::failed_precondition(
                    "最初のメッセージはWorker登録にしてください",
                ));
            }
        };
        let worker_id = registration.worker_id.clone();
        let (sender, receiver) = mpsc::channel(64);
        let connection_id = self
            .state
            .register_worker(
                worker_id.clone(),
                registration.architecture.clone(),
                registration.backend.clone(),
                sender,
            )
            .await?;
        info!(
            worker_id,
            architecture = registration.architecture,
            backend = registration.backend,
            "Workerが接続しました"
        );

        let state = Arc::clone(&self.state);
        tokio::spawn(async move {
            process_worker_stream(&state, &worker_id, connection_id, &mut inbound).await;
            state
                .unregister_worker(
                    &worker_id,
                    connection_id,
                    "実行WorkerとのgRPC接続が切断されました",
                )
                .await;
            info!(worker_id, "Worker接続を削除しました");
        });

        Ok(Response::new(Box::pin(ReceiverStream::new(receiver))))
    }
}

fn authorize_worker<T>(request: &Request<T>, expected: &str) -> bool {
    let supplied = request
        .metadata()
        .get("x-worker-token")
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default();
    bool::from(supplied.as_bytes().ct_eq(expected.as_bytes()))
}

async fn process_worker_stream(
    state: &Arc<AppState>,
    worker_id: &str,
    connection_id: uuid::Uuid,
    inbound: &mut Streaming<WorkerMessage>,
) {
    loop {
        let message = match inbound.message().await {
            Ok(Some(message)) => message,
            Ok(None) => break,
            Err(error) => {
                warn!(worker_id, %error, "Worker streamの受信に失敗しました");
                break;
            }
        };
        let result = match message.payload {
            Some(worker_message::Payload::Registration(_)) => Err(Status::failed_precondition(
                "Worker登録は一度だけ送信できます",
            )),
            Some(worker_message::Payload::Heartbeat(heartbeat)) => {
                if heartbeat.worker_id != worker_id {
                    Err(Status::permission_denied("worker_idが接続と一致しません"))
                } else {
                    state
                        .heartbeat(worker_id, connection_id, heartbeat.job_id.as_deref())
                        .await
                }
            }
            Some(worker_message::Payload::Event(event)) => {
                if event.worker_id != worker_id {
                    Err(Status::permission_denied("worker_idが接続と一致しません"))
                } else {
                    state.handle_worker_event(connection_id, event).await
                }
            }
            None => Err(Status::invalid_argument("メッセージ内容がありません")),
        };
        if let Err(error) = result {
            warn!(worker_id, %error, "Workerメッセージを拒否しました");
            if matches!(
                error.code(),
                tonic::Code::PermissionDenied | tonic::Code::FailedPrecondition
            ) {
                break;
            }
        }
    }
}
