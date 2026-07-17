use std::{
    env,
    net::{IpAddr, Ipv4Addr, SocketAddr},
    time::Duration,
};

use http::Uri;
use thiserror::Error;

/// executor-apiの起動設定です。
#[derive(Clone, Debug)]
pub struct AppConfig {
    /// ブラウザ向けHTTP/WebSocketの待受先です。
    pub http_addr: SocketAddr,
    /// Worker向けgRPCの待受先です。
    pub grpc_addr: SocketAddr,
    /// Next.js BFFだけが知る内部APIトークンです。
    pub internal_token: String,
    /// Worker gRPC接続だけが知る共有トークンです。
    pub worker_token: String,
    /// WebSocket Upgradeを許可する公開Web Originです。
    pub web_origin: String,
    /// 実行チケットへ署名する秘密鍵です。
    pub ticket_secret: Vec<u8>,
    /// WebSocket接続チケットの有効期間です。
    pub ticket_ttl: Duration,
    /// 待機できるジョブ数です。
    pub queue_capacity: usize,
    /// WebSocket接続待ちを含む全セッション保持上限です。
    pub session_capacity: usize,
    /// 同時に実行できるジョブ数です。
    pub global_concurrency: usize,
    /// visitor単位の同時ジョブ数です。
    pub visitor_concurrency: usize,
    /// IP単位の同時ジョブ数です。
    pub ip_concurrency: usize,
    /// Workerを異常とみなすまでの期間です。
    pub worker_stale_after: Duration,
    /// readiness成立に必要な正常Worker数です。
    pub minimum_ready_workers: usize,
    /// 登録WorkerへNsJailを必須化するかどうかです。
    pub require_nsjail_workers: bool,
}

impl AppConfig {
    /// 環境変数から設定を読み込みます。
    pub fn from_env() -> Result<Self, ConfigError> {
        let environment = env::var("SMART_C_ENV").unwrap_or_else(|_| "development".to_owned());
        let internal_token = required_or_development_default(
            "EXECUTOR_INTERNAL_TOKEN",
            &environment,
            "development-internal-token",
        )?;
        let worker_token = required_or_development_default(
            "EXECUTOR_WORKER_TOKEN",
            &environment,
            "development-worker-token",
        )?;
        let ticket_secret = required_or_development_default(
            "EXECUTOR_TICKET_SECRET",
            &environment,
            "development-ticket-secret-change-me",
        )?
        .into_bytes();
        let web_origin =
            required_or_development_default("WEB_ORIGIN", &environment, "http://localhost:8080")?;
        if !is_valid_web_origin(&web_origin) {
            return Err(ConfigError::InvalidWebOrigin(web_origin));
        }

        for (name, value) in [
            ("EXECUTOR_INTERNAL_TOKEN", internal_token.as_str()),
            ("EXECUTOR_WORKER_TOKEN", worker_token.as_str()),
        ] {
            if !is_visible_ascii(value) {
                return Err(ConfigError::InvalidHeaderSecret(name));
            }
        }
        if environment == "production" {
            for (name, length) in [
                ("EXECUTOR_INTERNAL_TOKEN", internal_token.len()),
                ("EXECUTOR_WORKER_TOKEN", worker_token.len()),
                ("EXECUTOR_TICKET_SECRET", ticket_secret.len()),
            ] {
                if length < 32 {
                    return Err(ConfigError::WeakSecret(name));
                }
            }
        }

        let global_concurrency = positive_usize("EXECUTOR_MAX_ACTIVE", 4)?;
        let minimum_ready_workers = positive_usize(
            "EXECUTOR_MIN_READY_WORKERS",
            if environment == "production" {
                global_concurrency
            } else {
                1
            },
        )?;

        Ok(Self {
            http_addr: parse_addr("EXECUTOR_HTTP_ADDR", 4000)?,
            grpc_addr: parse_addr("EXECUTOR_GRPC_ADDR", 50051)?,
            internal_token,
            worker_token,
            web_origin,
            ticket_secret,
            ticket_ttl: Duration::from_secs(30),
            queue_capacity: positive_usize("EXECUTOR_MAX_QUEUE", 16)?,
            session_capacity: positive_usize("EXECUTOR_MAX_SESSIONS", 32)?,
            global_concurrency,
            visitor_concurrency: positive_usize("EXECUTOR_MAX_PER_VISITOR", 1)?,
            ip_concurrency: positive_usize("EXECUTOR_MAX_PER_IP", 2)?,
            worker_stale_after: Duration::from_secs(15),
            minimum_ready_workers,
            require_nsjail_workers: environment == "production",
        })
    }

    /// 単体テスト向けの安全な固定設定を返します。
    #[cfg(test)]
    pub fn for_test() -> Self {
        Self {
            http_addr: SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 4000),
            grpc_addr: SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 50051),
            internal_token: "test-internal-token".to_owned(),
            worker_token: "test-worker-token".to_owned(),
            web_origin: "http://localhost:8080".to_owned(),
            ticket_secret: b"test-ticket-secret-at-least-32-bytes".to_vec(),
            ticket_ttl: Duration::from_secs(30),
            queue_capacity: 16,
            session_capacity: 32,
            global_concurrency: 4,
            visitor_concurrency: 1,
            ip_concurrency: 2,
            worker_stale_after: Duration::from_secs(15),
            minimum_ready_workers: 1,
            require_nsjail_workers: false,
        }
    }
}

/// 設定の読み込みに失敗した理由です。
#[derive(Debug, Error)]
pub enum ConfigError {
    /// 必須の環境変数がありません。
    #[error("本番環境では環境変数 {0} が必須です")]
    Missing(&'static str),
    /// 待受アドレスの形式が不正です。
    #[error("環境変数 {name} のアドレスが不正です: {value}")]
    InvalidAddress {
        /// 環境変数名です。
        name: &'static str,
        /// 不正だった値です。
        value: String,
    },
    /// 本番用秘密情報が短すぎます。
    #[error("productionでは {0} を32バイト以上にしてください")]
    WeakSecret(&'static str),
    /// HTTP/gRPC metadataに格納できない秘密情報です。
    #[error("{0} は空白や制御文字を含まないASCII文字列にしてください")]
    InvalidHeaderSecret(&'static str),
    /// Web Originが完全一致検証に使えない形式です。
    #[error("WEB_ORIGIN は末尾スラッシュなしのhttp(s) Originにしてください: {0}")]
    InvalidWebOrigin(String),
    /// 正整数の環境変数が不正です。
    #[error("環境変数 {name} は正整数にしてください: {value}")]
    InvalidPositiveInteger {
        /// 環境変数名です。
        name: &'static str,
        /// 不正だった値です。
        value: String,
    },
}

fn required_or_development_default(
    name: &'static str,
    environment: &str,
    default: &str,
) -> Result<String, ConfigError> {
    match env::var(name) {
        Ok(value) if !value.is_empty() => Ok(value),
        _ if environment == "production" => Err(ConfigError::Missing(name)),
        _ => Ok(default.to_owned()),
    }
}

fn parse_addr(name: &'static str, default_port: u16) -> Result<SocketAddr, ConfigError> {
    let default = SocketAddr::new(IpAddr::V4(Ipv4Addr::UNSPECIFIED), default_port);
    match env::var(name) {
        Ok(value) => value
            .parse()
            .map_err(|_| ConfigError::InvalidAddress { name, value }),
        Err(_) => Ok(default),
    }
}

fn positive_usize(name: &'static str, default: usize) -> Result<usize, ConfigError> {
    match env::var(name) {
        Ok(value) => value
            .parse::<usize>()
            .ok()
            .filter(|parsed| *parsed > 0)
            .ok_or(ConfigError::InvalidPositiveInteger { name, value }),
        Err(_) => Ok(default),
    }
}

/// 完全一致のOrigin検証へ安全に使えるhttp(s) URLか確認します。
fn is_valid_web_origin(value: &str) -> bool {
    let Ok(uri) = value.parse::<Uri>() else {
        return false;
    };
    let Some(scheme) = uri.scheme_str() else {
        return false;
    };
    let Some(authority) = uri.authority() else {
        return false;
    };
    matches!(scheme, "http" | "https")
        && !authority.as_str().contains('@')
        && value == format!("{scheme}://{authority}")
}

/// HTTP headerとgRPC metadataの両方で安全な文字列か確認します。
fn is_visible_ascii(value: &str) -> bool {
    !value.is_empty() && value.bytes().all(|byte| (0x21..=0x7e).contains(&byte))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_exact_http_origins() {
        assert!(is_valid_web_origin("http://localhost:8080"));
        assert!(is_valid_web_origin("https://example.com"));
        assert!(is_valid_web_origin("https://[::1]:8443"));
    }

    #[test]
    fn rejects_origins_with_extra_url_components() {
        for value in [
            "https://example.com/",
            "https://example.com/path",
            "https://example.com?query=1",
            "ftp://example.com",
            "https://user@example.com",
            "example.com",
        ] {
            assert!(!is_valid_web_origin(value), "{value}");
        }
    }

    #[test]
    fn validates_header_secret_characters() {
        assert!(is_visible_ascii("valid-token_123"));
        assert!(!is_visible_ascii(""));
        assert!(!is_visible_ascii("contains space"));
        assert!(!is_visible_ascii("contains\nnewline"));
        assert!(!is_visible_ascii("日本語"));
    }
}
