"use client";

import dynamic from "next/dynamic";
import { isValidSourceFileName, SOURCE_FILE_MAX_COUNT } from "@smart-c/contracts";
import { IconPlus, IconX, IconAlertTriangleFilled, IconAlertCircleFilled } from "@tabler/icons-react";
import {
    type CSSProperties,
    type KeyboardEvent as ReactKeyboardEvent,
    type PointerEvent as ReactPointerEvent,
    useCallback,
    useEffect,
    useRef,
    useState,
} from "react";

import { InteractiveTerminal, type InteractiveTerminalHandle } from "@/components/interactive-terminal";
import { ApiError, createExecution, createLspSession } from "@/lib/client/api";
import { getNextLspReconnectDelay } from "@/lib/client/lsp-transport";
import {
    DEFAULT_PROJECT,
    DEFAULT_SETTINGS,
    loadProject,
    loadSettings,
    saveProject,
    saveSettings,
} from "@/lib/client/storage";
import { sendJsonMessage, toWebSocketUrl } from "@/lib/client/websocket";
import type {
    CSourceFile,
    DiagnosticCounts,
    ExecutionClientEvent,
    ExecutionExitEvent,
    ExecutionPhase,
    ExecutionResponse,
    ExecutionServerEvent,
    LspSessionResponse,
    LspStatus,
    PersistedSettings,
    TerminalSize,
} from "@/types/wire";

const CodeEditor = dynamic(() => import("@/components/code-editor").then((module) => module.CodeEditor), {
    ssr: false,
    loading: () => (
        <div className="grid h-full place-items-center bg-surface font-mono text-xs text-muted" role="status">
            エディターを準備しています
        </div>
    ),
});

const ACTIVE_EXECUTION_PHASES = new Set<ExecutionPhase>(["creating", "queued", "compiling", "running"]);

const STATUS_DOT_CLASS_NAMES = {
    idle: "bg-transparent",
    connecting: "bg-transparent text-warning",
    connected: "bg-current text-success",
    reconnecting: "bg-transparent text-warning",
    unavailable: "bg-current text-danger",
    creating: "bg-transparent text-warning",
    queued: "bg-transparent text-warning",
    compiling: "bg-transparent text-warning",
    compile_failed: "bg-current text-danger",
    running: "bg-current text-success",
    exited: "bg-current text-success",
    timed_out: "bg-current text-danger",
    resource_limited: "bg-current text-danger",
    cancelled: "bg-current text-muted",
    sandbox_violation: "bg-current text-danger",
    disconnected: "bg-current text-danger",
} satisfies Record<LspStatus | ExecutionPhase, string>;

/**
 * 実行フェーズを画面表示用の短い日本語へ変換します。
 */
function getExecutionPhaseLabel(phase: ExecutionPhase): string {
    const labels: Record<ExecutionPhase, string> = {
        idle: "待機中",
        creating: "準備中",
        queued: "待機列",
        compiling: "コンパイル中",
        compile_failed: "コンパイル失敗",
        running: "実行中",
        exited: "終了",
        timed_out: "時間切れ",
        resource_limited: "資源上限",
        cancelled: "停止済み",
        sandbox_violation: "安全制限",
        disconnected: "切断",
    };
    return labels[phase];
}

/**
 * LSP接続状態を画面表示用の日本語へ変換します。
 */
function getLspStatusLabel(status: LspStatus): string {
    const labels: Record<LspStatus, string> = {
        idle: "LSP 待機中",
        connecting: "LSP 接続中",
        connected: "LSP 接続済み",
        reconnecting: "LSP 再接続中",
        unavailable: "LSP 利用不可",
    };
    return labels[status];
}

/**
 * APIエラーを、初学者が次の操作を判断できる文面へ整形します。
 */
function formatApiError(error: unknown): string {
    if (error instanceof ApiError) {
        const retry =
            error.retryAfterSeconds === undefined ? "" : `（約${error.retryAfterSeconds}秒後に再試行できます）`;
        return `${error.message}${retry}`;
    }

    return "サービスへ接続できませんでした。しばらく待ってから再試行してください。";
}

/**
 * Executorの終了理由をUI側の最終フェーズへ変換します。
 */
function getExitPhase(event: ExecutionExitEvent): ExecutionPhase {
    switch (event.reason) {
        case "compile_failed":
            return "compile_failed";
        case "timed_out":
            return "timed_out";
        case "resource_limited":
            return "resource_limited";
        case "cancelled":
            return "cancelled";
        case "sandbox_violation":
            return "sandbox_violation";
        default:
            return "exited";
    }
}

/**
 * 実行終了イベントを端末末尾へ表示する一行へ変換します。
 */
function formatExitMessage(event: ExecutionExitEvent): string {
    switch (event.reason) {
        case "compile_failed":
            return "コンパイルに失敗しました。上のエラーを確認してください。";
        case "timed_out":
            return "実行時間の上限に達したため停止しました。";
        case "resource_limited":
            return "メモリ・プロセス数・出力量の上限に達しました。";
        case "cancelled":
            return "実行を停止しました。";
        case "sandbox_violation":
            return "許可されていない操作を検出したため停止しました。";
        case "internal_error":
            return "実行環境で内部エラーが発生しました。";
        default: {
            if (event.code !== null) {
                return `終了コード ${event.code} で終了しました。`;
            }
            if (event.signal !== null) {
                return `シグナル ${event.signal} で終了しました。`;
            }
            return "プログラムが終了しました。";
        }
    }
}

/**
 * JSON文字列を実行WebSocketの既知メッセージとして読み込みます。
 */
function parseServerEvent(data: string): ExecutionServerEvent | undefined {
    try {
        const value = JSON.parse(data) as Partial<ExecutionServerEvent>;
        return typeof value.type === "string" ? (value as ExecutionServerEvent) : undefined;
    } catch {
        return undefined;
    }
}

/**
 * 作成・変更後のファイル名がプロジェクト内で利用可能か確認します。
 */
function getFileNameError(files: CSourceFile[], name: string, currentName?: string): string | undefined {
    if (!isValidSourceFileName(name)) {
        return "ファイル名は英数字、ハイフン、アンダースコアを使った.cまたは.hにしてください。";
    }
    if (files.some((file) => file.name !== currentName && file.name.toLowerCase() === name.toLowerCase())) {
        return "同じファイル名が既にあります。";
    }
    return undefined;
}

/**
 * エディター、clangd、対話端末を一画面に統合するメインUIです。
 */
export function Playground() {
    const [files, setFiles] = useState<CSourceFile[]>(DEFAULT_PROJECT.files);
    const [activeFileName, setActiveFileName] = useState(DEFAULT_PROJECT.activeFileName);
    const [hydrated, setHydrated] = useState(false);
    const [settings, setSettings] = useState<PersistedSettings>(DEFAULT_SETTINGS);
    const [isMobile, setIsMobile] = useState(false);
    const [lspSession, setLspSession] = useState<LspSessionResponse>();
    const [lspStatus, setLspStatus] = useState<LspStatus>("idle");
    const [diagnostics, setDiagnostics] = useState<DiagnosticCounts>({
        errors: 0,
        warnings: 0,
    });
    const [executionPhase, setExecutionPhase] = useState<ExecutionPhase>("idle");
    const [systemMessage, setSystemMessage] = useState("");
    const [lspCycle, setLspCycle] = useState(0);

    const workspaceRef = useRef<HTMLDivElement>(null);
    const terminalRef = useRef<InteractiveTerminalHandle>(null);
    const executionSocketRef = useRef<WebSocket | null>(null);
    const executionRequestAbortRef = useRef<AbortController | null>(null);
    const executionPhaseRef = useRef<ExecutionPhase>("idle");
    const filesRef = useRef(files);
    const runRef = useRef<() => void>(() => undefined);
    const pingTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
    const lspConnectRetryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const lspReconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const lspReconnectCountRef = useRef(0);
    const expectedSocketCloseRef = useRef(false);
    const pendingLspRestartRef = useRef(false);

    /**
     * React stateとイベントコールバック用refを同時に更新します。
     */
    const updateExecutionPhase = useCallback((phase: ExecutionPhase) => {
        executionPhaseRef.current = phase;
        setExecutionPhase(phase);
    }, []);

    /**
     * 実行WebSocketのkeepaliveタイマーを停止します。
     */
    const clearPingTimer = useCallback(() => {
        if (pingTimerRef.current !== null) {
            clearInterval(pingTimerRef.current);
            pingTimerRef.current = null;
        }
    }, []);

    /**
     * 現在のWebSocketを閉じ、次の実行へ向けて参照を初期化します。
     */
    const closeExecutionSocket = useCallback(() => {
        clearPingTimer();
        const socket = executionSocketRef.current;
        executionSocketRef.current = null;
        if (socket !== null && socket.readyState < WebSocket.CLOSING) {
            expectedSocketCloseRef.current = true;
            socket.close(1000, "client cleanup");
        }
    }, [clearPingTimer]);

    useEffect(() => {
        const mediaQuery = window.matchMedia("(max-width: 959px)");
        const updateMobile = () => setIsMobile(mediaQuery.matches);
        const animationFrame = requestAnimationFrame(() => {
            const project = loadProject();
            filesRef.current = project.files;
            setFiles(project.files);
            setActiveFileName(project.activeFileName);
            setSettings(loadSettings());
            setHydrated(true);
            updateMobile();
        });
        mediaQuery.addEventListener("change", updateMobile);
        return () => {
            cancelAnimationFrame(animationFrame);
            mediaQuery.removeEventListener("change", updateMobile);
        };
    }, []);

    useEffect(() => {
        filesRef.current = files;
    }, [files]);

    useEffect(() => {
        if (!hydrated) {
            return;
        }

        const timer = setTimeout(() => {
            if (!saveProject({ files, activeFileName })) {
                setSystemMessage("ブラウザへコードを保存できませんでした。");
            }
        }, 350);
        return () => clearTimeout(timer);
    }, [activeFileName, files, hydrated]);

    useEffect(() => {
        if (hydrated && !saveSettings(settings)) {
            queueMicrotask(() => {
                setSystemMessage("ブラウザへ表示設定を保存できませんでした。");
            });
        }
    }, [hydrated, settings]);

    useEffect(() => {
        if (!hydrated) {
            return;
        }

        let cancelled = false;

        /**
         * LSPセッション作成を最大3回まで段階的に再試行します。
         */
        async function connectLsp(attempt: number): Promise<void> {
            setLspStatus(lspCycle === 0 && attempt === 0 ? "connecting" : "reconnecting");
            try {
                const session = await createLspSession({
                    files: filesRef.current,
                });
                if (!cancelled) {
                    setLspSession(session);
                }
            } catch (error) {
                if (cancelled) {
                    return;
                }
                if (attempt < 2) {
                    await new Promise<void>((resolve) => {
                        lspConnectRetryTimerRef.current = setTimeout(
                            () => {
                                lspConnectRetryTimerRef.current = null;
                                resolve();
                            },
                            750 * (attempt + 1),
                        );
                    });
                    if (!cancelled) {
                        await connectLsp(attempt + 1);
                    }
                    return;
                }
                setLspSession(undefined);
                setLspStatus("unavailable");
                setSystemMessage(
                    `コード補完へ接続できませんでした。編集と実行は利用できます。${formatApiError(error)}`,
                );
            }
        }

        void connectLsp(0);
        return () => {
            cancelled = true;
            if (lspConnectRetryTimerRef.current !== null) {
                clearTimeout(lspConnectRetryTimerRef.current);
                lspConnectRetryTimerRef.current = null;
            }
        };
    }, [hydrated, lspCycle]);

    /**
     * TypeFox側の接続変化を表示し、切断時は新しいticketで再接続します。
     */
    const handleLspStatusChange = useCallback((status: LspStatus) => {
        setLspStatus(status);
        if (status === "connected") {
            if (lspReconnectTimerRef.current !== null) {
                clearTimeout(lspReconnectTimerRef.current);
                lspReconnectTimerRef.current = null;
            }
            return;
        }

        if (status !== "unavailable") {
            return;
        }

        setLspSession(undefined);
        setDiagnostics({
            errors: 0,
            warnings: 0,
        });
        const reconnectDelay = getNextLspReconnectDelay(lspReconnectCountRef.current);
        if (lspReconnectTimerRef.current !== null || reconnectDelay === undefined) {
            return;
        }

        lspReconnectCountRef.current += 1;
        lspReconnectTimerRef.current = setTimeout(() => {
            lspReconnectTimerRef.current = null;
            setLspCycle((cycle) => cycle + 1);
        }, reconnectDelay);
    }, []);

    /**
     * ファイル構造を更新し、既存LSP WebSocketのclose後に新しいworkspaceを作ります。
     */
    const updateProjectStructure = useCallback(
        (nextFiles: CSourceFile[], nextActiveFileName: string) => {
            filesRef.current = nextFiles;
            setFiles(nextFiles);
            setActiveFileName(nextActiveFileName);
            setDiagnostics({ errors: 0, warnings: 0 });
            setLspStatus("reconnecting");
            if (lspReconnectTimerRef.current !== null) {
                clearTimeout(lspReconnectTimerRef.current);
                lspReconnectTimerRef.current = null;
            }
            lspReconnectCountRef.current = 0;

            if (pendingLspRestartRef.current) {
                return;
            }
            if (lspSession !== undefined) {
                pendingLspRestartRef.current = true;
                setLspSession(undefined);
                return;
            }
            setLspCycle((cycle) => cycle + 1);
        },
        [lspSession],
    );

    /**
     * 古いLSP WebSocketのclose完了後に次のセッション作成を開始します。
     */
    const handleLspDisposed = useCallback(() => {
        if (!pendingLspRestartRef.current) {
            return;
        }
        pendingLspRestartRef.current = false;
        setLspCycle((cycle) => cycle + 1);
    }, []);

    /**
     * 既存ファイルの内容だけを更新し、LSPのdidChangeへ任せます。
     */
    const handleFileChange = useCallback((name: string, content: string) => {
        setFiles((current) => {
            const next = current.map((file) => (file.name === name ? { ...file, content } : file));
            filesRef.current = next;
            return next;
        });
    }, []);

    /**
     * 同一階層へ空のCソースまたはヘッダーを追加します。
     */
    const createFile = useCallback(() => {
        if (filesRef.current.length >= SOURCE_FILE_MAX_COUNT) {
            window.alert(`ファイルは${SOURCE_FILE_MAX_COUNT}件まで作成できます。`);
            return;
        }

        const input = window.prompt("作成するファイル名（.c または .h）", "aaa.h");
        if (input === null) {
            return;
        }
        const name = input.trim();
        const error = getFileNameError(filesRef.current, name);
        if (error !== undefined) {
            window.alert(error);
            return;
        }

        updateProjectStructure([...filesRef.current, { name, content: "" }], name);
    }, [updateProjectStructure]);

    /**
     * 指定ファイルの名前を変更します。main.cはentry pointとして固定します。
     */
    const renameFile = useCallback(
        (fileName: string) => {
            if (fileName === "main.c") {
                return;
            }
            const input = window.prompt("新しいファイル名（.c または .h）", fileName);
            if (input === null) {
                return;
            }
            const name = input.trim();
            if (name === fileName) {
                return;
            }
            const error = getFileNameError(filesRef.current, name, fileName);
            if (error !== undefined) {
                window.alert(error);
                return;
            }

            const next = filesRef.current.map((file) => (file.name === fileName ? { ...file, name } : file));
            updateProjectStructure(next, name);
        },
        [updateProjectStructure],
    );

    /**
     * 指定ファイルを確認後に削除します。main.cは削除しません。
     */
    const deleteFile = useCallback(
        (fileName: string) => {
            if (fileName === "main.c" || !window.confirm(`${fileName} を削除しますか？`)) {
                return;
            }
            updateProjectStructure(
                filesRef.current.filter((file) => file.name !== fileName),
                "main.c",
            );
        },
        [updateProjectStructure],
    );

    /**
     * 実行WebSocketから届いたJSON状態メッセージを画面へ反映します。
     */
    const handleExecutionEvent = useCallback(
        (event: ExecutionServerEvent, session: ExecutionResponse, socket: WebSocket) => {
            switch (event.type) {
                case "hello": {
                    if (event.protocol !== 1 || event.sessionId !== session.id) {
                        terminalRef.current?.writeln("\r\n[実行セッションを確認できませんでした]");
                        updateExecutionPhase("disconnected");
                        socket.close(4002, "invalid hello");
                        return;
                    }
                    clearPingTimer();
                    pingTimerRef.current = setInterval(() => {
                        sendJsonMessage(socket, {
                            type: "ping",
                            nonce: crypto.randomUUID(),
                        } satisfies ExecutionClientEvent);
                    }, 20_000);
                    break;
                }
                case "phase": {
                    const previousPhase = executionPhaseRef.current;
                    updateExecutionPhase(event.phase);
                    if (event.phase === "queued" && previousPhase !== "queued") {
                        terminalRef.current?.writeln("[実行待ちです]");
                    } else if (event.phase === "compiling" && previousPhase !== "compiling") {
                        terminalRef.current?.writeln("[コンパイル中]");
                    } else if (event.phase === "running" && previousPhase !== "running") {
                        const size = terminalRef.current?.getSize() ?? {
                            cols: 100,
                            rows: 30,
                        };
                        sendJsonMessage(socket, {
                            type: "resize",
                            ...size,
                        } satisfies ExecutionClientEvent);
                        terminalRef.current?.writeln("[実行開始]\r\n");
                        terminalRef.current?.focus();
                    }
                    break;
                }
                case "compiler_output":
                    terminalRef.current?.write(event.data);
                    break;
                case "exit":
                    updateExecutionPhase(getExitPhase(event));
                    terminalRef.current?.writeln(`\r\n[${formatExitMessage(event)}]`);
                    expectedSocketCloseRef.current = true;
                    clearPingTimer();
                    break;
                case "error":
                    updateExecutionPhase("disconnected");
                    terminalRef.current?.writeln(`\r\n[実行エラー: ${event.message}]`);
                    setSystemMessage(event.message);
                    break;
                case "pong":
                    break;
            }
        },
        [clearPingTimer, updateExecutionPhase],
    );

    /**
     * WebSocketのbinary/text frameをPTY出力または制御イベントとして処理します。
     */
    const handleSocketMessage = useCallback(
        async (message: MessageEvent, session: ExecutionResponse, socket: WebSocket) => {
            if (executionSocketRef.current !== socket) {
                return;
            }

            if (typeof message.data === "string") {
                const event = parseServerEvent(message.data);
                if (event !== undefined) {
                    handleExecutionEvent(event, session, socket);
                }
                return;
            }

            if (message.data instanceof ArrayBuffer) {
                terminalRef.current?.write(new Uint8Array(message.data));
                return;
            }

            if (message.data instanceof Blob) {
                const data = new Uint8Array(await message.data.arrayBuffer());
                if (executionSocketRef.current === socket) {
                    terminalRef.current?.write(data);
                }
            }
        },
        [handleExecutionEvent],
    );

    /**
     * 現在のソースをコンパイルし、対話実行WebSocketへ接続します。
     */
    const run = useCallback(async () => {
        if (ACTIVE_EXECUTION_PHASES.has(executionPhaseRef.current)) {
            return;
        }

        closeExecutionSocket();
        expectedSocketCloseRef.current = false;
        setSystemMessage("");
        terminalRef.current?.clear();
        terminalRef.current?.writeln("[実行環境を準備しています]");
        updateExecutionPhase("creating");
        if (isMobile) {
            setSettings((current) => ({
                ...current,
                activeTab: "io",
            }));
        }

        const abortController = new AbortController();
        executionRequestAbortRef.current = abortController;

        try {
            const terminal = terminalRef.current?.getSize() ?? {
                cols: 100,
                rows: 30,
            };
            const session = await createExecution(
                {
                    files: filesRef.current,
                    terminal,
                },
                abortController.signal,
            );
            if (abortController.signal.aborted || executionRequestAbortRef.current !== abortController) {
                return;
            }

            const socket = new WebSocket(toWebSocketUrl(session.webSocketPath));
            socket.binaryType = "arraybuffer";
            executionSocketRef.current = socket;

            socket.onmessage = (message) => {
                if (executionSocketRef.current === socket) {
                    void handleSocketMessage(message, session, socket);
                }
            };
            socket.onerror = () => {
                if (executionSocketRef.current === socket) {
                    setSystemMessage("実行環境との通信でエラーが発生しました。");
                }
            };
            socket.onclose = () => {
                if (executionSocketRef.current !== socket) {
                    return;
                }

                clearPingTimer();
                executionSocketRef.current = null;
                if (!expectedSocketCloseRef.current && ACTIVE_EXECUTION_PHASES.has(executionPhaseRef.current)) {
                    updateExecutionPhase("disconnected");
                    terminalRef.current?.writeln("\r\n[実行環境との接続が切れました]");
                }
                expectedSocketCloseRef.current = false;
            };
        } catch (error) {
            // 停止後に次の実行が始まっている場合、古いHTTP要求の完了で状態を巻き戻しません。
            if (executionRequestAbortRef.current !== abortController) {
                return;
            }
            if (error instanceof DOMException && error.name === "AbortError") {
                updateExecutionPhase("cancelled");
                return;
            }
            const message = formatApiError(error);
            updateExecutionPhase("disconnected");
            setSystemMessage(message);
            terminalRef.current?.writeln(`\r\n[${message}]`);
        } finally {
            if (executionRequestAbortRef.current === abortController) {
                executionRequestAbortRef.current = null;
            }
        }
    }, [clearPingTimer, closeExecutionSocket, handleSocketMessage, isMobile, updateExecutionPhase]);

    useEffect(() => {
        runRef.current = () => {
            void run();
        };
    }, [run]);

    /**
     * 準備中のHTTP要求または進行中のExecutorジョブを停止します。
     */
    const stop = useCallback(() => {
        if (executionPhaseRef.current === "creating") {
            executionRequestAbortRef.current?.abort();
            terminalRef.current?.writeln("\r\n[実行準備を停止しました]");
            updateExecutionPhase("cancelled");
            return;
        }

        const sent = sendJsonMessage(executionSocketRef.current, {
            type: "terminate",
        } satisfies ExecutionClientEvent);
        if (!sent) {
            updateExecutionPhase("cancelled");
            terminalRef.current?.writeln("\r\n[実行を停止しました]");
        }
    }, [updateExecutionPhase]);

    useEffect(() => {
        /**
         * CodeMirror内でもCmd/Ctrl+Enterを実行ショートカットとして捕捉します。
         */
        const handleKeyboardShortcut = (event: KeyboardEvent) => {
            if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                event.preventDefault();
                runRef.current();
            }
        };
        window.addEventListener("keydown", handleKeyboardShortcut, true);
        return () => {
            window.removeEventListener("keydown", handleKeyboardShortcut, true);
        };
    }, []);

    useEffect(
        () => () => {
            executionRequestAbortRef.current?.abort();
            closeExecutionSocket();
            if (lspReconnectTimerRef.current !== null) {
                clearTimeout(lspReconnectTimerRef.current);
                lspReconnectTimerRef.current = null;
            }
        },
        [closeExecutionSocket],
    );

    /**
     * 仕切りのpointer移動量から、左ペイン比率を更新します。
     */
    const beginResize = useCallback(
        (event: ReactPointerEvent<HTMLDivElement>) => {
            const workspace = workspaceRef.current;
            if (workspace === null || isMobile) {
                return;
            }

            event.currentTarget.setPointerCapture(event.pointerId);
            const bounds = workspace.getBoundingClientRect();

            const handlePointerMove = (pointerEvent: PointerEvent) => {
                const ratio = ((pointerEvent.clientX - bounds.left) / bounds.width) * 100;
                setSettings((current) => ({
                    ...current,
                    paneRatio: Math.min(75, Math.max(35, Math.round(ratio * 10) / 10)),
                }));
            };
            const handlePointerUp = () => {
                window.removeEventListener("pointermove", handlePointerMove);
                window.removeEventListener("pointerup", handlePointerUp);
            };
            window.addEventListener("pointermove", handlePointerMove);
            window.addEventListener("pointerup", handlePointerUp);
        },
        [isMobile],
    );

    /**
     * キーボード操作で仕切り位置を変更します。
     */
    const resizeWithKeyboard = useCallback((event: ReactKeyboardEvent<HTMLDivElement>) => {
        const movement = event.key === "ArrowLeft" ? -2 : event.key === "ArrowRight" ? 2 : 0;
        if (movement === 0) {
            return;
        }
        event.preventDefault();
        setSettings((current) => ({
            ...current,
            paneRatio: Math.min(75, Math.max(35, current.paneRatio + movement)),
        }));
    }, []);

    /**
     * xtermから受け取った入力を、running中だけbinary frameで送ります。
     */
    const handleTerminalInput = useCallback((data: string) => {
        const socket = executionSocketRef.current;
        if (executionPhaseRef.current !== "running" || socket === null || socket.readyState !== WebSocket.OPEN) {
            return;
        }
        socket.send(new TextEncoder().encode(data));
    }, []);

    /**
     * 端末リサイズをExecutorのPTYへ同期します。
     */
    const handleTerminalResize = useCallback(({ cols, rows }: TerminalSize) => {
        if (executionPhaseRef.current !== "running") {
            return;
        }
        sendJsonMessage(executionSocketRef.current, {
            type: "resize",
            cols: Math.min(240, Math.max(20, cols)),
            rows: Math.min(80, Math.max(5, rows)),
        } satisfies ExecutionClientEvent);
    }, []);

    const executionActive = ACTIVE_EXECUTION_PHASES.has(executionPhase);
    const workspaceStyle = {
        "--code-pane-width": `${settings.paneRatio}%`,
    } as CSSProperties;

    return (
        <main className="grid h-dvh w-screen min-w-80 grid-rows-[3rem_2.25rem_minmax(0,1fr)] overflow-hidden bg-surface lg:grid-rows-[3rem_minmax(0,1fr)]">
            <header className="flex h-12 min-w-0 items-center justify-between border-b border-border-strong bg-surface-subtle py-0 pr-2 pl-3 lg:pl-4">
                <h1 className="max-w-[calc(100vw-7rem)] min-w-0 truncate font-semibold leading-none tracking-wide sm:max-w-none">
                    ✨かしこい✨C言語実行環境
                    <span className="ml-2 text-xs font-normal text-black/50">by <a className="underline text-sm" href="https://chimonakiko.net/">chimonakiko</a></span>
                </h1>
                <button
                    type="button"
                    className={`inline-flex h-8 min-w-20 cursor-pointer items-center justify-center gap-2.5 border px-3 font-semibold active:translate-y-px focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus forced-colors:border-[ButtonText] lg:min-w-24 ${
                        executionActive
                            ? "border-danger bg-transparent text-danger hover:border-danger hover:bg-danger/10"
                            : "border-accent bg-accent text-accent-foreground hover:border-accent-hover hover:bg-accent-hover"
                    }`}
                    onClick={executionActive ? stop : run}
                    aria-keyshortcuts="Control+Enter Meta+Enter"
                >
                    {executionActive ? "停止" : "実行"}
                    {!executionActive && (
                        <span className="hidden font-mono text-xs opacity-75 lg:inline" aria-hidden="true">
                            ⌘↵
                        </span>
                    )}
                </button>
            </header>

            <div
                className="grid grid-cols-2 border-b border-border-strong bg-surface-subtle lg:hidden"
                role="tablist"
                aria-label="表示ペイン"
            >
                <button
                    type="button"
                    className="h-9 cursor-pointer border-r border-border bg-transparent text-xs text-muted last:border-r-0 aria-selected:border-b-2 aria-selected:border-b-accent aria-selected:font-semibold aria-selected:text-foreground focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-focus"
                    role="tab"
                    aria-selected={settings.activeTab === "code"}
                    onClick={() =>
                        setSettings((current) => ({
                            ...current,
                            activeTab: "code",
                        }))
                    }
                >
                    コード
                </button>
                <button
                    type="button"
                    className="h-9 cursor-pointer border-r border-border bg-transparent text-xs text-muted last:border-r-0 aria-selected:border-b-2 aria-selected:border-b-accent aria-selected:font-semibold aria-selected:text-foreground focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-focus"
                    role="tab"
                    aria-selected={settings.activeTab === "io"}
                    onClick={() =>
                        setSettings((current) => ({
                            ...current,
                            activeTab: "io",
                        }))
                    }
                >
                    入出力
                </button>
            </div>

            <div
                ref={workspaceRef}
                className="min-h-0 min-w-0 overflow-hidden lg:grid lg:grid-cols-[minmax(0,var(--code-pane-width))_0.5rem_minmax(0,1fr)]"
                style={workspaceStyle}
            >
                <section
                    className="hidden size-full min-h-0 min-w-0 grid-rows-[2.25rem_minmax(0,1fr)] overflow-hidden bg-surface data-[mobile-active=true]:grid lg:grid"
                    data-mobile-active={settings.activeTab === "code"}
                    aria-label="コード入力"
                >
                    <div className="flex min-w-0 border-b border-border bg-surface-subtle">
                        <div
                            className="flex min-w-0 flex-1 overflow-x-auto overflow-y-hidden [scrollbar-width:thin]"
                            role="tablist"
                            aria-label="プロジェクトファイル"
                        >
                            {files.map((file) => {
                                const isActive = file.name === activeFileName;
                                return (
                                    <div
                                        key={file.name}
                                        className="flex h-9 shrink-0 border-r border-border text-muted data-[active=true]:border-b-2 data-[active=true]:border-b-accent data-[active=true]:bg-surface data-[active=true]:text-foreground"
                                        data-active={isActive}
                                    >
                                        <button
                                            type="button"
                                            className="h-9 cursor-pointer whitespace-nowrap bg-transparent px-3 font-mono text-xs hover:bg-accent/10 hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-focus"
                                            role="tab"
                                            aria-selected={isActive}
                                            onClick={() => setActiveFileName(file.name)}
                                            onDoubleClick={() => renameFile(file.name)}
                                        >
                                            {file.name}
                                        </button>
                                        {isActive && file.name !== "main.c" && (
                                            <button
                                                type="button"
                                                className="inline-flex h-9 cursor-pointer items-center justify-center bg-transparent py-0 pr-2 pl-0.5 hover:bg-accent/10 hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-focus"
                                                aria-label={`${file.name}を削除`}
                                                onClick={() => deleteFile(file.name)}
                                            >
                                                <IconX className="size-4" aria-hidden="true" focusable="false" />
                                            </button>
                                        )}
                                    </div>
                                );
                            })}
                        </div>
                        <div className="flex shrink-0 border-l border-border" aria-label="ファイル操作">
                            <button
                                type="button"
                                className="inline-flex h-9 cursor-pointer items-center justify-center bg-transparent px-2 hover:bg-accent/10 hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-focus"
                                onClick={createFile}
                                aria-label="ファイルを作成"
                            >
                                <IconPlus className="size-4" aria-hidden="true" focusable="false" />
                            </button>
                        </div>
                        <div className="flex shrink-0 items-center gap-1.5 whitespace-nowrap border-l border-border px-2.5 text-xs tracking-wide text-muted sm:gap-2">
                            <span
                                className={`inline-block size-1.5 shrink-0 border border-current forced-color-adjust-none ${STATUS_DOT_CLASS_NAMES[lspStatus]}`}
                                aria-hidden="true"
                            />
                            <span>{getLspStatusLabel(lspStatus)}</span>
                            <div className="flex gap-2">
                                <div className="flex items-center gap-1">
                                    <IconAlertTriangleFilled className="text-warning" size={16} />
                                    {diagnostics.warnings}
                                </div>
                                <div className="flex items-center gap-1">
                                    <IconAlertCircleFilled className="text-danger" size={16} />
                                    {diagnostics.errors}
                                </div>
                            </div>
                        </div>
                    </div>
                    <div className="relative min-h-0 min-w-0 overflow-hidden">
                        {hydrated ? (
                            <CodeEditor
                                key={lspSession?.id ?? `offline-${lspCycle}`}
                                files={files}
                                activeFileName={activeFileName}
                                session={lspSession}
                                onChange={handleFileChange}
                                onDiagnosticsChange={setDiagnostics}
                                onStatusChange={handleLspStatusChange}
                                onDisposed={handleLspDisposed}
                            />
                        ) : (
                            <div
                                className="grid h-full place-items-center bg-surface font-mono text-xs text-muted"
                                role="status"
                            >
                                保存したコードを読み込んでいます
                            </div>
                        )}
                    </div>
                </section>

                <div
                    className="relative z-[2] hidden w-2 min-w-2 cursor-col-resize touch-none border-x border-border-strong bg-surface-subtle hover:bg-accent/10 focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-focus after:absolute after:top-1/2 after:left-1/2 after:h-7 after:w-px after:-translate-x-1/2 after:-translate-y-1/2 after:bg-border-strong after:content-[''] lg:block"
                    role="separator"
                    aria-label="コードと入出力の幅を変更"
                    aria-orientation="vertical"
                    aria-valuemin={35}
                    aria-valuemax={75}
                    aria-valuenow={Math.round(settings.paneRatio)}
                    tabIndex={0}
                    onPointerDown={beginResize}
                    onKeyDown={resizeWithKeyboard}
                />

                <section
                    className="hidden size-full min-h-0 min-w-0 grid-rows-[2.25rem_minmax(0,1fr)] overflow-hidden bg-surface data-[mobile-active=true]:grid lg:grid"
                    data-mobile-active={settings.activeTab === "io"}
                    aria-label="対話入出力"
                >
                    <div className="flex h-9 min-w-0 items-center justify-between gap-3 border-b border-border bg-surface-subtle px-3 text-xs tracking-wide text-muted">
                        <span className="truncate font-mono font-semibold text-foreground">入出力</span>
                        <div className="flex min-w-0 items-center gap-1.5 whitespace-nowrap text-xs sm:gap-2">
                            <span
                                className={`inline-block size-1.5 shrink-0 border border-current forced-color-adjust-none ${STATUS_DOT_CLASS_NAMES[executionPhase]}`}
                                aria-hidden="true"
                            />
                            <span>{getExecutionPhaseLabel(executionPhase)}</span>
                        </div>
                    </div>
                    <div className="relative min-h-0 min-w-0 overflow-hidden bg-terminal-background px-2.5 py-2">
                        <InteractiveTerminal
                            ref={terminalRef}
                            inputEnabled={executionPhase === "running"}
                            onInput={handleTerminalInput}
                            onResize={handleTerminalResize}
                        />
                    </div>
                </section>
            </div>

            <p className="sr-only" aria-live="polite">
                {systemMessage}
            </p>
        </main>
    );
}
