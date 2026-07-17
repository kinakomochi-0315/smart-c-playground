import { timingSafeEqual } from "node:crypto";

import type { InternalCreateLspSessionRequest, ProblemDetails } from "@smart-c/contracts";
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { ContentfulStatusCode } from "hono/utils/http-status";

import type { HealthProvider } from "./health.js";
import { LspSessionManager, SessionLimitError } from "./session-manager.js";

const SOURCE_MAX_BYTES = 64 * 1024;
const REQUEST_MAX_BYTES = 512 * 1024;
const VISITOR_ID_MAX_LENGTH = 128;
const CLIENT_IP_MAX_LENGTH = 128;

/**
 * HTTPアプリケーションが利用する依存関係です。
 */
export interface AppDependencies {
    manager: LspSessionManager;
    health: HealthProvider;
    internalToken: string;
}

/**
 * LSPサービスのHonoアプリケーションを構築します。
 */
export function createApp(dependencies: AppDependencies): Hono {
    const app = new Hono();

    app.get("/internal/health/live", (context) => {
        return context.json({
            status: "ok",
            service: "lsp",
        });
    });

    app.get("/internal/health/ready", (context) => {
        return readinessResponse(context, dependencies);
    });

    app.get("/api/health", (context) => {
        return readinessResponse(context, dependencies);
    });

    app.use(
        "/internal/sessions",
        bodyLimit({
            maxSize: REQUEST_MAX_BYTES,
            onError: (context) =>
                problemResponse(context, {
                    type: "urn:smart-c:problem:request-too-large",
                    title: "リクエストが大きすぎます",
                    status: 413,
                    detail: "Cソースは64KiB以下にしてください。",
                }),
        }),
    );

    app.post("/internal/sessions", async (context) => {
        if (!hasValidInternalToken(context.req.header("X-Internal-Token"), dependencies.internalToken)) {
            return problemResponse(context, {
                type: "urn:smart-c:problem:unauthorized",
                title: "内部サービス認証に失敗しました",
                status: 401,
            });
        }
        if (!dependencies.health.isReady() || !dependencies.manager.isAcceptingSessions()) {
            return problemResponse(context, {
                type: "urn:smart-c:problem:lsp-unavailable",
                title: "LSPサービスを利用できません",
                status: 503,
            });
        }
        if (!isJsonContentType(context.req.header("Content-Type"))) {
            return problemResponse(context, {
                type: "urn:smart-c:problem:unsupported-media-type",
                title: "Content-Typeが不正です",
                status: 415,
                detail: "application/jsonを指定してください。",
            });
        }

        let body: unknown;
        try {
            body = await context.req.json();
        } catch {
            return problemResponse(context, {
                type: "urn:smart-c:problem:invalid-json",
                title: "JSONを解析できません",
                status: 400,
            });
        }
        if (!isCreateSessionRequest(body)) {
            return problemResponse(context, {
                type: "urn:smart-c:problem:invalid-request",
                title: "LSPセッション作成リクエストが不正です",
                status: 400,
            });
        }

        try {
            const session = await dependencies.manager.createSession(body);
            context.header("Cache-Control", "no-store");
            return context.json(session, 201);
        } catch (error) {
            if (error instanceof SessionLimitError) {
                if (error.kind === "global" || error.kind === "shutting_down") {
                    return problemResponse(context, {
                        type: "urn:smart-c:problem:lsp-capacity",
                        title: "LSPサービスが混雑しています",
                        status: 503,
                    });
                }
                return problemResponse(context, {
                    type: "urn:smart-c:problem:lsp-rate-limit",
                    title: "同時に利用できるLSPセッション数を超えました",
                    status: 429,
                });
            }

            return problemResponse(context, {
                type: "urn:smart-c:problem:internal-error",
                title: "LSPセッションを作成できませんでした",
                status: 500,
            });
        }
    });

    app.get("/ws/lsp/:sessionId", (context) => {
        return problemResponse(context, {
            type: "urn:smart-c:problem:websocket-required",
            title: "WebSocket Upgradeが必要です",
            status: 426,
        });
    });

    app.notFound((context) =>
        problemResponse(context, {
            type: "urn:smart-c:problem:not-found",
            title: "エンドポイントが見つかりません",
            status: 404,
        }),
    );

    return app;
}

/**
 * clangdと受付状態をまとめたreadinessレスポンスを返します。
 */
function readinessResponse(context: Context, dependencies: AppDependencies): Response {
    const health = dependencies.health.snapshot();
    const sessions = dependencies.manager.stats();
    const ready = health.ready && dependencies.manager.isAcceptingSessions();
    return context.json(
        {
            status: ready ? "ok" : "unavailable",
            service: "lsp",
            clangd: health.ready ? "ready" : "unavailable",
            checkedAt: health.checkedAt,
            sessions,
        },
        ready ? 200 : 503,
    );
}

/**
 * 内部トークンを一定時間比較します。
 */
function hasValidInternalToken(received: string | undefined, expected: string): boolean {
    if (received === undefined) {
        return false;
    }

    const receivedBuffer = Buffer.from(received, "utf8");
    const expectedBuffer = Buffer.from(expected, "utf8");
    return receivedBuffer.length === expectedBuffer.length && timingSafeEqual(receivedBuffer, expectedBuffer);
}

/**
 * Content-TypeがJSONかを判定します。
 */
function isJsonContentType(contentType: string | undefined): boolean {
    return contentType?.split(";", 1)[0]?.trim().toLowerCase() === "application/json";
}

/**
 * 内部セッション作成リクエストを検証します。
 */
function isCreateSessionRequest(value: unknown): value is InternalCreateLspSessionRequest {
    if (!isRecord(value)) {
        return false;
    }

    return (
        isValidSource(value.source) &&
        isBoundedString(value.visitorId, VISITOR_ID_MAX_LENGTH) &&
        isBoundedString(value.clientIp, CLIENT_IP_MAX_LENGTH)
    );
}

/**
 * CソースのサイズとNUL文字を検証します。
 */
function isValidSource(source: unknown): source is string {
    return (
        typeof source === "string" && !source.includes("\0") && Buffer.byteLength(source, "utf8") <= SOURCE_MAX_BYTES
    );
}

/**
 * 識別子文字列が空でなく上限内かを検証します。
 */
function isBoundedString(value: unknown, maximumLength: number): value is string {
    return typeof value === "string" && value.length > 0 && value.length <= maximumLength && !/[\0\r\n]/u.test(value);
}

/**
 * 値がJSONオブジェクトかを判定します。
 */
function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null;
}

/**
 * RFC 9457形式のエラーレスポンスを返します。
 */
function problemResponse(context: Context, problem: ProblemDetails): Response {
    context.header("Cache-Control", "no-store");
    return context.json(problem, problem.status as ContentfulStatusCode, {
        "Content-Type": "application/problem+json",
    });
}
