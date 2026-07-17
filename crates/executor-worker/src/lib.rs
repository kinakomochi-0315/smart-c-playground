//! C言語ソースを隔離環境でコンパイルし、PTY上で対話実行するWorkerです。

mod backend;
mod client;
mod execution;
mod smoke;

pub mod config;

pub use client::run_worker;
pub use smoke::sandbox_smoke_test;
