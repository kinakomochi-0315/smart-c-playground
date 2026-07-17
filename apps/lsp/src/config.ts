import { isAbsolute } from "node:path";

/**
 * LSPサービスの実行時設定です。
 */
export interface LspConfig {
    host: string;
    port: number;
    webOrigin: string;
    internalToken: string;
    signingSecret: string;
    workspaceRoot: string;
    clangdPath: string;
    clangdSandboxPath: string | undefined;
    clangdLimiterPath: string | undefined;
    maxSessions: number;
    maxSessionsPerVisitor: number;
    maxSessionsPerIp: number;
}

const DEFAULT_PORT = 3001;
const MINIMUM_SECRET_LENGTH = 32;
const DEFAULT_MAX_SESSIONS = 8;
const DEFAULT_MAX_SESSIONS_PER_VISITOR = 1;
const DEFAULT_MAX_SESSIONS_PER_IP = 2;

/**
 * 環境変数からLSPサービス設定を読み込みます。
 */
export function loadConfig(environment: NodeJS.ProcessEnv = process.env): LspConfig {
    const clangdSandboxPath = readOptionalAbsolutePath(environment.CLANGD_SANDBOX_PATH, "CLANGD_SANDBOX_PATH");
    const clangdLimiterPath = readOptionalAbsolutePath(environment.CLANGD_LIMITER_PATH, "CLANGD_LIMITER_PATH");
    if (environment.NODE_ENV === "production" && (clangdSandboxPath === undefined || clangdLimiterPath === undefined)) {
        throw new Error("ProductionではCLANGD_SANDBOX_PATHとCLANGD_LIMITER_PATHが必須です。");
    }

    return {
        host: environment.LSP_HOST ?? environment.HOST ?? "0.0.0.0",
        port: parsePort(environment.LSP_PORT ?? environment.PORT),
        webOrigin: parseWebOrigin(environment.WEB_ORIGIN),
        internalToken: readSecret(environment, "INTERNAL_SERVICE_TOKEN"),
        signingSecret: readSecret(environment, "SESSION_SIGNING_SECRET"),
        workspaceRoot: environment.LSP_WORKSPACE_ROOT ?? "/tmp/smart-c-lsp",
        clangdPath: environment.CLANGD_PATH ?? "clangd",
        clangdSandboxPath,
        clangdLimiterPath,
        maxSessions: parsePositiveInteger(environment.LSP_MAX_SESSIONS, "LSP_MAX_SESSIONS", DEFAULT_MAX_SESSIONS),
        maxSessionsPerVisitor: parsePositiveInteger(
            environment.LSP_MAX_SESSIONS_PER_VISITOR,
            "LSP_MAX_SESSIONS_PER_VISITOR",
            DEFAULT_MAX_SESSIONS_PER_VISITOR,
        ),
        maxSessionsPerIp: parsePositiveInteger(
            environment.LSP_MAX_SESSIONS_PER_IP,
            "LSP_MAX_SESSIONS_PER_IP",
            DEFAULT_MAX_SESSIONS_PER_IP,
        ),
    };
}

/**
 * 任意の実行ファイルパスを絶対パスとして検証します。
 */
function readOptionalAbsolutePath(rawPath: string | undefined, name: string): string | undefined {
    if (rawPath === undefined) {
        return undefined;
    }
    if (rawPath.length === 0 || !isAbsolute(rawPath) || /[\0\r\n]/u.test(rawPath)) {
        throw new Error(`${name}には絶対パスを指定してください。`);
    }

    return rawPath;
}

/**
 * WebSocketで許可する公開オリジンを正規化します。
 */
function parseWebOrigin(rawOrigin: string | undefined): string {
    const origin = rawOrigin ?? "http://localhost:8080";

    try {
        const url = new URL(origin);
        if ((url.protocol !== "http:" && url.protocol !== "https:") || url.origin !== origin) {
            throw new Error("origin only");
        }
        return url.origin;
    } catch {
        throw new Error("WEB_ORIGINにはパスを含まないHTTPまたはHTTPSオリジンを指定してください。");
    }
}

/**
 * ポート番号を安全な整数へ変換します。
 */
function parsePort(rawPort: string | undefined): number {
    if (rawPort === undefined) {
        return DEFAULT_PORT;
    }

    const port = Number(rawPort);
    if (!Number.isInteger(port) || port < 1 || port > 65_535) {
        throw new Error("LSP_PORTには1から65535までの整数を指定してください。");
    }

    return port;
}

/**
 * 必須の秘密値を読み込み、短すぎる設定を拒否します。
 */
function readSecret(environment: NodeJS.ProcessEnv, name: string): string {
    const secret = environment[name];
    if (secret === undefined || Buffer.byteLength(secret, "utf8") < MINIMUM_SECRET_LENGTH) {
        throw new Error(`${name}には32バイト以上の秘密値を指定してください。`);
    }

    return secret;
}

/**
 * 正の整数設定を読み込み、未指定なら既定値を返します。
 */
function parsePositiveInteger(rawValue: string | undefined, name: string, defaultValue: number): number {
    if (rawValue === undefined) {
        return defaultValue;
    }

    const value = Number(rawValue);
    if (!Number.isSafeInteger(value) || value < 1) {
        throw new Error(`${name}には1以上の整数を指定してください。`);
    }

    return value;
}
