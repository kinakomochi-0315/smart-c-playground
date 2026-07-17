"use client";

import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import type { Terminal } from "@xterm/xterm";
import type { FitAddon } from "@xterm/addon-fit";

import type { TerminalSize } from "@/types/wire";

export interface InteractiveTerminalHandle {
    clear: () => void;
    focus: () => void;
    getSize: () => TerminalSize;
    write: (data: string | Uint8Array) => void;
    writeln: (text: string) => void;
}

interface InteractiveTerminalProps {
    inputEnabled: boolean;
    onInput: (data: string) => void;
    onResize: (size: TerminalSize) => void;
}

/**
 * xterm.jsをPTY WebSocket向けの入出力ビューとして初期化します。
 */
export const InteractiveTerminal = forwardRef<InteractiveTerminalHandle, InteractiveTerminalProps>(
    function InteractiveTerminal({ inputEnabled, onInput, onResize }, forwardedRef) {
        const containerRef = useRef<HTMLDivElement>(null);
        const terminalRef = useRef<Terminal | null>(null);
        const fitAddonRef = useRef<FitAddon | null>(null);
        const inputEnabledRef = useRef(inputEnabled);
        const onInputRef = useRef(onInput);
        const onResizeRef = useRef(onResize);

        inputEnabledRef.current = inputEnabled;
        onInputRef.current = onInput;
        onResizeRef.current = onResize;

        useImperativeHandle(
            forwardedRef,
            () => ({
                clear() {
                    terminalRef.current?.clear();
                },
                focus() {
                    terminalRef.current?.focus();
                },
                getSize() {
                    return {
                        cols: Math.min(240, Math.max(20, terminalRef.current?.cols ?? 100)),
                        rows: Math.min(80, Math.max(5, terminalRef.current?.rows ?? 30)),
                    };
                },
                write(data) {
                    terminalRef.current?.write(data);
                },
                writeln(text) {
                    terminalRef.current?.writeln(text);
                },
            }),
            [],
        );

        useEffect(() => {
            const container = containerRef.current;
            if (container === null) {
                return;
            }
            const containerElement = container;

            let disposed = false;
            let resizeObserver: ResizeObserver | undefined;
            let animationFrame = 0;
            let terminal: Terminal | undefined;
            let fitAddon: FitAddon | undefined;

            /**
             * xterm本体をブラウザ上でのみ遅延ロードします。
             */
            async function initializeTerminal(): Promise<void> {
                const [{ Terminal: TerminalConstructor }, { FitAddon: FitAddonConstructor }] = await Promise.all([
                    import("@xterm/xterm"),
                    import("@xterm/addon-fit"),
                ]);

                if (disposed) {
                    return;
                }

                const styles = getComputedStyle(containerElement);
                terminal = new TerminalConstructor({
                    allowTransparency: false,
                    convertEol: true,
                    cursorBlink: true,
                    cursorStyle: "bar",
                    fontFamily: '"SFMono-Regular", Consolas, "Liberation Mono", monospace',
                    fontSize: 13,
                    lineHeight: 1.28,
                    screenReaderMode: true,
                    scrollback: 2_000,
                    theme: {
                        background: styles.getPropertyValue("--terminal-background").trim(),
                        foreground: styles.getPropertyValue("--terminal-foreground").trim(),
                        cursor: styles.getPropertyValue("--terminal-cursor").trim(),
                        selectionBackground: styles.getPropertyValue("--terminal-selection").trim(),
                    },
                });
                fitAddon = new FitAddonConstructor();
                terminal.loadAddon(fitAddon);
                terminal.open(containerElement);
                terminalRef.current = terminal;
                fitAddonRef.current = fitAddon;

                terminal.onData((data) => {
                    if (inputEnabledRef.current) {
                        onInputRef.current(data);
                    }
                });
                terminal.onResize(({ cols, rows }) => {
                    onResizeRef.current({
                        cols,
                        rows,
                    });
                });
                terminal.writeln("C17 対話実行ターミナル");
                terminal.writeln("「実行」を押すとここに結果が表示されます。\r\n");

                resizeObserver = new ResizeObserver(() => {
                    cancelAnimationFrame(animationFrame);
                    animationFrame = requestAnimationFrame(() => {
                        try {
                            fitAddon?.fit();
                        } catch {
                            // 非表示タブでは寸法を計算できないため、次の通知を待ちます。
                        }
                    });
                });
                resizeObserver.observe(containerElement);
                fitAddon.fit();
            }

            void initializeTerminal();

            return () => {
                disposed = true;
                cancelAnimationFrame(animationFrame);
                resizeObserver?.disconnect();
                terminal?.dispose();
                terminalRef.current = null;
                fitAddonRef.current = null;
            };
        }, []);

        useEffect(() => {
            const fitAddon = fitAddonRef.current;
            if (fitAddon === null) {
                return;
            }

            const animationFrame = requestAnimationFrame(() => {
                try {
                    fitAddon.fit();
                } catch {
                    // 表示状態が安定した次のResizeObserver通知で再試行します。
                }
            });
            return () => cancelAnimationFrame(animationFrame);
        }, [inputEnabled]);

        return (
            <div
                ref={containerRef}
                className="terminal-root size-full overflow-hidden bg-terminal-background"
                aria-label="C言語プログラムの対話入出力"
                data-input-enabled={inputEnabled}
            />
        );
    },
);

InteractiveTerminal.displayName = "InteractiveTerminal";
