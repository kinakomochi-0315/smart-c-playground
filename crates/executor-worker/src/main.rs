use std::env;

use executor_worker::{config::WorkerConfig, run_worker, sandbox_smoke_test};
use tracing::info;
use tracing_subscriber::EnvFilter;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| EnvFilter::new("executor_worker=info")),
        )
        .json()
        .init();

    let config = WorkerConfig::from_env()?;
    if env::args().nth(1).as_deref() == Some("sandbox-smoke-test") {
        sandbox_smoke_test(config).await?;
        return Ok(());
    }
    if config.require_startup_smoke {
        info!("API登録前のNsJail sandbox smoke testを開始します");
        sandbox_smoke_test(config.clone()).await?;
        info!("NsJail sandbox smoke testが成功しました");
    }
    tokio::select! {
        result = run_worker(config) => result?,
        result = tokio::signal::ctrl_c() => result?,
    }
    Ok(())
}
