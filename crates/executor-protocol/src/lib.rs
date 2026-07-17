//! Rust実行APIとWorkerの間で共有するgRPC契約です。

/// protobufから生成した実行プロトコルです。
pub mod v1 {
    tonic::include_proto!("smartc.executor.v1");
}

/// 1プロジェクトで許可する最大ファイル数です。
pub const SOURCE_FILE_MAX_COUNT: usize = 16;
/// ファイル名の最大バイト数です。
pub const SOURCE_FILE_NAME_MAX_BYTES: usize = 64;
/// 全ファイル内容の合計上限です。
pub const SOURCE_FILES_MAX_BYTES: usize = 64 * 1024;

/// ファイル名が同一階層のCソースまたはヘッダーとして安全か検証します。
pub fn is_valid_source_file_name(name: &str) -> bool {
    if name.len() > SOURCE_FILE_NAME_MAX_BYTES {
        return false;
    }
    let stem = name.strip_suffix(".c").or_else(|| name.strip_suffix(".h"));
    let Some(stem) = stem else {
        return false;
    };
    let mut bytes = stem.bytes();
    bytes
        .next()
        .is_some_and(|byte| byte.is_ascii_alphanumeric())
        && bytes.all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn source_file_name_rejects_paths_and_other_extensions() {
        assert!(is_valid_source_file_name("aaa.h"));
        assert!(is_valid_source_file_name("answer-test.c"));
        assert!(!is_valid_source_file_name("../aaa.h"));
        assert!(!is_valid_source_file_name("main.cpp"));
    }
}
