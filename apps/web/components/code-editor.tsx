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

import { countDiagnostics, DeferredDisposer, getLspRootUri, WebSocketLspTransport } from "@/lib/client/lsp-transport";
import { toWebSocketUrl } from "@/lib/client/websocket";
import type { DiagnosticCounts, LspSessionResponse, LspStatus } from "@/types/wire";

interface CodeEditorProps {
    initialSource: string;
    session?: LspSessionResponse;
    onChange: (source: string) => void;
    onDiagnosticsChange: (counts: DiagnosticCounts) => void;
    onStatusChange: (status: LspStatus) => void;
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
 * clangdとの単一`main.c`接続に必要なCodeMirror LSP clientを生成します。
 */
function createLspClient(session?: LspSessionResponse): LSPClient | undefined {
    if (session === undefined) {
        return undefined;
    }

    return new LSPClient({
        rootUri: getLspRootUri(session.documentUri),
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
 * UIW React CodeMirrorを使い、単一の`main.c`とclangdを接続します。
 */
export function CodeEditor({ initialSource, session, onChange, onDiagnosticsChange, onStatusChange }: CodeEditorProps) {
    const [source, setSource] = useState(initialSource);
    const [lspClient] = useState(() => createLspClient(session));
    const connectionRef = useRef<LspConnectionResource | null>(null);
    const diagnosticsRef = useRef<DiagnosticCounts>(EMPTY_DIAGNOSTICS);
    const setupUnavailableNotifiedRef = useRef(false);
    const onChangeRef = useRef(onChange);
    const onDiagnosticsChangeRef = useRef(onDiagnosticsChange);
    const onStatusChangeRef = useRef(onStatusChange);
    const isDark = usePrefersDarkTheme();

    useEffect(() => {
        onChangeRef.current = onChange;
        onDiagnosticsChangeRef.current = onDiagnosticsChange;
        onStatusChangeRef.current = onStatusChange;
    }, [onChange, onDiagnosticsChange, onStatusChange]);

    const extensions = useMemo<Extension[]>(() => {
        if (lspClient === undefined || session === undefined) {
            return EDITOR_BASE_EXTENSIONS;
        }

        // lang-cppのlanguage名はcppなので、clangdへ送るIDはCとして明示します。
        return [...EDITOR_BASE_EXTENSIONS, lspClient.plugin(session.documentUri, "c")];
    }, [lspClient, session]);

    /**
     * 同じ接続障害を親へ一度だけ通知し、再接続要求の重複を防ぎます。
     */
    const notifyUnavailable = useCallback((resource: LspConnectionResource) => {
        if (resource.intentionalDispose || resource.unavailableNotified) {
            return;
        }

        resource.unavailableNotified = true;
        diagnosticsRef.current = EMPTY_DIAGNOSTICS;
        onDiagnosticsChangeRef.current(EMPTY_DIAGNOSTICS);
        onStatusChangeRef.current("unavailable");
    }, []);

    useEffect(() => {
        if (session === undefined || lspClient === undefined) {
            diagnosticsRef.current = EMPTY_DIAGNOSTICS;
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

                const createdResource: LspConnectionResource = {
                    sessionId: session.id,
                    client: lspClient,
                    transport,
                    disposer,
                    unavailableNotified: false,
                    intentionalDispose: false,
                };
                resource = createdResource;
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
                if (connectionRef.current === activeResource) {
                    connectionRef.current = null;
                }
                diagnosticsRef.current = EMPTY_DIAGNOSTICS;
                onDiagnosticsChangeRef.current(EMPTY_DIAGNOSTICS);
            });
        };
    }, [lspClient, notifyUnavailable, session]);

    /**
     * CodeMirrorの文書変更をローカル表示と親のsourceへ同期します。
     */
    const handleChange = useCallback((value: string) => {
        setSource(value);
        onChangeRef.current(value);
    }, []);

    /**
     * CodeMirror lint stateからerror/warning件数だけを親へ通知します。
     */
    const handleUpdate = useCallback((update: ViewUpdate) => {
        const diagnostics: Array<{ severity: string }> = [];
        forEachDiagnostic(update.state, (diagnostic) => {
            diagnostics.push(diagnostic);
        });

        const counts = countDiagnostics(diagnostics);
        if (counts.errors === diagnosticsRef.current.errors && counts.warnings === diagnosticsRef.current.warnings) {
            return;
        }

        diagnosticsRef.current = counts;
        onDiagnosticsChangeRef.current(counts);
    }, []);

    return (
        <CodeMirror
            className="codemirror-root"
            value={source}
            width="100%"
            height="100%"
            theme={isDark ? "dark" : "light"}
            basicSetup={EDITOR_BASIC_SETUP}
            indentWithTab
            extensions={extensions}
            onChange={handleChange}
            onUpdate={handleUpdate}
        />
    );
}
