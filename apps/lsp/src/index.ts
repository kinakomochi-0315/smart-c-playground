import { serve } from "@hono/node-server";
import type { Server } from "node:http";

import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { ClangdHealthProbe } from "./health.js";
import { LspSessionManager } from "./session-manager.js";
import { TicketService } from "./ticket.js";
import { attachWebSocketServer } from "./websocket.js";

/**
 * LSP HTTP/WebSocketサービスを起動します。
 */
async function main(): Promise<void> {
    const config = loadConfig();
    const health = new ClangdHealthProbe({
        clangdPath: config.clangdPath,
        workspaceRoot: config.workspaceRoot,
        sandboxPath: config.clangdSandboxPath,
        limiterPath: config.clangdLimiterPath,
    });
    await health.start();
    if (!health.isReady()) {
        throw new Error("clangd sandbox smoke test failed");
    }

    const manager = new LspSessionManager({
        workspaceRoot: config.workspaceRoot,
        clangdPath: config.clangdPath,
        clangdSandboxPath: config.clangdSandboxPath,
        clangdLimiterPath: config.clangdLimiterPath,
        ticketService: new TicketService(config.signingSecret),
        maxSessions: config.maxSessions,
        maxSessionsPerVisitor: config.maxSessionsPerVisitor,
        maxSessionsPerIp: config.maxSessionsPerIp,
    });
    const app = createApp({
        manager,
        health,
        internalToken: config.internalToken,
    });
    const server = serve({
        fetch: app.fetch,
        hostname: config.host,
        port: config.port,
    }) as Server;
    const webSocketServer = attachWebSocketServer(server, manager, config.webOrigin);
    let stopping = false;

    /**
     * 新規受付を止め、全clangdとHTTPサーバーを終了します。
     */
    const shutdown = async (): Promise<void> => {
        if (stopping) {
            return;
        }
        stopping = true;
        health.stop();
        await manager.shutdown();
        await closeWebSocketServer(webSocketServer);
        await closeHttpServer(server);
    };

    process.once("SIGTERM", () => {
        void shutdown();
    });
    process.once("SIGINT", () => {
        void shutdown();
    });

    console.log(`LSP service listening on ${config.host}:${config.port}`);
}

/**
 * WebSocketサーバーのclose完了を待ちます。
 */
async function closeWebSocketServer(webSocketServer: ReturnType<typeof attachWebSocketServer>): Promise<void> {
    await new Promise<void>((resolve) => {
        webSocketServer.close(() => resolve());
    });
}

/**
 * HTTPサーバーのclose完了を待ちます。
 */
async function closeHttpServer(server: Server): Promise<void> {
    await new Promise<void>((resolve, reject) => {
        server.close((error) => {
            if (error !== undefined) {
                reject(error);
                return;
            }
            resolve();
        });
    });
}

void main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : "unknown startup error";
    console.error(`LSP service failed to start: ${message}`);
    process.exitCode = 1;
});
