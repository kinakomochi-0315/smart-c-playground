import { NextResponse } from "next/server";

import { problemResponse } from "@/lib/server/http";

interface InternalSessionResponse {
    id: string;
    webSocketPath: string;
    expiresAt: string;
    ticket: string;
    documentUri?: string;
}

export type UpstreamResult =
    | {
          ok: true;
          value: InternalSessionResponse;
      }
    | {
          ok: false;
          response: NextResponse;
      };

/**
 * 明示された設定を優先し、CookieへSecure属性を付けるかを決めます。
 */
function shouldUseSecureCookies(): boolean {
    if (process.env.COOKIE_SECURE !== undefined) {
        return process.env.COOKIE_SECURE === "true";
    }

    return process.env.NODE_ENV === "production";
}

/**
 * 内部サービスへセッション作成要求を送り、外部公開前に応答を検証します。
 */
export async function createInternalSession(
    url: string,
    token: string | undefined,
    body: Record<string, unknown>,
    expectedWebSocketPrefix: string,
): Promise<UpstreamResult> {
    if (token === undefined || token.length === 0) {
        return {
            ok: false,
            response: problemResponse(
                503,
                "サービス設定が完了していません",
                "内部通信用トークンが設定されていません。",
            ),
        };
    }

    try {
        const upstream = await fetch(url, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "X-Internal-Token": token,
            },
            body: JSON.stringify(body),
            cache: "no-store",
            signal: AbortSignal.timeout(10_000),
        });

        const text = await upstream.text();

        if (!upstream.ok) {
            const contentType = upstream.headers.get("content-type") ?? "application/problem+json";
            const response = new NextResponse(text, {
                status: upstream.status,
                headers: {
                    "Content-Type": contentType,
                },
            });
            const retryAfter = upstream.headers.get("retry-after");
            if (retryAfter !== null) {
                response.headers.set("Retry-After", retryAfter);
            }
            return {
                ok: false,
                response,
            };
        }

        const value = JSON.parse(text) as Partial<InternalSessionResponse>;
        if (
            typeof value.id !== "string" ||
            typeof value.webSocketPath !== "string" ||
            !value.webSocketPath.startsWith(expectedWebSocketPrefix) ||
            value.webSocketPath.includes("..") ||
            typeof value.expiresAt !== "string" ||
            Number.isNaN(Date.parse(value.expiresAt)) ||
            typeof value.ticket !== "string" ||
            value.ticket.length === 0 ||
            (expectedWebSocketPrefix === "/ws/lsp/" && typeof value.documentUri !== "string")
        ) {
            return {
                ok: false,
                response: problemResponse(502, "内部サービスの応答が不正です"),
            };
        }

        return {
            ok: true,
            value: value as InternalSessionResponse,
        };
    } catch {
        return {
            ok: false,
            response: problemResponse(
                503,
                "内部サービスへ接続できません",
                "しばらく待ってからもう一度お試しください。",
            ),
        };
    }
}

/**
 * セッション用の一回限りチケットをWebSocketパス限定Cookieへ設定します。
 */
export function setTicketCookie(response: NextResponse, name: string, value: string, path: string): void {
    response.cookies.set(name, value, {
        httpOnly: true,
        maxAge: 30,
        path,
        sameSite: "strict",
        secure: shouldUseSecureCookies(),
    });
}

/**
 * 依存サービスのreadinessを短いタイムアウトで確認します。
 */
export async function checkDependencyReadiness(): Promise<{
    ready: boolean;
    services: Record<string, boolean>;
}> {
    const targets = {
        lsp: `${process.env.LSP_SERVICE_URL ?? process.env.LSP_BASE_URL ?? "http://lsp:3001"}/internal/health/ready`,
        executor: `${process.env.EXECUTOR_SERVICE_URL ?? process.env.EXECUTOR_API_BASE_URL ?? "http://executor-api:4000"}/internal/health/ready`,
    };

    const entries = await Promise.all(
        Object.entries(targets).map(async ([name, url]) => {
            try {
                const response = await fetch(url, {
                    cache: "no-store",
                    signal: AbortSignal.timeout(2_000),
                });
                return [name, response.ok] as const;
            } catch {
                return [name, false] as const;
            }
        }),
    );
    const services = Object.fromEntries(entries);

    return {
        ready: Object.values(services).every(Boolean),
        services,
    };
}
