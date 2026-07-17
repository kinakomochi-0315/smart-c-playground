fn main() -> Result<(), Box<dyn std::error::Error>> {
    let protoc = protoc_bin_vendored::protoc_bin_path()?;

    // 開発端末へprotocの事前インストールを要求しないため、ビルド時だけvendored版を使います。
    unsafe {
        std::env::set_var("PROTOC", protoc);
    }

    tonic_build::configure()
        .build_server(true)
        .build_client(true)
        .compile_protos(&["proto/executor.proto"], &["proto"])?;

    println!("cargo:rerun-if-changed=proto/executor.proto");
    Ok(())
}
