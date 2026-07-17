import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

import type { ProblemDetails } from "@/types/wire";

export const MAX_SOURCE_BYTES = 64 * 1024;
export const MAX_REQUEST_BYTES = 512 * 1024;

/**
 * APIで返すProblem Detailsレスポンスを生成します。
 */
export function problemResponse(
    status: number,
    title: string,
    detail?: string,
    retryAfterSeconds?: number,
): NextResponse<ProblemDetails> {
    const body: ProblemDetails = {
        type: `https://smart-c-playground.invalid/problems/${status}`,
        title,
        status,
        ...(detail === undefined ? {} : { detail }),
        ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }),
    };
    const response = NextResponse.json(body, {
        status,
        headers: {
            "Content-Type": "application/problem+json",
        },
    });

    if (retryAfterSeconds !== undefined) {
        response.headers.set("Retry-After", String(retryAfterSeconds));
    }

    return response;
}

/**
 * 逆プロキシが付与したヘッダーから、クライアントIPを一つだけ抽出します。
 */
export function getClientIp(request: NextRequest): string {
    const forwarded = request.headers.get("x-forwarded-for");
    return forwarded?.split(",")[0]?.trim().slice(0, 128) || "unknown";
}

/**
 * ブラウザからのJSON POSTが同一オリジンかを検証します。
 */
export function validateJsonPost(request: NextRequest): NextResponse | null {
    const contentType = request.headers.get("content-type") ?? "";

    if (!contentType.toLowerCase().startsWith("application/json")) {
        return problemResponse(415, "JSON形式で送信してください", "Content-Typeにはapplication/jsonが必要です。");
    }

    const contentLength = Number(request.headers.get("content-length"));
    if (Number.isFinite(contentLength) && contentLength > MAX_REQUEST_BYTES) {
        return problemResponse(413, "リクエストが大きすぎます", "C言語ソースは64KiB以内にしてください。");
    }

    const origin = request.headers.get("origin");
    if (origin === null) {
        return problemResponse(403, "送信元を確認できません", "ブラウザから同一オリジンでアクセスしてください。");
    }

    try {
        const originUrl = new URL(origin);
        const forwardedHost =
            request.headers.get("x-forwarded-host") ?? request.headers.get("host") ?? request.nextUrl.host;
        const forwardedProtocol = request.headers.get("x-forwarded-proto") ?? request.nextUrl.protocol.replace(":", "");

        if (originUrl.host !== forwardedHost || originUrl.protocol !== `${forwardedProtocol}:`) {
            return problemResponse(403, "異なる送信元からの操作は許可されていません");
        }
    } catch {
        return problemResponse(403, "送信元が不正です");
    }

    return null;
}

/**
 * 上限を超えない範囲でJSON本文を読み込みます。
 */
export async function readJsonBody(request: NextRequest): Promise<unknown | NextResponse> {
    if (request.body === null) {
        return problemResponse(400, "リクエスト本文がありません");
    }

    try {
        const reader = request.body.getReader();
        const decoder = new TextDecoder();
        let byteLength = 0;
        let text = "";

        while (true) {
            const { done, value } = await reader.read();
            if (done) {
                break;
            }

            byteLength += value.byteLength;
            if (byteLength > MAX_REQUEST_BYTES) {
                await reader.cancel("request body too large");
                return problemResponse(413, "リクエストが大きすぎます", "C言語ソースは64KiB以内にしてください。");
            }
            text += decoder.decode(value, {
                stream: true,
            });
        }
        text += decoder.decode();
        return JSON.parse(text) as unknown;
    } catch {
        return problemResponse(400, "JSONを解析できません", "リクエスト本文の形式を確認してください。");
    }
}
