import type { Transport } from "@codemirror/lsp-client";

import type { DiagnosticCounts } from "@/types/wire";

const SOCKET_CONNECTING = 0;
const SOCKET_OPEN = 1;
const SOCKET_CLOSED = 3;
const DEFAULT_OPEN_TIMEOUT_MS = 10_000;

/**
 * LSP WebSocketが予期せず利用不能になった理由です。
 */
export type LspDisconnectReason = "error" | "close" | "timeout";

/**
 * React Strict Modeの直後の再setupで取り消せる、macrotask遅延破棄を管理します。
 *
 * 単一のEffect所有者がsetup時に`acquire`、cleanup時に`release`を呼ぶ用途に限定します。
 */
export class DeferredDisposer {
    private disposeTimer: ReturnType<typeof setTimeout> | undefined;
    private disposed = false;

    /**
     * 保留中の破棄を取り消し、resourceの再利用を開始します。
     */
    acquire(): void {
        if (this.disposed) {
            throw new Error("破棄済みのresourceは再利用できません。");
        }

        if (this.disposeTimer !== undefined) {
            clearTimeout(this.disposeTimer);
            this.disposeTimer = undefined;
        }
    }

    /**
     * 次のmacrotaskでresourceを一度だけ破棄します。
     */
    release(dispose: () => void): void {
        if (this.disposed || this.disposeTimer !== undefined) {
            return;
        }

        this.disposeTimer = setTimeout(() => {
            this.disposeTimer = undefined;
            this.disposed = true;
            dispose();
        }, 0);
    }

    /**
     * resourceの破棄が完了しているかを返します。
     */
    get isDisposed(): boolean {
        return this.disposed;
    }
}

/**
 * CodeMirror LSP clientへraw JSON文字列を中継するWebSocket Transportです。
 */
export class WebSocketLspTransport implements Transport {
    private readonly subscribers = new Set<(message: string) => void>();
    private readonly openPromise: Promise<void>;
    private readonly closedPromise: Promise<void>;
    private resolveOpen: (() => void) | undefined;
    private rejectOpen: ((error: Error) => void) | undefined;
    private resolveClosed: (() => void) | undefined;
    private openTimer: ReturnType<typeof setTimeout> | undefined;
    private openSettled = false;
    private unavailableNotified = false;
    private disposed = false;

    /**
     * 接続済みまたは接続中のWebSocketをCodeMirror Transportとして包みます。
     */
    constructor(
        private readonly socket: WebSocket,
        private readonly onUnexpectedDisconnect: (reason: LspDisconnectReason) => void,
    ) {
        this.openPromise = new Promise<void>((resolve, reject) => {
            this.resolveOpen = resolve;
            this.rejectOpen = reject;
        });
        this.closedPromise = new Promise<void>((resolve) => {
            this.resolveClosed = resolve;
        });
        // 呼び出し側がwaitを開始する前に失敗してもunhandled rejectionにはしません。
        void this.openPromise.catch(() => undefined);

        this.socket.addEventListener("open", this.handleOpen);
        this.socket.addEventListener("message", this.handleMessage);
        this.socket.addEventListener("error", this.handleError);
        this.socket.addEventListener("close", this.handleClose);

        if (this.socket.readyState === SOCKET_OPEN) {
            this.settleOpen();
        } else if (this.socket.readyState !== SOCKET_CONNECTING) {
            this.failOpen("LSP WebSocketは接続を開始できない状態です。");
            this.notifyUnexpectedDisconnect("close");
            if (this.socket.readyState === SOCKET_CLOSED) {
                this.settleClosed();
            }
        }
    }

    /**
     * WebSocketのopen完了まで待機し、指定時間を超えた場合は接続不能として拒否します。
     */
    waitUntilOpen(timeoutMs = DEFAULT_OPEN_TIMEOUT_MS): Promise<void> {
        if (!this.openSettled && this.openTimer === undefined) {
            if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
                throw new Error("LSP WebSocketの接続timeoutは0以上の有限値で指定してください。");
            }

            this.openTimer = setTimeout(() => {
                this.openTimer = undefined;
                this.failOpen("LSP WebSocketの接続がtimeoutしました。");
                this.notifyUnexpectedDisconnect("timeout");
            }, timeoutMs);
        }

        return this.openPromise;
    }

    /**
     * raw JSON-RPC文字列を接続済みWebSocketへ送信します。
     */
    send(message: string): void {
        if (this.disposed || this.socket.readyState !== SOCKET_OPEN) {
            throw new Error("LSP WebSocketは送信可能な状態ではありません。");
        }

        this.socket.send(message);
    }

    /**
     * CodeMirror LSP clientの受信handlerを登録します。
     */
    subscribe(handler: (message: string) => void): void {
        this.subscribers.add(handler);
    }

    /**
     * CodeMirror LSP clientの受信handlerを解除します。
     */
    unsubscribe(handler: (message: string) => void): void {
        this.subscribers.delete(handler);
    }

    /**
     * Transportを意図的に破棄し、WebSocketと全購読を閉じます。
     */
    dispose(): void {
        if (this.disposed) {
            return;
        }

        this.disposed = true;
        this.subscribers.clear();
        this.socket.removeEventListener("open", this.handleOpen);
        this.socket.removeEventListener("message", this.handleMessage);
        this.socket.removeEventListener("error", this.handleError);

        if (!this.openSettled) {
            this.failOpen("LSP WebSocketの接続待機中にTransportが破棄されました。");
        }

        if (this.socket.readyState === SOCKET_CONNECTING || this.socket.readyState === SOCKET_OPEN) {
            this.socket.close(1000, "client dispose");
        } else if (this.socket.readyState === SOCKET_CLOSED) {
            this.settleClosed();
        }
    }

    /**
     * WebSocketのclose handshake完了まで待機します。
     */
    waitUntilClosed(): Promise<void> {
        return this.closedPromise;
    }

    /**
     * Transportの破棄が完了しているかを返します。
     */
    get isDisposed(): boolean {
        return this.disposed;
    }

    private readonly handleOpen = (): void => {
        if (!this.disposed) {
            this.settleOpen();
        }
    };

    private readonly handleMessage = (event: MessageEvent<unknown>): void => {
        if (this.disposed || typeof event.data !== "string") {
            return;
        }

        // handler内でunsubscribeされても、このmessageのfan-outは最後まで行います。
        for (const subscriber of [...this.subscribers]) {
            subscriber(event.data);
        }
    };

    private readonly handleError = (): void => {
        if (this.disposed) {
            return;
        }

        this.failOpen("LSP WebSocketの接続に失敗しました。");
        this.notifyUnexpectedDisconnect("error");
    };

    private readonly handleClose = (): void => {
        this.settleClosed();
        if (this.disposed) {
            return;
        }

        this.failOpen("LSP WebSocketが接続前に切断されました。");
        this.notifyUnexpectedDisconnect("close");
    };

    private settleOpen(): void {
        if (this.openSettled) {
            return;
        }

        this.clearOpenTimer();
        this.openSettled = true;
        this.resolveOpen?.();
        this.resolveOpen = undefined;
        this.rejectOpen = undefined;
    }

    private failOpen(message: string): void {
        if (this.openSettled) {
            return;
        }

        this.clearOpenTimer();
        this.openSettled = true;
        this.rejectOpen?.(new Error(message));
        this.resolveOpen = undefined;
        this.rejectOpen = undefined;
    }

    private notifyUnexpectedDisconnect(reason: LspDisconnectReason): void {
        if (this.unavailableNotified) {
            return;
        }

        this.unavailableNotified = true;
        this.onUnexpectedDisconnect(reason);
    }

    private settleClosed(): void {
        this.resolveClosed?.();
        this.resolveClosed = undefined;
        this.detachSocketListeners();
    }

    private detachSocketListeners(): void {
        this.socket.removeEventListener("open", this.handleOpen);
        this.socket.removeEventListener("message", this.handleMessage);
        this.socket.removeEventListener("error", this.handleError);
        this.socket.removeEventListener("close", this.handleClose);
    }

    private clearOpenTimer(): void {
        if (this.openTimer !== undefined) {
            clearTimeout(this.openTimer);
            this.openTimer = undefined;
        }
    }
}

/**
 * CodeMirror上の診断からerrorとwarningだけを集計します。
 */
export function countDiagnostics(diagnostics: Iterable<{ readonly severity: string }>): DiagnosticCounts {
    let errors = 0;
    let warnings = 0;

    for (const diagnostic of diagnostics) {
        if (diagnostic.severity === "error") {
            errors += 1;
        } else if (diagnostic.severity === "warning") {
            warnings += 1;
        }
    }

    return {
        errors,
        warnings,
    };
}
