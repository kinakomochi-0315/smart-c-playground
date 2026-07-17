import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const TICKET_VERSION = 1;

/**
 * WebSocket接続チケットへ署名する内容です。
 */
export interface TicketPayload {
    version: typeof TICKET_VERSION;
    sessionId: string;
    visitorId: string;
    path: string;
    nonce: string;
    issuedAt: number;
    expiresAt: number;
}

/**
 * 発行したチケットと検証に必要な内容です。
 */
export interface IssuedTicket {
    ticket: string;
    payload: TicketPayload;
}

/**
 * チケット検証の結果です。
 */
export type TicketVerification =
    | {
          valid: true;
          payload: TicketPayload;
      }
    | {
          valid: false;
          reason: "invalid" | "expired";
      };

/**
 * HMAC署名された短命なWebSocketチケットを発行・検証します。
 */
export class TicketService {
    readonly #secret: Buffer;
    readonly #now: () => number;

    /**
     * チケット署名サービスを初期化します。
     */
    public constructor(secret: string, now: () => number = Date.now) {
        this.#secret = Buffer.from(secret, "utf8");
        this.#now = now;
    }

    /**
     * セッション・利用者・接続先へ束縛したチケットを発行します。
     */
    public issue(sessionId: string, visitorId: string, path: string, ttlMs: number): IssuedTicket {
        const issuedAt = this.#now();
        const payload: TicketPayload = {
            version: TICKET_VERSION,
            sessionId,
            visitorId,
            path,
            nonce: randomBytes(18).toString("base64url"),
            issuedAt,
            expiresAt: issuedAt + ttlMs,
        };
        const encodedPayload = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");

        return {
            ticket: `${encodedPayload}.${this.#sign(encodedPayload)}`,
            payload,
        };
    }

    /**
     * チケットの署名・期限・束縛先を検証します。
     */
    public verify(
        ticket: string,
        expected: Pick<TicketPayload, "sessionId" | "visitorId" | "path">,
    ): TicketVerification {
        const separator = ticket.indexOf(".");
        if (separator <= 0 || separator !== ticket.lastIndexOf(".")) {
            return { valid: false, reason: "invalid" };
        }

        const encodedPayload = ticket.slice(0, separator);
        const receivedSignature = ticket.slice(separator + 1);
        if (!this.#hasValidSignature(encodedPayload, receivedSignature)) {
            return { valid: false, reason: "invalid" };
        }

        const payload = parsePayload(encodedPayload);
        if (
            payload === null ||
            payload.sessionId !== expected.sessionId ||
            payload.visitorId !== expected.visitorId ||
            payload.path !== expected.path
        ) {
            return { valid: false, reason: "invalid" };
        }

        if (payload.expiresAt <= this.#now()) {
            return { valid: false, reason: "expired" };
        }

        return { valid: true, payload };
    }

    /**
     * チケット本文へHMAC-SHA256署名を付与します。
     */
    #sign(encodedPayload: string): string {
        return createHmac("sha256", this.#secret).update(encodedPayload, "utf8").digest("base64url");
    }

    /**
     * 署名を一定時間比較し、改ざんを検出します。
     */
    #hasValidSignature(encodedPayload: string, receivedSignature: string): boolean {
        const expectedSignature = Buffer.from(this.#sign(encodedPayload), "utf8");
        const actualSignature = Buffer.from(receivedSignature, "utf8");
        return (
            expectedSignature.length === actualSignature.length && timingSafeEqual(expectedSignature, actualSignature)
        );
    }
}

/**
 * Base64URL化されたチケット本文を厳密に復元します。
 */
function parsePayload(encodedPayload: string): TicketPayload | null {
    try {
        const value: unknown = JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8"));
        if (!isRecord(value)) {
            return null;
        }

        if (
            value.version !== TICKET_VERSION ||
            typeof value.sessionId !== "string" ||
            typeof value.visitorId !== "string" ||
            typeof value.path !== "string" ||
            typeof value.nonce !== "string" ||
            !Number.isSafeInteger(value.issuedAt) ||
            !Number.isSafeInteger(value.expiresAt)
        ) {
            return null;
        }

        return value as unknown as TicketPayload;
    } catch {
        return null;
    }
}

/**
 * 値がJSONオブジェクトかを判定します。
 */
function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null;
}
