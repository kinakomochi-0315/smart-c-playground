import { isValidSourceFileName, SOURCE_FILE_MAX_COUNT, SOURCE_MAX_BYTES, type CSourceFile } from "@smart-c/contracts";
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
function validateFiles(files: unknown): ValidationResult<CSourceFile[]> {
    if (!Array.isArray(files)) {
        return {
            error: "filesにはファイルの配列を指定してください。",
        };
    }
    if (files.length === 0 || files.length > SOURCE_FILE_MAX_COUNT) {
        return {
            error: `ファイル数は1から${SOURCE_FILE_MAX_COUNT}件にしてください。`,
        };
    }

    const names = new Set<string>();
    let totalBytes = 0;
    const validated: CSourceFile[] = [];
    for (const file of files) {
        if (!isRecord(file) || !isValidSourceFileName(file.name)) {
            return {
                error: "ファイル名は英数字、ハイフン、アンダースコアを使った.cまたは.hにしてください。",
            };
        }
        if (typeof file.content !== "string" || file.content.includes("\0")) {
            return {
                error: "ファイル内容にはNUL文字を含まない文字列を指定してください。",
            };
        }

        const normalizedName = file.name.toLowerCase();
        if (names.has(normalizedName)) {
            return {
                error: "同じファイル名を複数指定できません。",
            };
        }
        names.add(normalizedName);
        totalBytes += Buffer.byteLength(file.content, "utf8");
        validated.push({ name: file.name, content: file.content });
    }
    if (!names.has("main.c")) {
        return {
            error: "main.cは削除できません。",
        };
    }
    if (totalBytes > SOURCE_MAX_BYTES) {
        return {
            error: "全ファイルの合計は64KiB以内にしてください。",
        };
    }

    return {
        value: validated,
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

    const files = validateFiles(value.files);
    if (files.error !== undefined || files.value === undefined) {
        return {
            error: files.error,
        };
    }

    return {
        value: {
            files: files.value,
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

    const files = validateFiles(value.files);
    if (files.error !== undefined || files.value === undefined) {
        return {
            error: files.error,
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
            files: files.value,
            terminal: {
                cols,
                rows,
            },
        },
    };
}
