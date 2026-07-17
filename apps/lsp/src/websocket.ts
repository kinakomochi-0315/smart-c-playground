import type { Server } from "node:http";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";

import { WebSocketServer } from "ws";

import { LspSessionManager, type WebSocketAuthorization } from "./session-manager.js";

export const LSP_TICKET_COOKIE_NAME = "smart_c_lsp_ticket";
export const LSP_MAX_MESSAGE_BYTES = 256 * 1024;

const WEBSOCKET_PATH_PATTERN =
    /^\/ws\/lsp\/([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i;

/**
 * HTTPサーバーへLSP WebSocket Upgrade処理を登録します。
 */
export function attachWebSocketServer(
    server: Server,
    manager: LspSessionManager,
    allowedOrigin: string,
): WebSocketServer {
    const pendingAuthorizations = new WeakMap<IncomingMessage, string>();
    const webSocketServer = new WebSocketServer({
        noServer: true,
        maxPayload: LSP_MAX_MESSAGE_BYTES,
        perMessageDeflate: false,
        // wsのmethod/key/version/protocol検証が成功した後にだけ、一回限りticketを消費します。
        verifyClient: (info, done) => {
            const authorization = authorizeUpgradeRequest(manager, allowedOrigin, info.req);
            if (!authorization.authorized) {
                done(false, authorization.status, createProblemBody(authorization.status, authorization.code), {
                    "Cache-Control": "no-store",
                    "Content-Type": "application/problem+json",
                });
                return;
            }

            pendingAuthorizations.set(info.req, authorization.sessionId);
            info.req.socket.once("close", () => {
                const pendingSessionId = pendingAuthorizations.get(info.req);
                if (pendingSessionId !== undefined) {
                    pendingAuthorizations.delete(info.req);
                    void manager.closeSession(pendingSessionId, 1008, "WebSocket upgrade aborted");
                }
            });
            done(true);
        },
    });
    webSocketServer.on("wsClientError", (_error, socket, request) => {
        const sessionPath = parseSessionPath(request.url);
        if (sessionPath !== null) {
            manager.discardSessionAfterInvalidHandshake(
                sessionPath.sessionId,
                sessionPath.path,
                readCookie(request.headers.cookie, LSP_TICKET_COOKIE_NAME),
            );
        }
        rejectMalformedHandshake(socket);
    });

    server.on("upgrade", (request, socket, head) => {
        try {
            webSocketServer.handleUpgrade(request, socket, head, (webSocket, upgradedRequest) => {
                const sessionId = pendingAuthorizations.get(upgradedRequest);
                if (sessionId === undefined) {
                    webSocket.close(1008, "Session authorization is missing");
                    return;
                }

                pendingAuthorizations.delete(upgradedRequest);
                manager.attachWebSocket(sessionId, webSocket);
            });
        } catch {
            const sessionId = pendingAuthorizations.get(request);
            if (sessionId !== undefined) {
                pendingAuthorizations.delete(request);
                void manager.closeSession(sessionId, 1011, "WebSocket upgrade failed");
            }
            socket.destroy();
        }
    });

    return webSocketServer;
}

/**
 * 標準WebSocket handshake後にOrigin・パス・一回限りCookieを検証します。
 */
function authorizeUpgradeRequest(
    manager: LspSessionManager,
    allowedOrigin: string,
    request: IncomingMessage,
): WebSocketAuthorization | { authorized: false; status: 403; code: "origin_not_allowed" } {
    if (!isAllowedOrigin(request.headers.origin, allowedOrigin)) {
        return {
            authorized: false,
            status: 403,
            code: "origin_not_allowed",
        };
    }

    const path = parsePath(request.url);
    const sessionPath = parseSessionPath(request.url);
    if (sessionPath === null) {
        return {
            authorized: false,
            status: 404,
            code: "session_not_found",
        };
    }

    const ticket = readCookie(request.headers.cookie, LSP_TICKET_COOKIE_NAME);
    return manager.authorizeWebSocket(sessionPath.sessionId, path, ticket);
}

/**
 * WebSocket UpgradeのOriginが設定済み公開オリジンと一致するか判定します。
 */
export function isAllowedOrigin(receivedOrigin: string | undefined, allowedOrigin: string): boolean {
    return receivedOrigin === allowedOrigin;
}

/**
 * リクエストURLからpathnameだけを安全に取り出します。
 */
function parsePath(rawUrl: string | undefined): string {
    try {
        return new URL(rawUrl ?? "/", "http://localhost").pathname;
    } catch {
        return "/";
    }
}

/**
 * Upgrade URLがLSP session pathならpathとsession IDを返します。
 */
function parseSessionPath(rawUrl: string | undefined): { path: string; sessionId: string } | null {
    const path = parsePath(rawUrl);
    const match = path.match(WEBSOCKET_PATH_PATTERN);
    if (match === null) {
        return null;
    }

    return {
        path,
        sessionId: match[1],
    };
}

/**
 * Cookieヘッダーから指定Cookieの値を読み取ります。
 */
export function readCookie(cookieHeader: string | undefined, name: string): string | undefined {
    if (cookieHeader === undefined) {
        return undefined;
    }

    for (const part of cookieHeader.split(";")) {
        const separator = part.indexOf("=");
        if (separator < 1) {
            continue;
        }
        if (part.slice(0, separator).trim() === name) {
            return part.slice(separator + 1).trim();
        }
    }

    return undefined;
}

/**
 * Upgrade拒否用の最小problem JSONを生成します。
 */
function createProblemBody(status: number, code: string): string {
    return JSON.stringify({
        type: `urn:smart-c:problem:${code}`,
        title: "WebSocket接続を受理できません",
        status,
    });
}

/**
 * ws標準検証で拒否されたsocketへ汎用400を返して閉じます。
 */
function rejectMalformedHandshake(socket: Duplex): void {
    const body = createProblemBody(400, "invalid_websocket_handshake");
    socket.end(
        "HTTP/1.1 400 Bad Request\r\n" +
            "Connection: close\r\n" +
            "Cache-Control: no-store\r\n" +
            "Content-Type: application/problem+json\r\n" +
            `Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n` +
            "\r\n" +
            body,
    );
}
