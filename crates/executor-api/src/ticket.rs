use std::time::{Duration, SystemTime, UNIX_EPOCH};

use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use hmac::{Hmac, Mac};
use rand::{RngCore, rngs::OsRng};
use sha2::Sha256;
use subtle::ConstantTimeEq;
use thiserror::Error;
use uuid::Uuid;

type HmacSha256 = Hmac<Sha256>;

/// WebSocket接続用の短命な署名チケットを発行・検証します。
#[derive(Clone)]
pub struct TicketSigner {
    secret: Vec<u8>,
    ttl: Duration,
}

/// 発行済みチケットと期限です。
#[derive(Debug)]
pub struct IssuedTicket {
    /// Cookieへ格納する文字列です。
    pub value: String,
    /// UNIX秒の有効期限です。
    pub expires_unix: u64,
    /// ISO-8601形式の有効期限です。
    pub expires_at: String,
}

impl TicketSigner {
    /// 署名鍵と有効期間からsignerを作ります。
    pub fn new(secret: Vec<u8>, ttl: Duration) -> Self {
        Self { secret, ttl }
    }

    /// セッション、visitor、接続パスへ紐付いたチケットを発行します。
    pub fn issue(&self, session_id: Uuid, visitor_id: &str, path: &str) -> IssuedTicket {
        let expires_unix = now_unix().saturating_add(self.ttl.as_secs());
        let mut nonce = [0_u8; 24];
        OsRng.fill_bytes(&mut nonce);
        let nonce = URL_SAFE_NO_PAD.encode(nonce);
        let signature = self.sign(session_id, visitor_id, path, expires_unix, &nonce);
        let value = format!(
            "{nonce}.{expires_unix}.{}",
            URL_SAFE_NO_PAD.encode(signature)
        );
        let expires_at = chrono::DateTime::from_timestamp(expires_unix as i64, 0)
            .unwrap_or_default()
            .to_rfc3339();

        IssuedTicket {
            value,
            expires_unix,
            expires_at,
        }
    }

    /// チケットの署名、期限、紐付け情報を検証します。
    pub fn verify(
        &self,
        value: &str,
        session_id: Uuid,
        visitor_id: &str,
        path: &str,
    ) -> Result<(), TicketError> {
        let mut parts = value.split('.');
        let nonce = parts.next().ok_or(TicketError::Malformed)?;
        let expires = parts
            .next()
            .ok_or(TicketError::Malformed)?
            .parse::<u64>()
            .map_err(|_| TicketError::Malformed)?;
        let signature = URL_SAFE_NO_PAD
            .decode(parts.next().ok_or(TicketError::Malformed)?)
            .map_err(|_| TicketError::Malformed)?;

        if parts.next().is_some() || nonce.is_empty() {
            return Err(TicketError::Malformed);
        }
        if expires <= now_unix() {
            return Err(TicketError::Expired);
        }

        let expected = self.sign(session_id, visitor_id, path, expires, nonce);
        if expected.as_slice().ct_eq(signature.as_slice()).into() {
            Ok(())
        } else {
            Err(TicketError::Invalid)
        }
    }

    fn sign(
        &self,
        session_id: Uuid,
        visitor_id: &str,
        path: &str,
        expires: u64,
        nonce: &str,
    ) -> Vec<u8> {
        let mut mac =
            HmacSha256::new_from_slice(&self.secret).expect("HMACは任意長の鍵を受け付けます");
        mac.update(session_id.as_bytes());
        mac.update(b"\n");
        mac.update(visitor_id.as_bytes());
        mac.update(b"\n");
        mac.update(path.as_bytes());
        mac.update(b"\n");
        mac.update(expires.to_string().as_bytes());
        mac.update(b"\n");
        mac.update(nonce.as_bytes());
        mac.finalize().into_bytes().to_vec()
    }
}

/// チケット検証に失敗した理由です。
#[derive(Clone, Copy, Debug, Error, Eq, PartialEq)]
pub enum TicketError {
    /// 文字列形式が不正です。
    #[error("チケット形式が不正です")]
    Malformed,
    /// 有効期限を過ぎています。
    #[error("チケットの有効期限が切れています")]
    Expired,
    /// 署名または紐付け情報が一致しません。
    #[error("チケットの署名が正しくありません")]
    Invalid,
}

fn now_unix() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use super::*;

    #[test]
    fn ticket_is_bound_to_session_visitor_and_path() {
        let signer = TicketSigner::new(b"test-secret".to_vec(), Duration::from_secs(30));
        let session = Uuid::new_v4();
        let path = format!("/ws/executions/{session}");
        let ticket = signer.issue(session, "visitor-a", &path);

        assert!(
            signer
                .verify(&ticket.value, session, "visitor-a", &path)
                .is_ok()
        );
        assert_eq!(
            signer.verify(&ticket.value, session, "visitor-b", &path),
            Err(TicketError::Invalid)
        );
        assert_eq!(
            signer.verify(&ticket.value, Uuid::new_v4(), "visitor-a", &path),
            Err(TicketError::Invalid)
        );
    }

    #[test]
    fn malformed_ticket_is_rejected() {
        let signer = TicketSigner::new(b"test-secret".to_vec(), Duration::from_secs(30));
        assert_eq!(
            signer.verify("invalid", Uuid::new_v4(), "visitor", "/ws"),
            Err(TicketError::Malformed)
        );
    }
}
