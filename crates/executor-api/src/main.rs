use std::{env, net::SocketAddr, time::Duration};

use executor_api::{config::AppConfig, run};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpStream,
};
use tracing_subscriber::EnvFilter;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    if env::args().nth(1).as_deref() == Some("healthcheck") {
        return healthcheck().await;
    }

    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| EnvFilter::new("executor_api=info,tower_http=info")),
        )
        .json()
        .init();

    run(AppConfig::from_env()?).await
}

/// readiness endpointへTCPで問い合わせ、コンテナhealthcheck用の終了状態を返します。
async fn healthcheck() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let address = env::var("EXECUTOR_HEALTHCHECK_ADDR")
        .unwrap_or_else(|_| "127.0.0.1:4000".to_owned())
        .parse::<SocketAddr>()?;
    tokio::time::timeout(Duration::from_secs(2), async move {
        let mut stream = TcpStream::connect(address).await?;
        stream
            .write_all(
                b"GET /internal/health/live HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n",
            )
            .await?;
        let mut response = Vec::with_capacity(512);
        stream.read_to_end(&mut response).await?;
        if response.starts_with(b"HTTP/1.1 200") {
            Ok(())
        } else {
            Err(std::io::Error::other("executor-api is not ready"))
        }
    })
    .await
    .map_err(|_| std::io::Error::other("healthcheck timed out"))??;
    Ok(())
}
