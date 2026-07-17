use std::{sync::Arc, time::Instant};

use axum::{
    Json, Router,
    extract::{
        DefaultBodyLimit, Path, State,
        rejection::JsonRejection,
        ws::{Message, WebSocket, WebSocketUpgrade},
    },
    http::{HeaderMap, StatusCode, header},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use futures_util::{SinkExt, StreamExt};
use serde::Serialize;
use subtle::ConstantTimeEq;
use tracing::warn;
use uuid::Uuid;

use crate::{
    model::{
        ApiError, ClientControl, CreateExecutionRequest, CreateExecutionResponse, ServerMessage,
    },
    state::{AppState, BrowserEvent, Session},
};

const EXECUTION_COOKIE: &str = "smart_c_exec_ticket";
const CLIENT_MESSAGE_BURST: f64 = 32.0;
const CLIENT_MESSAGES_PER_SECOND: f64 = 16.0;

/// HTTP/WebSocketルーターを構築します。
pub(crate) fn router(state: Arc<AppState>) -> Router {
    Router::new()
        .route("/internal/executions", post(create_execution))
        .route("/ws/executions/{id}", get(execution_websocket))
        .route("/internal/health/live", get(liveness))
        .route("/internal/health/ready", get(readiness))
        .route("/api/health", get(readiness))
        .route("/metrics", get(metrics))
        .layer(DefaultBodyLimit::max(512 * 1024))
        .with_state(state)
}

async fn create_execution(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    payload: Result<Json<CreateExecutionRequest>, JsonRejection>,
) -> Result<impl IntoResponse, ApiError> {
    authorize_internal(&headers, state.internal_token())?;
    let Json(request) = payload.map_err(|error| {
        ApiError::bad_request("invalid_json", format!("JSONが不正です: {error}"))
    })?;
    let (session, ticket) = state.create_execution(request).await?;
    Ok((
        StatusCode::CREATED,
        Json(CreateExecutionResponse {
            id: session.id.to_string(),
            web_socket_path: session.path.clone(),
            expires_at: ticket.expires_at,
            ticket: ticket.value,
        }),
    ))
}

async fn execution_websocket(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    headers: HeaderMap,
    websocket: WebSocketUpgrade,
) -> Result<Response, ApiError> {
    let id = Uuid::parse_str(&id).map_err(|_| ApiError::not_found())?;
    authorize_origin(&headers, state.web_origin())?;
    let session = state.session(id).await.ok_or_else(ApiError::not_found)?;
    let ticket = cookie_value(&headers, EXECUTION_COOKIE).ok_or_else(ApiError::unauthorized)?;
    state.consume_ticket(&session, ticket).await?;

    Ok(websocket
        .max_frame_size(8 * 1024)
        .max_message_size(8 * 1024)
        .on_upgrade(move |socket| websocket_session(state, session, socket)))
}

async fn websocket_session(state: Arc<AppState>, session: Arc<Session>, socket: WebSocket) {
    let mut events = session.events.subscribe();
    let (mut sender, mut receiver) = socket.split();
    let mut message_rate = ClientMessageRateLimiter::new();
    let mut terminal_action_sent = false;
    let hello = ServerMessage::Hello {
        protocol: 1,
        session_id: session.id.to_string(),
    };
    if send_text(&mut sender, &hello).await.is_err() {
        let _ = state
            .cancel_execution(&session, "websocket_disconnected")
            .await;
        return;
    }
    let snapshot = state.phase_snapshot(&session).await;
    if send_text(&mut sender, &snapshot).await.is_err() {
        let _ = state
            .cancel_execution(&session, "websocket_disconnected")
            .await;
        return;
    }
    if let Err(error) = state.activate_session(&session).await {
        let message = ServerMessage::Error {
            code: "execution_activation_failed".to_owned(),
            message: error.to_string(),
            retryable: true,
        };
        let _ = send_text(&mut sender, &message).await;
        let _ = state.cancel_execution(&session, "activation_failed").await;
        return;
    }

    loop {
        tokio::select! {
            event = events.recv() => {
                let event = match event {
                    Ok(event) => event,
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {
                        let message = ServerMessage::Error {
                            code: "client_too_slow".to_owned(),
                            message: "端末出力の受信が追いつかなかったため実行を停止しました".to_owned(),
                            retryable: true,
                        };
                        let _ = send_text(&mut sender, &message).await;
                        let _ = state.cancel_execution(&session, "client_too_slow").await;
                        break;
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                };
                let closes_socket = event.closes_socket();
                let result = match event {
                    BrowserEvent::Text(message) => send_text(&mut sender, &message).await,
                    BrowserEvent::Binary(data) => sender.send(Message::Binary(data)).await,
                };
                if result.is_err() || closes_socket {
                    break;
                }
            }
            incoming = receiver.next() => {
                let Some(incoming) = incoming else {
                    break;
                };
                let message = match incoming {
                    Ok(message) => message,
                    Err(error) => {
                        warn!(execution_id = %session.id, %error, "WebSocket受信に失敗しました");
                        break;
                    }
                };
                if !message_rate.allow() {
                    let message = ServerMessage::Error {
                        code: "client_message_rate_exceeded".to_owned(),
                        message: "端末への入力頻度が上限を超えたため実行を停止しました".to_owned(),
                        retryable: true,
                    };
                    let _ = send_text(&mut sender, &message).await;
                    terminal_action_sent = state
                        .resource_limit_execution(&session, "client_message_rate")
                        .await
                        .is_ok();
                    break;
                }
                let result = handle_client_message(&state, &session, &mut sender, message).await;
                if let Err(error) = result {
                    let message = ServerMessage::Error {
                        code: "invalid_client_message".to_owned(),
                        message: error.to_string(),
                        retryable: false,
                    };
                    if send_text(&mut sender, &message).await.is_err() {
                        break;
                    }
                }
            }
        }
    }

    if !terminal_action_sent {
        let _ = state
            .cancel_execution(&session, "websocket_disconnected")
            .await;
    }
}

async fn handle_client_message<S>(
    state: &Arc<AppState>,
    session: &Arc<Session>,
    sender: &mut S,
    message: Message,
) -> Result<(), ApiError>
where
    S: futures_util::Sink<Message, Error = axum::Error> + Unpin,
{
    match message {
        Message::Binary(data) => state.send_stdin(session, data).await,
        Message::Text(text) => {
            if text.len() > 4 * 1024 {
                return Err(ApiError::too_large(
                    "制御メッセージは4KiB以下にしてください",
                ));
            }
            let control = serde_json::from_str::<ClientControl>(&text).map_err(|error| {
                ApiError::bad_request(
                    "invalid_control_message",
                    format!("制御メッセージが不正です: {error}"),
                )
            })?;
            match control {
                ClientControl::Resize { cols, rows } => state.resize(session, cols, rows).await,
                ClientControl::Terminate => {
                    state.cancel_execution(session, "user_terminated").await
                }
                ClientControl::Ping { nonce } => {
                    if nonce.len() > 128 {
                        return Err(ApiError::bad_request(
                            "ping_nonce_invalid",
                            "ping nonceは128文字以下にしてください",
                        ));
                    }
                    send_text(sender, &ServerMessage::Pong { nonce })
                        .await
                        .map_err(|_| {
                            ApiError::unavailable(
                                "websocket_send_failed",
                                "WebSocketへ応答できません",
                            )
                        })
                }
            }
        }
        Message::Ping(data) => sender.send(Message::Pong(data)).await.map_err(|_| {
            ApiError::unavailable("websocket_send_failed", "WebSocketへ応答できません")
        }),
        Message::Pong(_) => Ok(()),
        Message::Close(_) => Err(ApiError::conflict(
            "websocket_closed",
            "WebSocketが閉じられました",
        )),
    }
}

async fn send_text<S>(sender: &mut S, message: &ServerMessage) -> Result<(), axum::Error>
where
    S: futures_util::Sink<Message, Error = axum::Error> + Unpin,
{
    let json = serde_json::to_string(message).expect("ServerMessageはJSON化できます");
    sender.send(Message::Text(json.into())).await
}

async fn liveness() -> impl IntoResponse {
    Json(Health {
        status: "ok",
        workers_ready: None,
    })
}

async fn readiness(State(state): State<Arc<AppState>>) -> Response {
    let ready = state.is_ready().await;
    (
        if ready {
            StatusCode::OK
        } else {
            StatusCode::SERVICE_UNAVAILABLE
        },
        Json(Health {
            status: if ready { "ok" } else { "unavailable" },
            workers_ready: Some(ready),
        }),
    )
        .into_response()
}

async fn metrics(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    (
        [(
            header::CONTENT_TYPE,
            "text/plain; version=0.0.4; charset=utf-8",
        )],
        state.render_metrics().await,
    )
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Health {
    status: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    workers_ready: Option<bool>,
}

/// WebSocket単位で短時間のframe floodを止めるtoken bucketです。
struct ClientMessageRateLimiter {
    tokens: f64,
    last_refill: Instant,
}

impl ClientMessageRateLimiter {
    /// burst上限までtokenが入った状態で作ります。
    fn new() -> Self {
        Self {
            tokens: CLIENT_MESSAGE_BURST,
            last_refill: Instant::now(),
        }
    }

    /// 現在時刻までtokenを補充し、1 message分を消費できるか返します。
    fn allow(&mut self) -> bool {
        self.allow_at(Instant::now())
    }

    /// 指定時刻までtokenを補充するテスト可能な判定処理です。
    fn allow_at(&mut self, now: Instant) -> bool {
        let elapsed = now.saturating_duration_since(self.last_refill);
        self.tokens = (self.tokens + elapsed.as_secs_f64() * CLIENT_MESSAGES_PER_SECOND)
            .min(CLIENT_MESSAGE_BURST);
        self.last_refill = now;
        if self.tokens < 1.0 {
            return false;
        }
        self.tokens -= 1.0;
        true
    }
}

fn authorize_internal(headers: &HeaderMap, expected: &str) -> Result<(), ApiError> {
    let supplied = headers
        .get("x-internal-token")
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default();
    if bool::from(supplied.as_bytes().ct_eq(expected.as_bytes())) {
        Ok(())
    } else {
        Err(ApiError::unauthorized())
    }
}

fn authorize_origin(headers: &HeaderMap, expected: &str) -> Result<(), ApiError> {
    let supplied = headers
        .get(header::ORIGIN)
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default();
    if bool::from(supplied.as_bytes().ct_eq(expected.as_bytes())) {
        Ok(())
    } else {
        Err(ApiError::unauthorized())
    }
}

fn cookie_value<'a>(headers: &'a HeaderMap, name: &str) -> Option<&'a str> {
    headers
        .get(header::COOKIE)?
        .to_str()
        .ok()?
        .split(';')
        .filter_map(|part| part.trim().split_once('='))
        .find_map(|(key, value)| (key == name).then_some(value))
}

#[cfg(test)]
mod tests {
    use axum::body::Body;
    use http::{Request, StatusCode};
    use http_body_util::BodyExt;
    use tower::ServiceExt;

    use super::*;
    use crate::config::AppConfig;

    #[tokio::test]
    async fn internal_create_requires_token_and_returns_ticket() {
        let app = router(AppState::new(AppConfig::for_test()));
        let body = serde_json::json!({
            "source": "int main(void) { return 0; }",
            "terminal": { "cols": 100, "rows": 30 },
            "visitorId": "visitor",
            "clientIp": "192.0.2.1"
        });
        let request = Request::builder()
            .method("POST")
            .uri("/internal/executions")
            .header("content-type", "application/json")
            .header("x-internal-token", "test-internal-token")
            .body(Body::from(body.to_string()))
            .expect("requestを作れます");

        let response = app.oneshot(request).await.expect("応答を取得できます");
        assert_eq!(response.status(), StatusCode::CREATED);
        let bytes = response
            .into_body()
            .collect()
            .await
            .expect("bodyを読めます")
            .to_bytes();
        let json: serde_json::Value = serde_json::from_slice(&bytes).expect("JSON応答です");
        assert!(
            json["webSocketPath"]
                .as_str()
                .expect("pathがあります")
                .starts_with("/ws/executions/")
        );
        assert!(
            !json["ticket"]
                .as_str()
                .expect("ticketがあります")
                .is_empty()
        );
    }

    #[tokio::test]
    async fn internal_create_rejects_wrong_token() {
        let app = router(AppState::new(AppConfig::for_test()));
        let request = Request::builder()
            .method("POST")
            .uri("/internal/executions")
            .header("content-type", "application/json")
            .body(Body::from("{}"))
            .expect("requestを作れます");

        let response = app.oneshot(request).await.expect("応答を取得できます");
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    }

    #[test]
    fn websocket_origin_must_match_exactly() {
        let mut headers = HeaderMap::new();
        headers.insert(
            header::ORIGIN,
            "http://localhost:8080".parse().expect("Originを作れます"),
        );
        assert!(authorize_origin(&headers, "http://localhost:8080").is_ok());
        assert!(authorize_origin(&headers, "https://localhost:8080").is_err());
    }

    #[test]
    fn websocket_message_flood_exhausts_burst_and_recovers_by_rate() {
        let started = Instant::now();
        let mut limiter = ClientMessageRateLimiter {
            tokens: CLIENT_MESSAGE_BURST,
            last_refill: started,
        };
        for _ in 0..CLIENT_MESSAGE_BURST as usize {
            assert!(limiter.allow_at(started));
        }
        assert!(!limiter.allow_at(started));
        assert!(limiter.allow_at(started + std::time::Duration::from_millis(63)));
    }
}
