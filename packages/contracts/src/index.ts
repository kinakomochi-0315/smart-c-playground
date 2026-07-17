/**
 * 実行端末の初期表示サイズです。
 */
export interface TerminalSize {
    cols: number;
    rows: number;
}

/**
 * フラットなCプロジェクトを構成する1ファイルです。
 */
export interface CSourceFile {
    name: string;
    content: string;
}

/**
 * Cコード実行セッションを作成する公開リクエストです。
 */
export interface CreateExecutionRequest {
    files: CSourceFile[];
    terminal: TerminalSize;
}

/**
 * Next.jsから実行基盤へ送る内部リクエストです。
 */
export interface InternalCreateExecutionRequest extends CreateExecutionRequest {
    visitorId: string;
    clientIp: string;
}

/**
 * ブラウザへ返す実行セッション情報です。
 */
export interface CreateExecutionResponse {
    id: string;
    webSocketPath: string;
    expiresAt: string;
}

/**
 * 内部サービスだけが扱う一回限りチケット付きレスポンスです。
 */
export interface InternalCreateExecutionResponse extends CreateExecutionResponse {
    ticket: string;
}

/**
 * LSPセッションを作成する公開リクエストです。
 */
export interface CreateLspSessionRequest {
    files: CSourceFile[];
}

/**
 * Next.jsからLSPサービスへ送る内部リクエストです。
 */
export interface InternalCreateLspSessionRequest extends CreateLspSessionRequest {
    visitorId: string;
    clientIp: string;
}

/**
 * ブラウザへ返すLSPセッション情報です。
 */
export interface CreateLspSessionResponse {
    id: string;
    workspaceUri: string;
    documentUris: Record<string, string>;
    webSocketPath: string;
    expiresAt: string;
}

/**
 * 内部サービスだけが扱うLSPチケット付きレスポンスです。
 */
export interface InternalCreateLspSessionResponse extends CreateLspSessionResponse {
    ticket: string;
}

/**
 * RFC 9457に準じたAPIエラー本文です。
 */
export interface ProblemDetails {
    type: string;
    title: string;
    status: number;
    detail?: string;
    instance?: string;
    retryAfterSeconds?: number;
}

export type ExecutionPhase =
    | "queued"
    | "compiling"
    | "compile_failed"
    | "running"
    | "exited"
    | "timed_out"
    | "resource_limited"
    | "cancelled"
    | "sandbox_violation";

export type ExecutionExitReason =
    | "completed"
    | "compile_failed"
    | "timed_out"
    | "resource_limited"
    | "cancelled"
    | "sandbox_violation"
    | "internal_error";

/**
 * ブラウザから実行WebSocketへ送るJSON制御メッセージです。
 */
export type ExecutionClientMessage =
    | {
          type: "resize";
          cols: number;
          rows: number;
      }
    | {
          type: "terminate";
      }
    | {
          type: "ping";
          nonce: string;
      };

/**
 * 実行WebSocketからブラウザへ送るJSON状態メッセージです。
 */
export type ExecutionServerMessage =
    | {
          type: "hello";
          protocol: 1;
          sessionId: string;
      }
    | {
          type: "phase";
          phase: ExecutionPhase;
          position?: number;
      }
    | {
          type: "compiler_output";
          stream: "stdout" | "stderr";
          data: string;
      }
    | {
          type: "exit";
          reason: ExecutionExitReason;
          code: number | null;
          signal: number | null;
      }
    | {
          type: "pong";
          nonce: string;
      }
    | {
          type: "error";
          code: string;
          message: string;
          retryable: boolean;
      };

export const SOURCE_MAX_BYTES = 64 * 1024;
export const SOURCE_FILE_MAX_COUNT = 16;
export const SOURCE_FILE_NAME_MAX_LENGTH = 64;
export const TERMINAL_COLS_MIN = 20;
export const TERMINAL_COLS_MAX = 240;
export const TERMINAL_ROWS_MIN = 5;
export const TERMINAL_ROWS_MAX = 80;

/**
 * 値が許可された端末サイズかを検証します。
 */
export function isTerminalSize(value: unknown): value is TerminalSize {
    if (!isRecord(value)) {
        return false;
    }

    return (
        Number.isInteger(value.cols) &&
        Number.isInteger(value.rows) &&
        (value.cols as number) >= TERMINAL_COLS_MIN &&
        (value.cols as number) <= TERMINAL_COLS_MAX &&
        (value.rows as number) >= TERMINAL_ROWS_MIN &&
        (value.rows as number) <= TERMINAL_ROWS_MAX
    );
}

/**
 * Cソースが公開APIで許可する範囲かを検証します。
 */
export function isValidSource(source: unknown): source is string {
    return (
        typeof source === "string" &&
        !source.includes("\0") &&
        new TextEncoder().encode(source).byteLength <= SOURCE_MAX_BYTES
    );
}

/**
 * ファイル名が同一階層のCソースまたはヘッダーとして安全か検証します。
 */
export function isValidSourceFileName(name: unknown): name is string {
    return (
        typeof name === "string" &&
        name.length <= SOURCE_FILE_NAME_MAX_LENGTH &&
        /^[A-Za-z0-9][A-Za-z0-9_-]*\.(?:c|h)$/u.test(name)
    );
}

/**
 * フラットなCプロジェクトの構造と合計サイズを検証します。
 */
export function isValidSourceFiles(files: unknown): files is CSourceFile[] {
    if (!Array.isArray(files) || files.length === 0 || files.length > SOURCE_FILE_MAX_COUNT) {
        return false;
    }

    const names = new Set<string>();
    let totalBytes = 0;
    for (const file of files) {
        if (!isRecord(file) || !isValidSourceFileName(file.name) || !isValidSource(file.content)) {
            return false;
        }

        const normalizedName = file.name.toLowerCase();
        if (names.has(normalizedName)) {
            return false;
        }
        names.add(normalizedName);
        totalBytes += new TextEncoder().encode(file.content).byteLength;
    }

    return names.has("main.c") && totalBytes <= SOURCE_MAX_BYTES;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null;
}
