import { afterEach, describe, expect, it, vi } from "vitest";

import {
    countDiagnostics,
    DeferredDisposer,
    getNextLspReconnectDelay,
    WebSocketLspTransport,
} from "@/lib/client/lsp-transport";

/**
 * WebSocket TransportをNode環境で検証する最小fakeです。
 */
class FakeWebSocket extends EventTarget {
    constructor(public readyState = 0) {
        super();
    }

    readonly sentMessages: string[] = [];
    readonly closeCalls: Array<{ code?: number; reason?: string }> = [];

    /**
     * fake接続をopen状態へ進めます。
     */
    open(): void {
        this.readyState = 1;
        this.dispatchEvent(new Event("open"));
    }

    /**
     * raw WebSocket messageを記録します。
     */
    send(message: string): void {
        this.sentMessages.push(message);
    }

    /**
     * close要求を記録します。
     */
    close(code?: number, reason?: string): void {
        this.readyState = 2;
        this.closeCalls.push({ code, reason });
    }

    /**
     * serverからtext messageを受信させます。
     */
    receive(message: string): void {
        this.dispatchEvent(new MessageEvent("message", { data: message }));
    }

    /**
     * WebSocket errorを発生させます。
     */
    fail(): void {
        this.dispatchEvent(new Event("error"));
    }

    /**
     * 予期しないcloseを発生させます。
     */
    disconnect(): void {
        this.readyState = 3;
        this.dispatchEvent(new Event("close"));
    }
}

/**
 * fake WebSocketをDOM WebSocket型としてTransportへ渡します。
 */
function asWebSocket(socket: FakeWebSocket): WebSocket {
    return socket as unknown as WebSocket;
}

afterEach(() => {
    vi.useRealTimers();
});

describe("WebSocketLspTransport", () => {
    it("constructor時点でopen済みなら直ちに利用できる", async () => {
        const socket = new FakeWebSocket(1);
        const transport = new WebSocketLspTransport(asWebSocket(socket), vi.fn());

        await expect(transport.waitUntilOpen()).resolves.toBeUndefined();
        transport.send("message");

        expect(socket.sentMessages).toEqual(["message"]);
    });

    it("openを待ってraw JSON文字列を送信する", async () => {
        const socket = new FakeWebSocket();
        const transport = new WebSocketLspTransport(asWebSocket(socket), vi.fn());
        const opening = transport.waitUntilOpen();

        socket.open();
        await opening;
        transport.send('{"jsonrpc":"2.0"}');

        expect(socket.sentMessages).toEqual(['{"jsonrpc":"2.0"}']);
    });

    it("messageを全購読者へ送り、unsubscribe後は送らない", async () => {
        const socket = new FakeWebSocket();
        const transport = new WebSocketLspTransport(asWebSocket(socket), vi.fn());
        const first = vi.fn();
        const second = vi.fn();
        transport.subscribe(first);
        transport.subscribe(second);
        socket.open();
        await transport.waitUntilOpen();

        socket.receive("first-message");
        transport.unsubscribe(first);
        socket.receive("second-message");

        expect(first).toHaveBeenCalledTimes(1);
        expect(first).toHaveBeenCalledWith("first-message");
        expect(second).toHaveBeenNthCalledWith(1, "first-message");
        expect(second).toHaveBeenNthCalledWith(2, "second-message");
    });

    it("errorと後続closeを予期しない切断として一度だけ通知する", async () => {
        const socket = new FakeWebSocket();
        const onUnexpectedDisconnect = vi.fn();
        const transport = new WebSocketLspTransport(asWebSocket(socket), onUnexpectedDisconnect);
        const opening = transport.waitUntilOpen();

        socket.fail();
        socket.disconnect();

        await expect(opening).rejects.toThrow("接続に失敗");
        expect(onUnexpectedDisconnect).toHaveBeenCalledOnce();
        expect(onUnexpectedDisconnect).toHaveBeenCalledWith("error");
    });

    it("open後の予期しないcloseを一度だけ通知する", async () => {
        const socket = new FakeWebSocket();
        const onUnexpectedDisconnect = vi.fn();
        const transport = new WebSocketLspTransport(asWebSocket(socket), onUnexpectedDisconnect);
        socket.open();
        await transport.waitUntilOpen();

        socket.disconnect();
        socket.fail();

        expect(onUnexpectedDisconnect).toHaveBeenCalledOnce();
        expect(onUnexpectedDisconnect).toHaveBeenCalledWith("close");
    });

    it("open timeoutを一度だけ通知し、後からopenしても待機結果を変えない", async () => {
        vi.useFakeTimers();
        const socket = new FakeWebSocket();
        const onUnexpectedDisconnect = vi.fn();
        const transport = new WebSocketLspTransport(asWebSocket(socket), onUnexpectedDisconnect);
        const opening = transport.waitUntilOpen(1_000);

        await vi.advanceTimersByTimeAsync(1_000);
        socket.open();

        await expect(opening).rejects.toThrow("timeout");
        await expect(transport.waitUntilOpen()).rejects.toThrow("timeout");
        expect(onUnexpectedDisconnect).toHaveBeenCalledOnce();
        expect(onUnexpectedDisconnect).toHaveBeenCalledWith("timeout");
    });

    it("明示disposeでは切断通知を抑止してsocketを一度だけ閉じる", async () => {
        const socket = new FakeWebSocket();
        const onUnexpectedDisconnect = vi.fn();
        const transport = new WebSocketLspTransport(asWebSocket(socket), onUnexpectedDisconnect);
        socket.open();
        await transport.waitUntilOpen();

        transport.dispose();
        transport.dispose();
        const closed = transport.waitUntilClosed();
        socket.disconnect();

        await closed;
        expect(transport.isDisposed).toBe(true);
        expect(socket.closeCalls).toEqual([{ code: 1000, reason: "client dispose" }]);
        expect(onUnexpectedDisconnect).not.toHaveBeenCalled();
    });

    it("接続待機中の明示disposeでは待機を拒否し、切断通知を抑止する", async () => {
        const socket = new FakeWebSocket();
        const onUnexpectedDisconnect = vi.fn();
        const transport = new WebSocketLspTransport(asWebSocket(socket), onUnexpectedDisconnect);
        const opening = transport.waitUntilOpen();

        transport.dispose();

        await expect(opening).rejects.toThrow("破棄");
        expect(socket.closeCalls).toEqual([{ code: 1000, reason: "client dispose" }]);
        expect(onUnexpectedDisconnect).not.toHaveBeenCalled();
    });

    it("open前のsendを拒否する", () => {
        const socket = new FakeWebSocket();
        const transport = new WebSocketLspTransport(asWebSocket(socket), vi.fn());

        expect(() => transport.send("message")).toThrow("送信可能な状態ではありません");
    });
});

describe("LSP helper", () => {
    it("予期しない切断を3回まで段階的に再接続する", () => {
        expect(getNextLspReconnectDelay(0)).toBe(750);
        expect(getNextLspReconnectDelay(1)).toBe(1_500);
        expect(getNextLspReconnectDelay(2)).toBe(2_250);
        expect(getNextLspReconnectDelay(3)).toBeUndefined();
    });

    it("errorとwarningだけを集計する", () => {
        expect(
            countDiagnostics([
                { severity: "error" },
                { severity: "warning" },
                { severity: "warning" },
                { severity: "info" },
                { severity: "hint" },
            ]),
        ).toEqual({
            errors: 1,
            warnings: 2,
        });
    });

    it("診断がなければerrorとwarningをゼロへ戻す", () => {
        expect(countDiagnostics([])).toEqual({
            errors: 0,
            warnings: 0,
        });
    });
});

describe("DeferredDisposer", () => {
    it("Strict Mode相当のcleanup直後のsetupでは破棄を取り消す", async () => {
        vi.useFakeTimers();
        const dispose = vi.fn();
        const disposer = new DeferredDisposer();

        disposer.acquire();
        disposer.release(dispose);
        disposer.acquire();
        await vi.runAllTimersAsync();

        expect(dispose).not.toHaveBeenCalled();
        expect(disposer.isDisposed).toBe(false);

        disposer.release(dispose);
        await vi.runAllTimersAsync();

        expect(dispose).toHaveBeenCalledOnce();
        expect(disposer.isDisposed).toBe(true);
        expect(() => disposer.acquire()).toThrow("破棄済み");
    });

    it("Strict Mode相当のsetup・cleanup・setupでWebSocketを一度だけ生成する", async () => {
        vi.useFakeTimers();
        const createSocket = vi.fn(() => new FakeWebSocket());
        const disposer = new DeferredDisposer();
        let transport: WebSocketLspTransport | undefined;

        /** Effect setupと同じ順序でTransportを取得し、遅延cleanupを返します。 */
        const setup = (): (() => void) => {
            transport ??= new WebSocketLspTransport(asWebSocket(createSocket()), vi.fn());
            disposer.acquire();
            return () => {
                disposer.release(() => transport?.dispose());
            };
        };

        const firstCleanup = setup();
        firstCleanup();
        const secondCleanup = setup();
        await vi.runAllTimersAsync();

        expect(createSocket).toHaveBeenCalledOnce();
        expect(createSocket.mock.results[0]?.value.closeCalls).toEqual([]);

        secondCleanup();
        await vi.runAllTimersAsync();

        expect(createSocket.mock.results[0]?.value.closeCalls).toEqual([{ code: 1000, reason: "client dispose" }]);
    });
});
