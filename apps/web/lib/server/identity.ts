import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";

import type { NextRequest, NextResponse } from "next/server";

export const VISITOR_COOKIE_NAME = "smart_c_visitor";

export interface VisitorIdentity {
    id: string;
    cookieValue: string;
    shouldSetCookie: boolean;
}

/**
 * HTTP開発環境でもCookieを利用できるよう、明示設定を優先してSecure属性を決めます。
 */
function shouldUseSecureCookies(): boolean {
    if (process.env.COOKIE_SECURE !== undefined) {
        return process.env.COOKIE_SECURE === "true";
    }

    return process.env.NODE_ENV === "production";
}

/**
 * 署名に使用する秘密値を取得し、本番での未設定を安全側に倒します。
 */
function getVisitorSecret(): string {
    const secret = process.env.VISITOR_COOKIE_SECRET ?? process.env.SESSION_SIGNING_SECRET;

    if (secret !== undefined && secret.length >= 32) {
        return secret;
    }

    if (process.env.NODE_ENV === "production") {
        throw new Error("VISITOR_COOKIE_SECRETには32文字以上の秘密値が必要です。");
    }

    return "smart-c-playground-development-secret";
}

/**
 * 匿名利用者IDへHMAC署名を付けます。
 */
function signVisitorId(visitorId: string): string {
    return createHmac("sha256", getVisitorSecret()).update(visitorId).digest("base64url");
}

/**
 * Cookieの署名をタイミング攻撃へ配慮して検証します。
 */
function verifyVisitorCookie(value: string): string | undefined {
    const separatorIndex = value.lastIndexOf(".");

    if (separatorIndex <= 0) {
        return undefined;
    }

    const visitorId = value.slice(0, separatorIndex);
    const signature = value.slice(separatorIndex + 1);

    if (!/^[0-9a-f-]{36}$/i.test(visitorId)) {
        return undefined;
    }

    const expected = Buffer.from(signVisitorId(visitorId));
    const actual = Buffer.from(signature);

    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
        return undefined;
    }

    return visitorId;
}

/**
 * リクエストから署名済み匿名利用者を復元し、必要なら新規発行します。
 */
export function getVisitorIdentity(request: NextRequest): VisitorIdentity {
    const currentValue = request.cookies.get(VISITOR_COOKIE_NAME)?.value;
    const currentId = currentValue === undefined ? undefined : verifyVisitorCookie(currentValue);

    if (currentId !== undefined && currentValue !== undefined) {
        return {
            id: currentId,
            cookieValue: currentValue,
            shouldSetCookie: false,
        };
    }

    const id = randomUUID();
    return {
        id,
        cookieValue: `${id}.${signVisitorId(id)}`,
        shouldSetCookie: true,
    };
}

/**
 * 新規発行した匿名利用者Cookieをレスポンスへ設定します。
 */
export function applyVisitorCookie(response: NextResponse, identity: VisitorIdentity): void {
    if (!identity.shouldSetCookie) {
        return;
    }

    response.cookies.set(VISITOR_COOKIE_NAME, identity.cookieValue, {
        httpOnly: true,
        maxAge: 60 * 60 * 24 * 365,
        path: "/",
        sameSite: "strict",
        secure: shouldUseSecureCookies(),
    });
}
