import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { InternalCreateLspSessionRequest, InternalCreateLspSessionResponse } from "@smart-c/contracts";
import {
    createProcessStreamConnection,
    createWebSocketConnection,
    forward,
    type IConnection,
} from "vscode-ws-jsonrpc/server";
import type { IWebSocket } from "vscode-ws-jsonrpc";
import { WebSocket } from "ws";

import { createClangdDocumentUri, createClangdProcessSpec, createClangdWorkspaceUri } from "./clangd-process.js";
import { LspJsonRpcGuard } from "./json-rpc-guard.js";
import { TicketService } from "./ticket.js";

const COMPILE_FLAGS = "-xc\n-std=c17\n-Wall\n-Wextra\n-Wpedantic\n";
const DEFAULT_MAX_SESSIONS = 8;
const DEFAULT_MAX_SESSIONS_PER_VISITOR = 1;
const DEFAULT_MAX_SESSIONS_PER_IP = 2;
const DEFAULT_IDLE_TTL_MS = 10 * 60 * 1_000;
const DEFAULT_ABSOLUTE_TTL_MS = 30 * 60 * 1_000;
const DEFAULT_TICKET_TTL_MS = 30_000;
const PROCESS_SHUTDOWN_GRACE_MS = 1_000;

/**
 * セッション作成数の制限種別です。
 */
export type SessionLimitKind = "global" | "visitor" | "ip" | "shutting_down";

/**
 * セッション上限に達したことを表すエラーです。
 */
export class SessionLimitError extends Error {
    public readonly kind: SessionLimitKind;

    /**
     * 上限種別を保持したエラーを作成します。
     */
    public constructor(kind: SessionLimitKind) {
        super(`LSP session limit exceeded: ${kind}`);
        this.name = "SessionLimitError";
        this.kind = kind;
    }
}

/**
 * WebSocketチケット認証の結果です。
 */
export type WebSocketAuthorization =
    | {
          authorized: true;
          sessionId: string;
      }
    | {
          authorized: false;
          status: 401 | 404 | 409 | 410;
          code: "missing_ticket" | "invalid_ticket" | "expired_ticket" | "session_not_found" | "ticket_used";
      };

/**
 * LSPセッション管理の設定です。
 */
export interface SessionManagerOptions {
    workspaceRoot: string;
    clangdPath: string;
    clangdSandboxPath?: string;
    clangdLimiterPath?: string;
    ticketService: TicketService;
    maxSessions?: number;
    maxSessionsPerVisitor?: number;
    maxSessionsPerIp?: number;
    idleTtlMs?: number;
    absoluteTtlMs?: number;
    ticketTtlMs?: number;
    now?: () => number;
}

/**
 * health endpointへ公開するセッション統計です。
 */
export interface SessionStats {
    active: number;
    maximum: number;
}

type SessionState = "waiting" | "authorized" | "connected" | "disposing";

/**
 * 管理対象のLSPセッションです。
 */
interface ManagedSession {
    id: string;
    visitorId: string;
    clientIp: string;
    workspacePath: string;
    documentUri: string;
    workspaceUri: string;
    webSocketPath: string;
    ticketNonce: string;
    state: SessionState;
    idleTimer: NodeJS.Timeout;
    absoluteTimer: NodeJS.Timeout;
    ticketTimer: NodeJS.Timeout;
    webSocket: WebSocket | null;
    clangd: ChildProcessWithoutNullStreams | null;
    webSocketConnection: IConnection | null;
    clangdConnection: IConnection | null;
}

/**
 * セッション作成中に確保する上限カウンタです。
 */
interface Reservation {
    visitorId: string;
    clientIp: string;
}

/**
 * 一時workspace、clangd、接続期限をセッション単位で管理します。
 */
export class LspSessionManager {
    readonly #workspaceRoot: string;
    readonly #clangdPath: string;
    readonly #clangdSandboxPath: string | undefined;
    readonly #clangdLimiterPath: string | undefined;
    readonly #ticketService: TicketService;
    readonly #maxSessions: number;
    readonly #maxSessionsPerVisitor: number;
    readonly #maxSessionsPerIp: number;
    readonly #idleTtlMs: number;
    readonly #absoluteTtlMs: number;
    readonly #ticketTtlMs: number;
    readonly #now: () => number;
    readonly #sessions = new Map<string, ManagedSession>();
    readonly #cleanupPromises = new Map<string, Promise<void>>();
    readonly #pendingVisitors = new Map<string, number>();
    readonly #pendingIps = new Map<string, number>();
    #pendingCount = 0;
    #shuttingDown = false;

    /**
     * LSPセッション管理を初期化します。
     */
    public constructor(options: SessionManagerOptions) {
        this.#workspaceRoot = options.workspaceRoot;
        this.#clangdPath = options.clangdPath;
        this.#clangdSandboxPath = options.clangdSandboxPath;
        this.#clangdLimiterPath = options.clangdLimiterPath;
        this.#ticketService = options.ticketService;
        this.#maxSessions = options.maxSessions ?? DEFAULT_MAX_SESSIONS;
        this.#maxSessionsPerVisitor = options.maxSessionsPerVisitor ?? DEFAULT_MAX_SESSIONS_PER_VISITOR;
        this.#maxSessionsPerIp = options.maxSessionsPerIp ?? DEFAULT_MAX_SESSIONS_PER_IP;
        this.#idleTtlMs = options.idleTtlMs ?? DEFAULT_IDLE_TTL_MS;
        this.#absoluteTtlMs = options.absoluteTtlMs ?? DEFAULT_ABSOLUTE_TTL_MS;
        this.#ticketTtlMs = options.ticketTtlMs ?? DEFAULT_TICKET_TTL_MS;
        this.#now = options.now ?? Date.now;
    }

    /**
     * 一時workspaceを作成し、一回限りチケット付きセッションを返します。
     */
    public async createSession(request: InternalCreateLspSessionRequest): Promise<InternalCreateLspSessionResponse> {
        const reservation = this.#reserve(request.visitorId, request.clientIp);
        const sessionId = randomUUID();
        const workspacePath = join(this.#workspaceRoot, sessionId);

        try {
            await mkdir(workspacePath, { recursive: true, mode: 0o700 });
            await Promise.all([
                writeFile(join(workspacePath, "main.c"), request.source, { encoding: "utf8", mode: 0o600 }),
                writeFile(join(workspacePath, "compile_flags.txt"), COMPILE_FLAGS, {
                    encoding: "utf8",
                    mode: 0o600,
                }),
            ]);

            const webSocketPath = `/ws/lsp/${sessionId}`;
            const issuedTicket = this.#ticketService.issue(
                sessionId,
                request.visitorId,
                webSocketPath,
                this.#ticketTtlMs,
            );
            const createdAt = this.#now();
            const session = this.#createManagedSession(
                sessionId,
                request,
                workspacePath,
                createClangdDocumentUri(workspacePath, this.#clangdSandboxPath !== undefined),
                createClangdWorkspaceUri(workspacePath, this.#clangdSandboxPath !== undefined),
                webSocketPath,
                issuedTicket.payload.nonce,
            );
            this.#sessions.set(sessionId, session);

            return {
                id: sessionId,
                documentUri: session.documentUri,
                webSocketPath,
                expiresAt: new Date(createdAt + this.#absoluteTtlMs).toISOString(),
                ticket: issuedTicket.ticket,
            };
        } catch (error) {
            await rm(workspacePath, { recursive: true, force: true });
            throw error;
        } finally {
            this.#release(reservation);
        }
    }

    /**
     * Cookieの接続チケットを検証し、一度だけ消費します。
     */
    public authorizeWebSocket(sessionId: string, path: string, ticket: string | undefined): WebSocketAuthorization {
        const session = this.#sessions.get(sessionId);
        if (session === undefined) {
            return {
                authorized: false,
                status: 404,
                code: "session_not_found",
            };
        }
        if (ticket === undefined) {
            return {
                authorized: false,
                status: 401,
                code: "missing_ticket",
            };
        }
        if (session.state !== "waiting") {
            return {
                authorized: false,
                status: 409,
                code: "ticket_used",
            };
        }

        const verification = this.#ticketService.verify(ticket, {
            sessionId,
            visitorId: session.visitorId,
            path,
        });
        if (!verification.valid) {
            return {
                authorized: false,
                status: verification.reason === "expired" ? 410 : 401,
                code: verification.reason === "expired" ? "expired_ticket" : "invalid_ticket",
            };
        }
        if (verification.payload.nonce !== session.ticketNonce) {
            return {
                authorized: false,
                status: 401,
                code: "invalid_ticket",
            };
        }

        session.state = "authorized";
        clearTimeout(session.ticketTimer);
        this.#refreshIdleTimer(session);
        return {
            authorized: true,
            sessionId,
        };
    }

    /**
     * 標準handshake不正時、正しい未使用ticketに対応するsessionだけを即時破棄します。
     */
    public discardSessionAfterInvalidHandshake(sessionId: string, path: string, ticket: string | undefined): boolean {
        const session = this.#sessions.get(sessionId);
        if (session === undefined || session.state !== "waiting" || ticket === undefined) {
            return false;
        }

        const verification = this.#ticketService.verify(ticket, {
            sessionId,
            visitorId: session.visitorId,
            path,
        });
        if (!verification.valid || verification.payload.nonce !== session.ticketNonce) {
            return false;
        }

        void this.closeSession(sessionId, 1008, "Invalid WebSocket handshake");
        return true;
    }

    /**
     * 認証済みWebSocketへclangdのstdioを接続します。
     */
    public attachWebSocket(sessionId: string, webSocket: WebSocket): void {
        const session = this.#sessions.get(sessionId);
        if (session === undefined || session.state !== "authorized") {
            webSocket.close(1008, "Session is not authorized");
            return;
        }

        session.state = "connected";
        session.webSocket = webSocket;
        const adapter = new JsonRpcWebSocketAdapter(
            webSocket,
            new LspJsonRpcGuard({
                documentUri: session.documentUri,
                workspaceUri: session.workspaceUri,
            }),
            () => this.#touchSession(sessionId),
            (closeCode, closeReason) => {
                void this.closeSession(sessionId, closeCode, closeReason);
            },
        );
        const clangd = this.#spawnClangd(session.workspacePath);
        session.clangd = clangd;
        session.webSocketConnection = createWebSocketConnection(adapter);
        const clangdConnection = createProcessStreamConnection(clangd);

        if (clangdConnection === undefined) {
            void this.closeSession(sessionId, 1011, "clangd streams are unavailable");
            return;
        }
        session.clangdConnection = clangdConnection;

        // vscode-ws-jsonrpcにフレーミングを任せ、JSON-RPCの内容は変更せず中継します。
        forward(session.webSocketConnection, session.clangdConnection);
        webSocket.once("close", () => {
            void this.closeSession(sessionId);
        });
        webSocket.once("error", () => {
            void this.closeSession(sessionId, 1011, "WebSocket error");
        });
        clangd.once("error", () => {
            void this.closeSession(sessionId, 1011, "clangd failed to start");
        });
        clangd.once("exit", () => {
            void this.closeSession(sessionId, 1011, "clangd stopped");
        });
        this.#refreshIdleTimer(session);
    }

    /**
     * 指定セッションと子プロセス・workspaceを完全に破棄します。
     */
    public async closeSession(sessionId: string, closeCode = 1000, closeReason = "Session closed"): Promise<void> {
        const existingCleanup = this.#cleanupPromises.get(sessionId);
        if (existingCleanup !== undefined) {
            return existingCleanup;
        }

        const cleanup = this.#performCleanup(sessionId, closeCode, closeReason);
        this.#cleanupPromises.set(sessionId, cleanup);
        try {
            await cleanup;
        } finally {
            this.#cleanupPromises.delete(sessionId);
        }
    }

    /**
     * 新規受付を停止し、全セッションを並列で破棄します。
     */
    public async shutdown(): Promise<void> {
        this.#shuttingDown = true;
        await Promise.all(
            [...this.#sessions.keys()].map((sessionId) => this.closeSession(sessionId, 1012, "Service is restarting")),
        );
    }

    /**
     * 現在のセッション数と全体上限を返します。
     */
    public stats(): SessionStats {
        return {
            active: this.#sessions.size,
            maximum: this.#maxSessions,
        };
    }

    /**
     * 新規セッションを受け付けられる状態か返します。
     */
    public isAcceptingSessions(): boolean {
        return !this.#shuttingDown;
    }

    /**
     * 作成中セッションの枠を同期的に確保します。
     */
    #reserve(visitorId: string, clientIp: string): Reservation {
        if (this.#shuttingDown) {
            throw new SessionLimitError("shutting_down");
        }

        const activeVisitorCount = this.#countByVisitor(visitorId) + (this.#pendingVisitors.get(visitorId) ?? 0);
        const activeIpCount = this.#countByIp(clientIp) + (this.#pendingIps.get(clientIp) ?? 0);
        if (this.#sessions.size + this.#pendingCount >= this.#maxSessions) {
            throw new SessionLimitError("global");
        }
        if (activeVisitorCount >= this.#maxSessionsPerVisitor) {
            throw new SessionLimitError("visitor");
        }
        if (activeIpCount >= this.#maxSessionsPerIp) {
            throw new SessionLimitError("ip");
        }

        this.#pendingCount += 1;
        incrementCount(this.#pendingVisitors, visitorId);
        incrementCount(this.#pendingIps, clientIp);
        return { visitorId, clientIp };
    }

    /**
     * 作成完了または失敗後に予約枠を解放します。
     */
    #release(reservation: Reservation): void {
        this.#pendingCount -= 1;
        decrementCount(this.#pendingVisitors, reservation.visitorId);
        decrementCount(this.#pendingIps, reservation.clientIp);
    }

    /**
     * セッション本体と各期限タイマーを構築します。
     */
    #createManagedSession(
        sessionId: string,
        request: InternalCreateLspSessionRequest,
        workspacePath: string,
        documentUri: string,
        workspaceUri: string,
        webSocketPath: string,
        ticketNonce: string,
    ): ManagedSession {
        const session = {
            id: sessionId,
            visitorId: request.visitorId,
            clientIp: request.clientIp,
            workspacePath,
            documentUri,
            workspaceUri,
            webSocketPath,
            ticketNonce,
            state: "waiting" as const,
            idleTimer: setTimeout(() => undefined, this.#idleTtlMs),
            absoluteTimer: setTimeout(() => undefined, this.#absoluteTtlMs),
            ticketTimer: setTimeout(() => undefined, this.#ticketTtlMs),
            webSocket: null,
            clangd: null,
            webSocketConnection: null,
            clangdConnection: null,
        };

        clearTimeout(session.idleTimer);
        clearTimeout(session.absoluteTimer);
        clearTimeout(session.ticketTimer);
        session.idleTimer = this.#scheduleClose(sessionId, this.#idleTtlMs, "Idle timeout");
        session.absoluteTimer = this.#scheduleClose(sessionId, this.#absoluteTtlMs, "Absolute timeout");
        session.ticketTimer = this.#scheduleClose(sessionId, this.#ticketTtlMs, "Ticket expired");
        return session;
    }

    /**
     * 指定時間後にセッションを閉じるタイマーを作成します。
     */
    #scheduleClose(sessionId: string, delayMs: number, reason: string): NodeJS.Timeout {
        const timer = setTimeout(() => {
            void this.closeSession(sessionId, 1008, reason);
        }, delayMs);
        timer.unref();
        return timer;
    }

    /**
     * 双方向通信があったセッションのidle期限を延長します。
     */
    #touchSession(sessionId: string): void {
        const session = this.#sessions.get(sessionId);
        if (session !== undefined && session.state === "connected") {
            this.#refreshIdleTimer(session);
        }
    }

    /**
     * idleタイマーのみを現在時刻から張り直します。
     */
    #refreshIdleTimer(session: ManagedSession): void {
        clearTimeout(session.idleTimer);
        session.idleTimer = this.#scheduleClose(session.id, this.#idleTtlMs, "Idle timeout");
    }

    /**
     * workspaceを作業ディレクトリとしてclangdを起動します。
     */
    #spawnClangd(workspacePath: string): ChildProcessWithoutNullStreams {
        const spec = createClangdProcessSpec({
            clangdPath: this.#clangdPath,
            workspacePath,
            sandboxPath: this.#clangdSandboxPath,
            limiterPath: this.#clangdLimiterPath,
        });
        const clangd = spawn(spec.command, spec.arguments, {
            ...spec.options,
            stdio: ["pipe", "pipe", "pipe"],
        });

        // stderrを読み捨ててpipeの背圧を避けます。利用者コードや診断内容はログへ残しません。
        clangd.stderr.resume();
        return clangd;
    }

    /**
     * 管理表から外した後、接続・子プロセス・ファイルを順番に破棄します。
     */
    async #performCleanup(sessionId: string, closeCode: number, closeReason: string): Promise<void> {
        const session = this.#sessions.get(sessionId);
        if (session === undefined) {
            return;
        }

        session.state = "disposing";
        this.#sessions.delete(sessionId);
        clearTimeout(session.idleTimer);
        clearTimeout(session.absoluteTimer);
        clearTimeout(session.ticketTimer);

        if (session.webSocket !== null && session.webSocket.readyState === WebSocket.OPEN) {
            session.webSocket.close(closeCode, closeReason);
        }
        session.webSocketConnection?.dispose();
        session.clangdConnection?.dispose();
        await stopChildProcess(session.clangd);
        await rm(session.workspacePath, { recursive: true, force: true });
    }

    /**
     * 同じvisitorIdの有効セッション数を数えます。
     */
    #countByVisitor(visitorId: string): number {
        return countSessions(this.#sessions.values(), (session) => session.visitorId === visitorId);
    }

    /**
     * 同じclientIpの有効セッション数を数えます。
     */
    #countByIp(clientIp: string): number {
        return countSessions(this.#sessions.values(), (session) => session.clientIp === clientIp);
    }
}

/**
 * wsパッケージのWebSocketをvscode-ws-jsonrpc形式へ変換します。
 */
class JsonRpcWebSocketAdapter implements IWebSocket {
    readonly #webSocket: WebSocket;
    readonly #guard: LspJsonRpcGuard;
    readonly #onActivity: () => void;
    readonly #onViolation: (closeCode: number, closeReason: string) => void;
    #violated = false;

    /**
     * WebSocket adapterを初期化します。
     */
    public constructor(
        webSocket: WebSocket,
        guard: LspJsonRpcGuard,
        onActivity: () => void,
        onViolation: (closeCode: number, closeReason: string) => void,
    ) {
        this.#webSocket = webSocket;
        this.#guard = guard;
        this.#onActivity = onActivity;
        this.#onViolation = onViolation;
    }

    /**
     * JSON-RPCテキストをブラウザへ送信します。
     */
    public send(content: string): void {
        if (this.#webSocket.readyState !== WebSocket.OPEN) {
            return;
        }

        const validation = this.#guard.validateServerMessage(content, this.#webSocket.bufferedAmount);
        if (!validation.accepted) {
            this.#reportViolation(validation.closeCode, validation.reason);
            return;
        }

        this.#onActivity();
        this.#webSocket.send(content);
    }

    /**
     * ブラウザから受け取ったテキストをJSON-RPC readerへ渡します。
     */
    public onMessage(callback: (data: unknown) => void): void {
        this.#webSocket.on("message", (data, isBinary) => {
            if (isBinary) {
                this.#reportViolation(1003, "Text frames are required");
                return;
            }

            const content = data.toString("utf8");
            const validation = this.#guard.validateClientMessage(content);
            if (!validation.accepted) {
                this.#reportViolation(validation.closeCode, validation.reason);
                return;
            }

            this.#onActivity();
            callback(content);
        });
    }

    /**
     * WebSocketエラーをJSON-RPC connectionへ通知します。
     */
    public onError(callback: (reason: unknown) => void): void {
        this.#webSocket.on("error", callback);
    }

    /**
     * WebSocket終了をJSON-RPC connectionへ通知します。
     */
    public onClose(callback: (code: number, reason: string) => void): void {
        this.#webSocket.on("close", (code, reason) => callback(code, reason.toString("utf8")));
    }

    /**
     * adapter破棄時にWebSocketを閉じます。
     */
    public dispose(): void {
        if (this.#webSocket.readyState === WebSocket.OPEN) {
            this.#webSocket.close(1000, "Connection disposed");
        }
    }

    /**
     * 境界違反を一度だけセッション管理へ通知します。
     */
    #reportViolation(closeCode: number, closeReason: string): void {
        if (this.#violated) {
            return;
        }
        this.#violated = true;
        this.#onViolation(closeCode, closeReason);
    }
}

/**
 * 文字列ごとの予約数を1件増やします。
 */
function incrementCount(counts: Map<string, number>, key: string): void {
    counts.set(key, (counts.get(key) ?? 0) + 1);
}

/**
 * 文字列ごとの予約数を1件減らし、0件ならキーを削除します。
 */
function decrementCount(counts: Map<string, number>, key: string): void {
    const nextCount = (counts.get(key) ?? 1) - 1;
    if (nextCount <= 0) {
        counts.delete(key);
        return;
    }
    counts.set(key, nextCount);
}

/**
 * 条件に一致するセッションを数えます。
 */
function countSessions(sessions: Iterable<ManagedSession>, predicate: (session: ManagedSession) => boolean): number {
    let count = 0;
    for (const session of sessions) {
        if (predicate(session)) {
            count += 1;
        }
    }
    return count;
}

/**
 * clangdへSIGTERMを送り、終了しなければSIGKILLで回収します。
 */
async function stopChildProcess(child: ChildProcessWithoutNullStreams | null): Promise<void> {
    if (child === null || child.exitCode !== null || child.signalCode !== null) {
        return;
    }

    child.kill("SIGTERM");
    const exited = await Promise.race([
        once(child, "exit").then(() => true),
        wait(PROCESS_SHUTDOWN_GRACE_MS).then(() => false),
    ]);
    if (!exited && child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
        await Promise.race([once(child, "exit"), wait(PROCESS_SHUTDOWN_GRACE_MS)]);
    }
}

/**
 * 指定時間だけ待機します。
 */
async function wait(milliseconds: number): Promise<void> {
    await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, milliseconds);
        timer.unref();
    });
}
