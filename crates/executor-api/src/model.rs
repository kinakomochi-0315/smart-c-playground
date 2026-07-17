use std::fmt;

use axum::{
    Json,
    http::StatusCode,
    response::{IntoResponse, Response},
};
use serde::{Deserialize, Serialize};

/// 実行作成APIの入力です。
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CreateExecutionRequest {
    /// コンパイルするC言語ソースです。
    pub source: String,
    /// 初期PTYサイズです。
    pub terminal: TerminalSize,
    /// BFFが発行した匿名visitor識別子です。
    pub visitor_id: String,
    /// BFFが正規化した接続元IPです。
    pub client_ip: String,
}

/// PTYの表示サイズです。
#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct TerminalSize {
    /// 桁数です。
    pub cols: u16,
    /// 行数です。
    pub rows: u16,
}

/// 実行作成APIの応答です。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateExecutionResponse {
    /// 実行セッションIDです。
    pub id: String,
    /// Caddy経由で接続するWebSocketパスです。
    pub web_socket_path: String,
    /// WebSocket接続チケットの有効期限です。
    pub expires_at: String,
    /// BFFがHttpOnly Cookieへ格納する一回限りのチケットです。
    pub ticket: String,
}

/// ブラウザから受け取る制御メッセージです。
#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub enum ClientControl {
    /// PTYサイズを変更します。
    Resize {
        /// 桁数です。
        cols: u16,
        /// 行数です。
        rows: u16,
    },
    /// 実行を明示的に停止します。
    Terminate,
    /// アプリケーションレベルの疎通確認です。
    Ping {
        /// 応答との対応を確認する短い識別子です。
        nonce: String,
    },
}

/// ブラウザへ送るテキストメッセージです。
#[derive(Clone, Debug, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ServerMessage {
    /// WebSocket接続直後にプロトコル情報を通知します。
    Hello {
        /// 現在のプロトコル版です。
        protocol: u8,
        /// 接続した実行セッションIDです。
        #[serde(rename = "sessionId")]
        session_id: String,
    },
    /// 実行フェーズが変化しました。
    Phase {
        /// 現在のフェーズです。
        phase: ExecutionPhase,
        /// queued時だけ通知する待機位置です。
        #[serde(skip_serializing_if = "Option::is_none")]
        position: Option<usize>,
    },
    /// コンパイラの診断出力です。
    CompilerOutput {
        /// stdoutまたはstderrです。
        stream: OutputStream,
        /// UTF-8へ損失変換した診断です。
        data: String,
    },
    /// プロセスが終了しました。
    Exit {
        /// 終了コードです。
        code: Option<i32>,
        /// シグナル番号です。
        signal: Option<i32>,
        /// 終了理由です。
        reason: ExitReason,
    },
    /// 継続不能なエラーです。
    Error {
        /// クライアントで分岐できる安定したコードです。
        code: String,
        /// 日本語の表示メッセージです。
        message: String,
        /// 再試行可能かどうかです。
        retryable: bool,
    },
    /// Pingへの応答です。
    Pong {
        /// Pingで受け取った識別子です。
        nonce: String,
    },
}

/// 実行フェーズです。
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ExecutionPhase {
    /// Worker割当を待っています。
    Queued,
    /// コンパイル中です。
    Compiling,
    /// コンパイルに失敗しました。
    CompileFailed,
    /// PTY上で実行中です。
    Running,
    /// 正常または非0コードで終了しました。
    Exited,
    /// 時間制限で終了しました。
    TimedOut,
    /// 資源または出力量の制限で終了しました。
    ResourceLimited,
    /// 利用者操作または切断で中止しました。
    Cancelled,
    /// サンドボックス違反で終了しました。
    SandboxViolation,
}

/// コンパイラ出力の種別です。
#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum OutputStream {
    /// 標準出力です。
    Stdout,
    /// 標準エラー出力です。
    Stderr,
}

/// 実行終了理由です。
#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ExitReason {
    /// プログラムが終了しました。
    Completed,
    /// コンパイルに失敗しました。
    CompileFailed,
    /// wall/CPU時間を超過しました。
    TimedOut,
    /// メモリ、PID、ファイルまたは出力量を超過しました。
    ResourceLimited,
    /// 利用者操作または切断で中止しました。
    Cancelled,
    /// 禁止syscallなどを検出しました。
    SandboxViolation,
    /// 実行基盤内部で失敗しました。
    InternalError,
}

/// RFC 9457風のAPIエラー応答です。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Problem {
    /// 問題種別を表す安定したURIです。
    pub r#type: String,
    /// 問題の短い名称です。
    pub title: String,
    /// HTTPステータスです。
    pub status: u16,
    /// 利用者向けの説明です。
    pub detail: String,
}

/// ハンドラから返すAPIエラーです。
#[derive(Debug)]
pub struct ApiError {
    status: StatusCode,
    code: &'static str,
    detail: String,
}

impl ApiError {
    /// 400 Bad Requestを生成します。
    pub fn bad_request(code: &'static str, detail: impl Into<String>) -> Self {
        Self::new(StatusCode::BAD_REQUEST, code, detail)
    }

    /// 401 Unauthorizedを生成します。
    pub fn unauthorized() -> Self {
        Self::new(
            StatusCode::UNAUTHORIZED,
            "unauthorized",
            "内部APIトークンが正しくありません",
        )
    }

    /// 404 Not Foundを生成します。
    pub fn not_found() -> Self {
        Self::new(
            StatusCode::NOT_FOUND,
            "execution_not_found",
            "実行セッションが見つかりません",
        )
    }

    /// 409 Conflictを生成します。
    pub fn conflict(code: &'static str, detail: impl Into<String>) -> Self {
        Self::new(StatusCode::CONFLICT, code, detail)
    }

    /// 413 Content Too Largeを生成します。
    pub fn too_large(detail: impl Into<String>) -> Self {
        Self::new(StatusCode::PAYLOAD_TOO_LARGE, "source_too_large", detail)
    }

    /// 429 Too Many Requestsを生成します。
    pub fn too_many_requests(code: &'static str, detail: impl Into<String>) -> Self {
        Self::new(StatusCode::TOO_MANY_REQUESTS, code, detail)
    }

    /// 503 Service Unavailableを生成します。
    pub fn unavailable(code: &'static str, detail: impl Into<String>) -> Self {
        Self::new(StatusCode::SERVICE_UNAVAILABLE, code, detail)
    }

    fn new(status: StatusCode, code: &'static str, detail: impl Into<String>) -> Self {
        Self {
            status,
            code,
            detail: detail.into(),
        }
    }
}

impl fmt::Display for ApiError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{}: {}", self.code, self.detail)
    }
}

impl std::error::Error for ApiError {}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let title = self
            .code
            .split('_')
            .map(|part| {
                let mut chars = part.chars();
                match chars.next() {
                    Some(first) => first.to_uppercase().collect::<String>() + chars.as_str(),
                    None => String::new(),
                }
            })
            .collect::<Vec<_>>()
            .join(" ");
        let problem = Problem {
            r#type: format!("https://smart-c.invalid/problems/{}", self.code),
            title,
            status: self.status.as_u16(),
            detail: self.detail,
        };
        (
            self.status,
            [("content-type", "application/problem+json")],
            Json(problem),
        )
            .into_response()
    }
}

#[cfg(test)]
mod tests {
    use super::ServerMessage;

    #[test]
    fn hello_uses_browser_contract_field_name() {
        let message = ServerMessage::Hello {
            protocol: 1,
            session_id: "session-id".to_owned(),
        };
        let json = serde_json::to_value(message).expect("helloをJSON化できます");

        assert_eq!(json["type"], "hello");
        assert_eq!(json["sessionId"], "session-id");
        assert!(json.get("session_id").is_none());
    }
}
