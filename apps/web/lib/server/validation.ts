import { MAX_SOURCE_BYTES } from "@/lib/server/http";
import type { ExecutionRequest, LspSessionRequest } from "@/types/wire";

export interface ValidationResult<T> {
    value?: T;
    error?: string;
}

/**
 * 不明な値がオブジェクトであることを判定します。
 */
function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null;
}

/**
 * C言語ソースの型とUTF-8バイト数を検証します。
 */
function validateSource(source: unknown): ValidationResult<string> {
    if (typeof source !== "string") {
        return {
            error: "sourceには文字列を指定してください。",
        };
    }

    if (Buffer.byteLength(source, "utf8") > MAX_SOURCE_BYTES) {
        return {
            error: "C言語ソースは64KiB以内にしてください。",
        };
    }

    if (source.includes("\0")) {
        return {
            error: "C言語ソースにNUL文字は使用できません。",
        };
    }

    return {
        value: source,
    };
}

/**
 * LSPセッション作成リクエストを検証します。
 */
export function validateLspSessionRequest(value: unknown): ValidationResult<LspSessionRequest> {
    if (!isRecord(value)) {
        return {
            error: "リクエスト本文はオブジェクトにしてください。",
        };
    }

    const source = validateSource(value.source);
    if (source.error !== undefined || source.value === undefined) {
        return {
            error: source.error,
        };
    }

    return {
        value: {
            source: source.value,
        },
    };
}

/**
 * 実行セッション作成リクエストを検証します。
 */
export function validateExecutionRequest(value: unknown): ValidationResult<ExecutionRequest> {
    if (!isRecord(value)) {
        return {
            error: "リクエスト本文はオブジェクトにしてください。",
        };
    }

    const source = validateSource(value.source);
    if (source.error !== undefined || source.value === undefined) {
        return {
            error: source.error,
        };
    }

    if (!isRecord(value.terminal)) {
        return {
            error: "terminalには端末サイズを指定してください。",
        };
    }

    const cols = value.terminal.cols;
    const rows = value.terminal.rows;

    if (typeof cols !== "number" || !Number.isInteger(cols) || cols < 20 || cols > 240) {
        return {
            error: "terminal.colsは20から240の整数にしてください。",
        };
    }

    if (typeof rows !== "number" || !Number.isInteger(rows) || rows < 5 || rows > 80) {
        return {
            error: "terminal.rowsは5から80の整数にしてください。",
        };
    }

    return {
        value: {
            source: source.value,
            terminal: {
                cols,
                rows,
            },
        },
    };
}
