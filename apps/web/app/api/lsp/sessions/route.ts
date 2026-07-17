import type { NextRequest, NextResponse } from "next/server";
import { NextResponse as Response } from "next/server";

import { applyVisitorCookie, getVisitorIdentity, type VisitorIdentity } from "@/lib/server/identity";
import { getClientIp, problemResponse, readJsonBody, validateJsonPost } from "@/lib/server/http";
import { consumeRateLimits } from "@/lib/server/rate-limit";
import { createInternalSession, setTicketCookie } from "@/lib/server/services";
import { validateLspSessionRequest } from "@/lib/server/validation";
import type { LspSessionResponse } from "@/types/wire";

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
 * clangd用の短命なLSPセッションを内部Honoサービスへ作成します。
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
            key: `lsp:request:visitor:${identity.id}:minute`,
            limit: 60,
            windowMs: 60_000,
        },
        {
            key: `lsp:request:ip:${clientIp}:minute`,
            limit: 60,
            windowMs: 60_000,
        },
    ]);
    if (!requestLimit.allowed) {
        return withVisitorCookie(
            problemResponse(
                429,
                "LSPリクエストが多すぎます",
                "少し待ってからもう一度お試しください。",
                requestLimit.retryAfterSeconds,
            ),
            identity,
        );
    }

    // JSON解析失敗も上の粗い制限へ計上し、匿名の大きな不正リクエストを抑えます。
    const body = await readJsonBody(request);
    if (body instanceof Response) {
        return withVisitorCookie(body, identity);
    }

    const validation = validateLspSessionRequest(body);
    if (validation.value === undefined) {
        return withVisitorCookie(problemResponse(400, "LSPセッションを作成できません", validation.error), identity);
    }

    const limit = consumeRateLimits([
        {
            key: `lsp:visitor:${identity.id}:minute`,
            limit: 10,
            windowMs: 60_000,
        },
        {
            key: `lsp:ip:${clientIp}:minute`,
            limit: 20,
            windowMs: 60_000,
        },
    ]);

    if (!limit.allowed) {
        return withVisitorCookie(
            problemResponse(
                429,
                "LSPセッションの作成回数が多すぎます",
                "少し待ってからもう一度お試しください。",
                limit.retryAfterSeconds,
            ),
            identity,
        );
    }

    const baseUrl = (process.env.LSP_SERVICE_URL ?? process.env.LSP_BASE_URL ?? "http://lsp:3001").replace(/\/$/, "");
    const result = await createInternalSession(
        `${baseUrl}/internal/sessions`,
        process.env.LSP_INTERNAL_TOKEN ?? process.env.INTERNAL_SHARED_TOKEN ?? process.env.INTERNAL_SERVICE_TOKEN,
        {
            files: validation.value.files,
            visitorId: identity.id,
            clientIp,
        },
        "/ws/lsp/",
    );

    if (!result.ok) {
        return withVisitorCookie(result.response, identity);
    }

    const response = Response.json<LspSessionResponse>(
        {
            id: result.value.id,
            workspaceUri: result.value.workspaceUri!,
            documentUris: result.value.documentUris!,
            webSocketPath: result.value.webSocketPath,
            expiresAt: result.value.expiresAt,
        },
        {
            status: 201,
        },
    );
    setTicketCookie(response, "smart_c_lsp_ticket", result.value.ticket, result.value.webSocketPath);
    return withVisitorCookie(response, identity);
}
