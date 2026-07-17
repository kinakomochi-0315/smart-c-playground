import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import { mkdtemp } from "node:fs/promises";
import type { IncomingMessage, Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";

import { LspSessionManager } from "./session-manager.js";
import { TicketService } from "./ticket.js";
import {
    attachWebSocketServer,
    isAllowedOrigin,
    LSP_MAX_MESSAGE_BYTES,
    LSP_TICKET_COOKIE_NAME,
    readCookie,
} from "./websocket.js";

test("LSP ticket Cookieだけを取り出す", () => {
    assert.equal(
        readCookie(`theme=dark; ${LSP_TICKET_COOKIE_NAME}=payload.signature; another=value`, LSP_TICKET_COOKIE_NAME),
        "payload.signature",
    );
    assert.equal(readCookie(undefined, LSP_TICKET_COOKIE_NAME), undefined);
});

test("JSON-RPC message上限を256KiBに固定する", () => {
    assert.equal(LSP_MAX_MESSAGE_BYTES, 256 * 1024);
});

test("設定したWebSocket Originだけを許可する", () => {
    assert.equal(isAllowedOrigin("https://playground.example.com", "https://playground.example.com"), true);
    assert.equal(isAllowedOrigin("https://evil.example.com", "https://playground.example.com"), false);
    assert.equal(isAllowedOrigin(undefined, "https://playground.example.com"), false);
});

test("標準handshake不正時はticketを消費せずsession枠を即時破棄する", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "smart-c-lsp-ws-test-"));
    const manager = new LspSessionManager({
        workspaceRoot,
        clangdPath: "clangd",
        ticketService: new TicketService("s".repeat(32)),
        idleTtlMs: 60_000,
        absoluteTtlMs: 60_000,
        ticketTtlMs: 60_000,
    });
    const session = await manager.createSession({
        source: "",
        visitorId: "visitor-1",
        clientIp: "192.0.2.1",
    });
    const server = new EventEmitter() as Server;
    const webSocketServer = attachWebSocketServer(server, manager, "http://localhost:8080");
    const socket = new PassThrough();
    socket.setEncoding("utf8");
    let response = "";
    socket.on("data", (chunk: string) => {
        response += chunk;
    });
    const request = {
        method: "GET",
        url: session.webSocketPath,
        headers: {
            connection: "Upgrade",
            cookie: `${LSP_TICKET_COOKIE_NAME}=${session.ticket}`,
            origin: "http://localhost:8080",
            "sec-websocket-key": "invalid",
            "sec-websocket-version": "13",
            upgrade: "websocket",
        },
        socket,
    } as unknown as IncomingMessage;

    server.emit("upgrade", request, socket, Buffer.alloc(0));
    await once(socket, "close");

    assert.match(response, /^HTTP\/1\.1 400 /u);
    assert.equal(manager.stats().active, 0);
    assert.deepEqual(manager.authorizeWebSocket(session.id, session.webSocketPath, session.ticket), {
        authorized: false,
        status: 404,
        code: "session_not_found",
    });

    await manager.shutdown();
    await new Promise<void>((resolve) => {
        webSocketServer.close(() => resolve());
    });
});
