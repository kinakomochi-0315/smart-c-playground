//! C言語実行セッションを受け付け、隔離Workerへ配送するAPIです。

mod grpc;
mod http;
mod model;
mod state;
mod ticket;

pub mod config;

use std::{error::Error, sync::Arc};

use executor_protocol::v1::executor_control_server::ExecutorControlServer;
use tokio::net::TcpListener;
use tonic::transport::Server;
use tracing::info;

use crate::{config::AppConfig, state::AppState};

/// HTTP/WebSocket APIとWorker向けgRPCを起動します。
pub async fn run(config: AppConfig) -> Result<(), Box<dyn Error + Send + Sync>> {
    let http_addr = config.http_addr;
    let grpc_addr = config.grpc_addr;
    let state = AppState::new(config);

    tokio::spawn(Arc::clone(&state).run_dispatcher());
    tokio::spawn(Arc::clone(&state).run_maintenance());

    let listener = TcpListener::bind(http_addr).await?;
    let http_router = http::router(Arc::clone(&state));
    let grpc_service: ExecutorControlServer<grpc::GrpcService> = grpc::service(Arc::clone(&state));

    info!(%http_addr, "HTTP/WebSocket APIを起動します");
    info!(%grpc_addr, "Worker gRPC APIを起動します");

    let http_task = tokio::spawn(async move {
        axum::serve(listener, http_router)
            .await
            .map_err(|error| error.to_string())
    });
    let grpc_task = tokio::spawn(async move {
        Server::builder()
            .add_service(grpc_service)
            .serve(grpc_addr)
            .await
            .map_err(|error| error.to_string())
    });

    tokio::select! {
        result = http_task => {
            result.map_err(|error| error.to_string())??;
        }
        result = grpc_task => {
            result.map_err(|error| error.to_string())??;
        }
        result = tokio::signal::ctrl_c() => {
            result?;
            info!("終了シグナルを受信しました");
        }
    }
    Ok(())
}
