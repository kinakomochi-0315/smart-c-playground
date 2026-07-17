import type { NextRequest, NextResponse } from "next/server";
import { NextResponse as Response } from "next/server";

import { applyVisitorCookie, getVisitorIdentity, type VisitorIdentity } from "@/lib/server/identity";
import { getClientIp, problemResponse, readJsonBody, validateJsonPost } from "@/lib/server/http";
import { consumeRateLimits } from "@/lib/server/rate-limit";
import { createInternalSession, setTicketCookie } from "@/lib/server/services";
import { validateExecutionRequest } from "@/lib/server/validation";
import type { ExecutionResponse } from "@/types/wire";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * 匿名利用者Cookieを必要に応じてレスポンスへ付与します。
 */
function withVisitorCookie(response: NextResponse, identity: VisitorIdentity): NextResponse {
    applyVisitorCookie(response, identity);
    return response;
}

/**
 * C言語のコンパイル・対話実行セッションを内部Rust APIへ作成します。
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
    const invalidPost = validateJsonPost(request);
    if (invalidPost !== null) {
        return invalidPost;
    }

    let identity: VisitorIdentity;
    try {
        identity = getVisitorIdentity(request);
    } catch {
        return problemResponse(503, "匿名利用者の設定が完了していません");
    }

    const clientIp = getClientIp(request);
    const requestLimit = consumeRateLimits([
        {
            key: `execution:request:visitor:${identity.id}:minute`,
            limit: 30,
            windowMs: 60_000,
        },
        {
            key: `execution:request:ip:${clientIp}:minute`,
            limit: 30,
            windowMs: 60_000,
        },
    ]);
    if (!requestLimit.allowed) {
        return withVisitorCookie(
            problemResponse(
                429,
                "実行リクエストが多すぎます",
                "少し待ってからもう一度お試しください。",
                requestLimit.retryAfterSeconds,
            ),
            identity,
        );
    }

    // 不正JSONやサイズ超過も上の粗い制限へ計上してから本文を読み込みます。
    const body = await readJsonBody(request);
    if (body instanceof Response) {
        return withVisitorCookie(body, identity);
    }

    const validation = validateExecutionRequest(body);
    if (validation.value === undefined) {
        const status = validation.error?.includes("64KiB") ? 413 : 400;
        return withVisitorCookie(problemResponse(status, "実行セッションを作成できません", validation.error), identity);
    }

    const limit = consumeRateLimits([
        {
            key: `execution:visitor:${identity.id}:minute`,
            limit: 6,
            windowMs: 60_000,
        },
        {
            key: `execution:ip:${clientIp}:minute`,
            limit: 6,
            windowMs: 60_000,
        },
        {
            key: `execution:ip:${clientIp}:hour`,
            limit: 30,
            windowMs: 60 * 60_000,
        },
    ]);

    if (!limit.allowed) {
        return withVisitorCookie(
            problemResponse(
                429,
                "実行回数が多すぎます",
                "少し待ってからもう一度お試しください。",
                limit.retryAfterSeconds,
            ),
            identity,
        );
    }

    const baseUrl = (
        process.env.EXECUTOR_SERVICE_URL ??
        process.env.EXECUTOR_API_BASE_URL ??
        "http://executor-api:4000"
    ).replace(/\/$/, "");
    const result = await createInternalSession(
        `${baseUrl}/internal/executions`,
        process.env.EXECUTOR_INTERNAL_TOKEN ?? process.env.INTERNAL_SHARED_TOKEN ?? process.env.INTERNAL_SERVICE_TOKEN,
        {
            files: validation.value.files,
            terminal: validation.value.terminal,
            visitorId: identity.id,
            clientIp,
        },
        "/ws/executions/",
    );

    if (!result.ok) {
        return withVisitorCookie(result.response, identity);
    }

    const response = Response.json<ExecutionResponse>(
        {
            id: result.value.id,
            webSocketPath: result.value.webSocketPath,
            expiresAt: result.value.expiresAt,
        },
        {
            status: 201,
        },
    );
    setTicketCookie(response, "smart_c_exec_ticket", result.value.ticket, result.value.webSocketPath);
    return withVisitorCookie(response, identity);
}
