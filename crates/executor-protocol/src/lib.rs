//! Rust実行APIとWorkerの間で共有するgRPC契約です。

/// protobufから生成した実行プロトコルです。
pub mod v1 {
    tonic::include_proto!("smartc.executor.v1");
}
