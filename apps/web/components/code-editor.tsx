"use client";

import { cpp } from "@codemirror/lang-cpp";
import { indentUnit } from "@codemirror/language";
import { forEachDiagnostic } from "@codemirror/lint";
import { hoverTooltips, LSPClient, serverCompletion, serverDiagnostics } from "@codemirror/lsp-client";
import { EditorState, type Extension } from "@codemirror/state";
import { EditorView, type ViewUpdate } from "@codemirror/view";
import CodeMirror, { type BasicSetupOptions } from "@uiw/react-codemirror";
import DOMPurify from "dompurify";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { countDiagnostics, DeferredDisposer, WebSocketLspTransport } from "@/lib/client/lsp-transport";
import { toWebSocketUrl } from "@/lib/client/websocket";
import type { CSourceFile, DiagnosticCounts, LspSessionResponse, LspStatus } from "@/types/wire";

interface CodeEditorProps {
    files: CSourceFile[];
    activeFileName: string;
    session?: LspSessionResponse;
    onChange: (name: string, content: string) => void;
    onDiagnosticsChange: (counts: DiagnosticCounts) => void;
    onStatusChange: (status: LspStatus) => void;
    onDisposed: () => void;
}

interface FileEditorProps {
    file: CSourceFile;
    active: boolean;
    documentUri?: string;
    lspClient?: LSPClient;
    isDark: boolean;
    onChange: (name: string, content: string) => void;
    onDiagnosticsChange: (name: string, counts: DiagnosticCounts) => void;
}

/**
 * 単一LSPセッションに属するclient、Transport、遅延破棄状態をまとめたresourceです。
 */
interface LspConnectionResource {
    readonly sessionId: string;
    readonly client: LSPClient;
    readonly transport: WebSocketLspTransport;
    readonly disposer: DeferredDisposer;
    unavailableNotified: boolean;
    intentionalDispose: boolean;
}

const EMPTY_DIAGNOSTICS: DiagnosticCounts = {
    errors: 0,
    warnings: 0,
};

const EDITOR_BASIC_SETUP: BasicSetupOptions = {
    lineNumbers: true,
    highlightActiveLineGutter: true,
    history: true,
    syntaxHighlighting: true,
    bracketMatching: true,
    closeBrackets: true,
    autocompletion: true,
    highlightActiveLine: true,
    highlightSelectionMatches: true,
    closeBracketsKeymap: true,
    defaultKeymap: true,
    searchKeymap: true,
    historyKeymap: true,
    completionKeymap: true,
    lintKeymap: true,
};

const EDITOR_BASE_EXTENSIONS: Extension[] = [
    cpp(),
    EditorState.tabSize.of(4),
    indentUnit.of("    "),
    EditorView.theme({
        "&": {
            height: "100%",
            backgroundColor: "var(--surface)",
            color: "var(--text)",
            fontSize: "14px",
        },
        ".cm-scroller": {
            overflow: "auto",
            fontFamily: '"SFMono-Regular", Consolas, "Liberation Mono", monospace',
            lineHeight: "21px",
        },
        ".cm-content": {
            minHeight: "100%",
            padding: "12px 0",
            caretColor: "var(--text)",
        },
        ".cm-line, .cm-gutterElement": {
            lineHeight: "21px",
        },
        ".cm-gutters": {
            backgroundColor: "var(--surface-subtle)",
            color: "var(--muted)",
            borderRight: "1px solid var(--border)",
        },
        "&.cm-focused .cm-cursor": {
            borderLeftColor: "var(--text)",
        },
    }),
];

/**
 * clangdとのプロジェクト接続に必要なCodeMirror LSP clientを生成します。
 */
function createLspClient(session?: LspSessionResponse): LSPClient | undefined {
    if (session === undefined) {
        return undefined;
    }

    return new LSPClient({
        rootUri: session.workspaceUri,
        timeout: 10_000,
        extensions: [serverCompletion({ override: true }), serverDiagnostics(), hoverTooltips()],
        // clangd由来Markdownには利用者コードのコメントが含まれ得るため、必ず無害化します。
        sanitizeHTML: (html) => DOMPurify.sanitize(html, { RETURN_TRUSTED_TYPE: false }),
    });
}

/**
 * OSのlight/dark設定を監視し、現在の配色を返します。
 */
function usePrefersDarkTheme(): boolean {
    const [isDark, setIsDark] = useState(
        () => typeof window !== "undefined" && window.matchMedia("(prefers-color-scheme: dark)").matches,
    );

    useEffect(() => {
        const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
        const updateTheme = () => setIsDark(mediaQuery.matches);

        updateTheme();
        mediaQuery.addEventListener("change", updateTheme);
        return () => mediaQuery.removeEventListener("change", updateTheme);
    }, []);

    return isDark;
}

/**
 * 1ファイル分のCodeMirror文書を表示し、共有LSP clientへ接続します。
 */
function FileEditor({ file, active, documentUri, lspClient, isDark, onChange, onDiagnosticsChange }: FileEditorProps) {
    const diagnosticsRef = useRef<DiagnosticCounts>(EMPTY_DIAGNOSTICS);
    const extensions = useMemo<Extension[]>(() => {
        if (lspClient === undefined || documentUri === undefined) {
            return EDITOR_BASE_EXTENSIONS;
        }

        // lang-cppのlanguage名はcppなので、clangdへ送るIDはCとして明示します。
        return [...EDITOR_BASE_EXTENSIONS, lspClient.plugin(documentUri, "c")];
    }, [documentUri, lspClient]);

    /**
     * CodeMirrorの文書変更を対象ファイルへ同期します。
     */
    const handleChange = useCallback(
        (content: string) => {
            onChange(file.name, content);
        },
        [file.name, onChange],
    );

    /**
     * CodeMirror lint stateからerror/warning件数だけを集計します。
     */
    const handleUpdate = useCallback(
        (update: ViewUpdate) => {
            const diagnostics: Array<{ severity: string }> = [];
            forEachDiagnostic(update.state, (diagnostic) => diagnostics.push(diagnostic));

            const counts = countDiagnostics(diagnostics);
            if (
                counts.errors === diagnosticsRef.current.errors &&
                counts.warnings === diagnosticsRef.current.warnings
            ) {
                return;
            }
            diagnosticsRef.current = counts;
            onDiagnosticsChange(file.name, counts);
        },
        [file.name, onDiagnosticsChange],
    );

    return (
        <div className="hidden size-full min-h-0 data-[active=true]:block" data-active={active} aria-hidden={!active}>
            <CodeMirror
                className="codemirror-root size-full min-h-0"
                value={file.content}
                width="100%"
                height="100%"
                theme={isDark ? "dark" : "light"}
                basicSetup={EDITOR_BASIC_SETUP}
                indentWithTab
                extensions={extensions}
                onChange={handleChange}
                onUpdate={handleUpdate}
            />
        </div>
    );
}

/**
 * 全ファイルのエディターを保持し、1本のWebSocketとLSP clientを共有します。
 */
export function CodeEditor({
    files,
    activeFileName,
    session,
    onChange,
    onDiagnosticsChange,
    onStatusChange,
    onDisposed,
}: CodeEditorProps) {
    const [lspClient] = useState(() => createLspClient(session));
    const connectionRef = useRef<LspConnectionResource | null>(null);
    const diagnosticsRef = useRef(new Map<string, DiagnosticCounts>());
    const aggregateDiagnosticsRef = useRef<DiagnosticCounts>(EMPTY_DIAGNOSTICS);
    const setupUnavailableNotifiedRef = useRef(false);
    const onDiagnosticsChangeRef = useRef(onDiagnosticsChange);
    const onStatusChangeRef = useRef(onStatusChange);
    const onDisposedRef = useRef(onDisposed);
    const isDark = usePrefersDarkTheme();

    useEffect(() => {
        onDiagnosticsChangeRef.current = onDiagnosticsChange;
        onStatusChangeRef.current = onStatusChange;
        onDisposedRef.current = onDisposed;
    }, [onDiagnosticsChange, onDisposed, onStatusChange]);

    /**
     * 同じ接続障害を親へ一度だけ通知し、再接続要求の重複を防ぎます。
     */
    const notifyUnavailable = useCallback((resource: LspConnectionResource) => {
        if (resource.intentionalDispose || resource.unavailableNotified) {
            return;
        }

        resource.unavailableNotified = true;
        diagnosticsRef.current.clear();
        aggregateDiagnosticsRef.current = EMPTY_DIAGNOSTICS;
        onDiagnosticsChangeRef.current(EMPTY_DIAGNOSTICS);
        onStatusChangeRef.current("unavailable");
    }, []);

    useEffect(() => {
        const diagnostics = diagnosticsRef.current;
        if (session === undefined || lspClient === undefined) {
            diagnostics.clear();
            aggregateDiagnosticsRef.current = EMPTY_DIAGNOSTICS;
            onDiagnosticsChangeRef.current(EMPTY_DIAGNOSTICS);
            return;
        }

        let resource = connectionRef.current;
        if (resource === null) {
            onStatusChangeRef.current("connecting");
            try {
                const socket = new WebSocket(toWebSocketUrl(session.webSocketPath));
                const disposer = new DeferredDisposer();
                const transport = new WebSocketLspTransport(socket, () => {
                    const currentResource = connectionRef.current;
                    if (currentResource?.sessionId === session.id) {
                        notifyUnavailable(currentResource);
                    }
                });
                resource = {
                    sessionId: session.id,
                    client: lspClient,
                    transport,
                    disposer,
                    unavailableNotified: false,
                    intentionalDispose: false,
                };
                connectionRef.current = resource;
                const activeResource = resource;

                void (async () => {
                    try {
                        await activeResource.transport.waitUntilOpen();
                        activeResource.client.connect(activeResource.transport);
                        await activeResource.client.initializing;
                        if (!activeResource.intentionalDispose && !activeResource.unavailableNotified) {
                            onStatusChangeRef.current("connected");
                        }
                    } catch (error) {
                        console.error("clangd connection failed", error);
                        notifyUnavailable(activeResource);
                    }
                })();
            } catch (error) {
                console.error("clangd WebSocket initialization failed", error);
                if (!setupUnavailableNotifiedRef.current) {
                    setupUnavailableNotifiedRef.current = true;
                    onDiagnosticsChangeRef.current(EMPTY_DIAGNOSTICS);
                    onStatusChangeRef.current("unavailable");
                }
                return;
            }
        }

        const activeResource = resource;
        if (activeResource.sessionId !== session.id) {
            throw new Error("LSP接続resourceとsessionが一致しません。");
        }
        activeResource.disposer.acquire();

        return () => {
            activeResource.disposer.release(() => {
                activeResource.intentionalDispose = true;
                activeResource.client.disconnect();
                activeResource.transport.dispose();
                void activeResource.transport.waitUntilClosed().then(() => onDisposedRef.current());
                if (connectionRef.current === activeResource) {
                    connectionRef.current = null;
                }
                diagnostics.clear();
                aggregateDiagnosticsRef.current = EMPTY_DIAGNOSTICS;
                onDiagnosticsChangeRef.current(EMPTY_DIAGNOSTICS);
            });
        };
    }, [lspClient, notifyUnavailable, session]);

    /**
     * ファイル別診断をプロジェクト全体の件数へ集約します。
     */
    const handleDiagnosticsChange = useCallback((name: string, counts: DiagnosticCounts) => {
        diagnosticsRef.current.set(name, counts);
        const aggregate = [...diagnosticsRef.current.values()].reduce<DiagnosticCounts>(
            (total, current) => ({
                errors: total.errors + current.errors,
                warnings: total.warnings + current.warnings,
            }),
            { errors: 0, warnings: 0 },
        );
        if (
            aggregate.errors === aggregateDiagnosticsRef.current.errors &&
            aggregate.warnings === aggregateDiagnosticsRef.current.warnings
        ) {
            return;
        }
        aggregateDiagnosticsRef.current = aggregate;
        onDiagnosticsChangeRef.current(aggregate);
    }, []);

    return (
        <div className="size-full min-h-0">
            {files.map((file) => (
                <FileEditor
                    key={file.name}
                    file={file}
                    active={file.name === activeFileName}
                    documentUri={session?.documentUris[file.name]}
                    lspClient={lspClient}
                    isDark={isDark}
                    onChange={onChange}
                    onDiagnosticsChange={handleDiagnosticsChange}
                />
            ))}
        </div>
    );
}
