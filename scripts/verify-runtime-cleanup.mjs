import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, isAbsolute, join, resolve } from "node:path";

import WebSocket from "ws";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const projectDirectory = resolve(scriptDirectory, "..");
const projectName =
    process.env.RUNTIME_SMOKE_PROJECT ?? `smart-c-runtime-smoke-${process.pid}-${randomUUID().slice(0, 8)}`;
const runtimeSmokePort = Number(process.env.RUNTIME_SMOKE_PORT ?? "18081");
if (!Number.isInteger(runtimeSmokePort) || runtimeSmokePort < 1 || runtimeSmokePort > 65_535) {
    throw new Error("RUNTIME_SMOKE_PORTは1から65535までの整数にしてください。");
}
const httpOrigin = `http://localhost:${runtimeSmokePort}`;
const wsOrigin = httpOrigin.replace(/^http/u, "ws");
const keepStack = process.env.KEEP_RUNTIME_SMOKE_STACK === "true";
const lspCleanupIterations = 8;
const rawEnvFile = process.env.ENV_FILE ?? ".env.production";
const envFile = isAbsolute(rawEnvFile) ? rawEnvFile : join(projectDirectory, rawEnvFile);
const composeFiles = [
    join(projectDirectory, "compose.yaml"),
    join(projectDirectory, "compose.prod.yaml"),
    join(projectDirectory, "compose.runtime-smoke.yaml"),
];

if (shouldUseAppArmorOverlay()) {
    composeFiles.push(join(projectDirectory, "compose.apparmor.yaml"));
}

const lspProcessSnapshotScript = String.raw`
const { existsSync, readdirSync, readFileSync } = require("node:fs");

let bwrapProcesses = 0;
let bwrapZombies = 0;
for (const entry of readdirSync("/proc", { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^\d+$/u.test(entry.name)) {
        continue;
    }

    try {
        const stat = readFileSync("/proc/" + entry.name + "/stat", "utf8");
        const openParen = stat.indexOf("(");
        const closeParen = stat.lastIndexOf(")");
        if (openParen < 0 || closeParen <= openParen) {
            continue;
        }
        const command = stat.slice(openParen + 1, closeParen);
        const state = stat.slice(closeParen + 2, closeParen + 3);
        if (command === "bwrap") {
            bwrapProcesses += 1;
            if (state === "Z") {
                bwrapZombies += 1;
            }
        }
    } catch (error) {
        if (error?.code !== "ENOENT") {
            throw error;
        }
    }
}

const pidsCurrentPath = ["/sys/fs/cgroup/pids.current", "/sys/fs/cgroup/pids/pids.current"].find(existsSync);
if (pidsCurrentPath === undefined) {
    throw new Error("pids.currentが見つかりません");
}
const pidsCurrent = Number(readFileSync(pidsCurrentPath, "utf8").trim());
process.stdout.write(JSON.stringify({ bwrapProcesses, bwrapZombies, pidsCurrent }));
`;

/**
 * Docker Composeへ渡す共通引数を返します。
 */
function composeArguments() {
    return [
        "compose",
        "--project-name",
        projectName,
        "--project-directory",
        projectDirectory,
        "--env-file",
        envFile,
        ...composeFiles.flatMap((file) => ["-f", file]),
    ];
}

/**
 * Dockerコマンドをshellなしで実行し、標準出力を返します。
 */
function docker(args, options = {}) {
    const result = spawnSync("docker", args, {
        cwd: projectDirectory,
        encoding: "utf8",
        env: {
            ...process.env,
            RUNTIME_SMOKE_PORT: String(runtimeSmokePort),
        },
        stdio: options.capture ? "pipe" : "inherit",
    });
    if (result.status !== 0) {
        throw new Error(`docker ${args.join(" ")} failed (${result.status ?? "signal"}): ${result.stderr ?? ""}`);
    }
    return result.stdout?.trim() ?? "";
}

/**
 * AppArmor overlayを明示設定またはUbuntuの制限状態から選びます。
 */
function shouldUseAppArmorOverlay() {
    const mode = process.env.APPARMOR_OVERLAY ?? "auto";
    if (mode === "true") {
        return true;
    }
    if (mode === "false") {
        return false;
    }
    if (mode !== "auto") {
        throw new Error("APPARMOR_OVERLAYはauto、true、falseのいずれかにしてください。");
    }

    const probe = spawnSync("sh", [
        "-c",
        'test -r /proc/sys/kernel/apparmor_restrict_unprivileged_userns && test "$(cat /proc/sys/kernel/apparmor_restrict_unprivileged_userns)" = 1',
    ]);
    return probe.status === 0;
}

/**
 * 条件が成立するまでポーリングします。
 */
async function waitFor(description, predicate, timeoutMs = 30_000) {
    const startedAt = Date.now();
    let lastError;
    while (Date.now() - startedAt < timeoutMs) {
        try {
            if (await predicate()) {
                return;
            }
        } catch (error) {
            lastError = error;
        }
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
    }
    throw new Error(`${description}を確認できませんでした${lastError ? `: ${lastError}` : ""}`);
}

/**
 * Set-Cookie列を次のHTTP/WS要求用Cookieへ統合します。
 */
function mergeCookies(current, setCookies) {
    const values = new Map(
        current
            .split(";")
            .map((part) => part.trim())
            .filter(Boolean)
            .map((part) => part.split("=", 2)),
    );
    for (const setCookie of setCookies) {
        const [pair] = setCookie.split(";", 1);
        const separator = pair.indexOf("=");
        values.set(pair.slice(0, separator), pair.slice(separator + 1));
    }
    return [...values].map(([name, value]) => `${name}=${value}`).join("; ");
}

/**
 * 診断を1件以上返すC17ソースでLSPセッションを公開APIから作成します。
 */
async function createLspSession(cookie) {
    const files = [
        { name: "main.c", content: '#include "aaa.h"\nint main(void) { return missing; }\n' },
        { name: "aaa.h", content: "int answer(void);\n" },
    ];
    const response = await fetch(`${httpOrigin}/api/lsp/sessions`, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            Origin: httpOrigin,
            ...(cookie === "" ? {} : { Cookie: cookie }),
        },
        body: JSON.stringify({ files }),
    });
    const text = await response.text();
    if (!response.ok) {
        throw new Error(`LSP session create failed: ${response.status} ${text}`);
    }

    return {
        files,
        session: JSON.parse(text),
        cookie: mergeCookies(cookie, response.headers.getSetCookie()),
    };
}

/**
 * LSP WebSocketを初期化し、header編集でmain.cのdiagnosticsが解消するまで待機します。
 */
async function connectLspSession(cookie) {
    const created = await createLspSession(cookie);
    const documentUri = created.session.documentUris["main.c"];
    const headerUri = created.session.documentUris["aaa.h"];
    const workspaceUri = created.session.workspaceUri;
    const socket = new WebSocket(`${wsOrigin}${created.session.webSocketPath}`, {
        headers: {
            Origin: httpOrigin,
            Cookie: created.cookie,
        },
    });

    try {
        await new Promise((resolvePromise, reject) => {
            let initialized = false;
            let initialDiagnosticsSeen = false;
            const diagnosticEvents = [];
            const finish = (error) => {
                clearTimeout(timeout);
                socket.off("open", handleOpen);
                socket.off("message", handleMessage);
                socket.off("close", handleClose);
                socket.off("error", handleError);
                if (error === undefined) {
                    resolvePromise();
                } else {
                    reject(error);
                }
            };
            const handleError = (error) => finish(error);
            const handleClose = (code, reason) => {
                finish(new Error(`LSP socket closed before diagnostics: ${code} ${reason.toString()}`));
            };
            const handleOpen = () => {
                socket.send(
                    JSON.stringify({
                        jsonrpc: "2.0",
                        id: 1,
                        method: "initialize",
                        params: {
                            processId: null,
                            rootPath: fileURLToPath(workspaceUri),
                            rootUri: workspaceUri,
                            workspaceFolders: [{ name: "workspace", uri: workspaceUri }],
                            capabilities: {},
                        },
                    }),
                );
            };
            const handleMessage = (raw, isBinary) => {
                if (isBinary) {
                    finish(new Error("LSP serverがbinary frameを返しました"));
                    return;
                }

                try {
                    const message = JSON.parse(raw.toString());
                    if (
                        message.method === "textDocument/publishDiagnostics" &&
                        Array.isArray(message.params?.diagnostics)
                    ) {
                        const document = message.params.uri === documentUri ? "main" : "other";
                        const codes = message.params.diagnostics
                            .map((diagnostic) => diagnostic.code ?? "unknown")
                            .join("+");
                        diagnosticEvents.push(`${document}:${message.params.diagnostics.length}:${codes}`);
                    }
                    if (message.id === 1) {
                        if (message.error !== undefined || message.result === undefined) {
                            finish(new Error(`LSP initialize failed: ${raw}`));
                            return;
                        }
                        if (!initialized) {
                            initialized = true;
                            socket.send(JSON.stringify({ jsonrpc: "2.0", method: "initialized", params: {} }));
                            for (const file of created.files) {
                                socket.send(
                                    JSON.stringify({
                                        jsonrpc: "2.0",
                                        method: "textDocument/didOpen",
                                        params: {
                                            textDocument: {
                                                uri: created.session.documentUris[file.name],
                                                languageId: "c",
                                                version: 1,
                                                text: file.content,
                                            },
                                        },
                                    }),
                                );
                            }
                        }
                        return;
                    }
                    if (
                        message.method === "textDocument/publishDiagnostics" &&
                        message.params?.uri === documentUri &&
                        Array.isArray(message.params.diagnostics)
                    ) {
                        const hasUndeclaredIdentifier = message.params.diagnostics.some(
                            (diagnostic) => diagnostic.code === "undeclared_var_use",
                        );
                        if (!initialDiagnosticsSeen && hasUndeclaredIdentifier) {
                            initialDiagnosticsSeen = true;
                            socket.send(
                                JSON.stringify({
                                    jsonrpc: "2.0",
                                    method: "textDocument/didChange",
                                    params: {
                                        textDocument: { uri: headerUri, version: 2 },
                                        contentChanges: [{ text: "#define missing 0\n" }],
                                    },
                                }),
                            );
                        } else if (initialDiagnosticsSeen && !hasUndeclaredIdentifier) {
                            finish();
                        }
                        return;
                    }
                    if (message.id !== undefined && typeof message.method === "string") {
                        socket.send(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: null }));
                    }
                } catch (error) {
                    finish(error);
                }
            };
            const timeout = setTimeout(
                () =>
                    finish(
                        new Error(
                            `LSP header synchronization timed out (diagnostics: ${diagnosticEvents.slice(-20).join(", ") || "none"})`,
                        ),
                    ),
                15_000,
            );
            socket.on("open", handleOpen);
            socket.on("message", handleMessage);
            socket.on("close", handleClose);
            socket.on("error", handleError);
        });
    } catch (error) {
        socket.terminate();
        throw error;
    }

    return {
        cookie: created.cookie,
        socket,
    };
}

/**
 * LSP WebSocketをTCP切断し、closeイベントまで待機します。
 */
async function disconnectLspSession(socket) {
    await new Promise((resolvePromise, reject) => {
        const finish = (error) => {
            clearTimeout(timeout);
            socket.off("close", handleClose);
            socket.off("error", handleError);
            if (error === undefined) {
                resolvePromise();
            } else {
                reject(error);
            }
        };
        const handleClose = () => finish();
        const handleError = (error) => finish(error);
        const timeout = setTimeout(() => finish(new Error("LSP socket disconnect timed out")), 5_000);
        socket.on("close", handleClose);
        socket.on("error", handleError);
        socket.terminate();
    });
}

/**
 * 改行なしのpromptを出力し、標準入力を待つC17実行セッションを公開APIから作成します。
 */
async function createLongExecution(cookie) {
    const response = await fetch(`${httpOrigin}/api/executions`, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            Origin: httpOrigin,
            ...(cookie === "" ? {} : { Cookie: cookie }),
        },
        body: JSON.stringify({
            files: [
                {
                    name: "main.c",
                    content: '#include "prompt.h"\nint main(void) { return wait_for_input(); }\n',
                },
                { name: "prompt.h", content: "int wait_for_input(void);\n" },
                {
                    name: "prompt.c",
                    content:
                        '#include <stdio.h>\n#include "prompt.h"\nint wait_for_input(void) { printf("RUNTIME_SMOKE_READY"); return getchar() == EOF; }\n',
                },
            ],
            terminal: { cols: 100, rows: 30 },
        }),
    });
    const text = await response.text();
    if (!response.ok) {
        throw new Error(`execution create failed: ${response.status} ${text}`);
    }

    return {
        session: JSON.parse(text),
        cookie: mergeCookies(cookie, response.headers.getSetCookie()),
    };
}

/**
 * 実行WebSocketへ接続し、入力や切断の前に改行なしpromptを受信できることを確認します。
 */
async function connectRunningExecution(cookie) {
    const created = await createLongExecution(cookie);
    const socket = new WebSocket(`${wsOrigin}${created.session.webSocketPath}`, {
        headers: {
            Origin: httpOrigin,
            Cookie: created.cookie,
        },
    });

    await new Promise((resolvePromise, reject) => {
        let isRunning = false;
        let output = "";
        const finish = (error) => {
            clearTimeout(timeout);
            socket.off("message", handleMessage);
            socket.off("error", handleError);
            if (error === undefined) {
                resolvePromise();
            } else {
                reject(error);
            }
        };
        const handleError = (error) => finish(error);
        const handleMessage = (raw, isBinary) => {
            if (isBinary) {
                output = `${output}${raw.toString()}`.slice(-4_096);
                if (isRunning && output.includes("RUNTIME_SMOKE_READY")) {
                    finish();
                }
                return;
            }
            const message = JSON.parse(raw.toString());
            if (message.type === "hello" && (message.protocol !== 1 || message.sessionId !== created.session.id)) {
                finish(new Error(`invalid hello: ${raw}`));
                return;
            }
            if (message.type === "phase" && message.phase === "running") {
                isRunning = true;
                if (output.includes("RUNTIME_SMOKE_READY")) {
                    finish();
                }
            }
        };
        const timeout = setTimeout(() => finish(new Error("running phase timed out")), 10_000);
        socket.on("message", handleMessage);
        socket.on("error", handleError);
    });
    return {
        cookie: created.cookie,
        socket,
    };
}

/**
 * 実行中のworkspace、NsJail、Cプロセスが存在することを確認します。
 */
async function waitForWorkerActivity() {
    await waitFor(
        "Worker activity",
        async () => {
            const workspaces = docker(
                [
                    ...composeArguments(),
                    "exec",
                    "-T",
                    "executor-worker",
                    "find",
                    "/work",
                    "-mindepth",
                    "1",
                    "-maxdepth",
                    "1",
                    "-print",
                ],
                { capture: true },
            );
            const containerId = docker([...composeArguments(), "ps", "-q", "executor-worker"], {
                capture: true,
            });
            if (containerId === "") {
                return false;
            }
            const processes = docker(["top", containerId, "-eo", "pid,comm,args"], {
                capture: true,
            });
            return workspaces !== "" && /nsjail/u.test(processes) && /\/workspace\/main/u.test(processes);
        },
        10_000,
    );
}

/**
 * runtime smokeで使用するWorkerコンテナIDを返します。
 */
function getWorkerContainerId() {
    const containerId = docker([...composeArguments(), "ps", "-q", "executor-worker"], {
        capture: true,
    });
    if (containerId === "") {
        throw new Error("Workerコンテナが見つかりません。");
    }
    return containerId;
}

/**
 * runtime smokeで使用するLSPコンテナIDを返します。
 */
function getLspContainerId() {
    const containerId = docker([...composeArguments(), "ps", "-q", "lsp"], {
        capture: true,
    });
    if (containerId === "") {
        throw new Error("LSPコンテナが見つかりません。");
    }
    return containerId;
}

/**
 * LSPコンテナでDocker initが有効になっていることを確認します。
 */
function assertLspInitEnabled(containerId) {
    const initEnabled = docker(["inspect", "--format", "{{.HostConfig.Init}}", containerId], {
        capture: true,
    });
    if (initEnabled !== "true") {
        throw new Error(`LSPコンテナのHostConfig.Initがtrueではありません: ${initEnabled}`);
    }
}

/**
 * LSPコンテナの/procとcgroupからbwrap・PID利用量を取得します。
 */
function readLspProcessSnapshot(containerId) {
    const output = docker(["exec", containerId, "node", "--input-type=commonjs", "-e", lspProcessSnapshotScript], {
        capture: true,
    });
    let snapshot;
    try {
        snapshot = JSON.parse(output);
    } catch (error) {
        throw new Error(`LSP process snapshotを解析できません: ${output}`, { cause: error });
    }
    if (
        !Number.isSafeInteger(snapshot.bwrapProcesses) ||
        snapshot.bwrapProcesses < 0 ||
        !Number.isSafeInteger(snapshot.bwrapZombies) ||
        snapshot.bwrapZombies < 0 ||
        !Number.isSafeInteger(snapshot.pidsCurrent) ||
        snapshot.pidsCurrent < 1
    ) {
        throw new Error(`LSP process snapshotが不正です: ${output}`);
    }
    return snapshot;
}

/**
 * bwrapが残らず、pids.currentが連続2回安定するまで待機します。
 */
async function waitForLspQuiescence(containerId, description, maximumPids) {
    let previousPids;
    let stableSamples = 0;
    let settledSnapshot;
    await waitFor(
        description,
        () => {
            const snapshot = readLspProcessSnapshot(containerId);
            const withinPidsBudget = maximumPids === undefined || snapshot.pidsCurrent <= maximumPids;
            if (snapshot.bwrapProcesses !== 0 || snapshot.bwrapZombies !== 0 || !withinPidsBudget) {
                previousPids = undefined;
                stableSamples = 0;
                return false;
            }

            stableSamples = previousPids === snapshot.pidsCurrent ? stableSamples + 1 : 1;
            previousPids = snapshot.pidsCurrent;
            if (stableSamples >= 2) {
                settledSnapshot = snapshot;
                return true;
            }
            return false;
        },
        20_000,
    );
    if (settledSnapshot === undefined) {
        throw new Error(`${description}の安定値を取得できませんでした`);
    }
    return settledSnapshot;
}

/**
 * SIGKILLしたWorkerコンテナが停止状態になったことを確認します。
 */
async function waitForWorkerContainerStopped(containerId) {
    await waitFor(
        "stopped Worker container",
        async () => {
            const state = docker(["inspect", "--format", "{{.State.Running}} {{.State.Pid}}", containerId], {
                capture: true,
            });
            return state === "false 0";
        },
        10_000,
    );
}

/**
 * WebSocketの終了イベントまたは切断を待機します。
 */
async function waitForSocketEnd(socket, expectedReason) {
    await new Promise((resolvePromise, reject) => {
        const finish = (error) => {
            clearTimeout(timeout);
            socket.off("message", handleMessage);
            socket.off("close", handleClose);
            socket.off("error", handleError);
            if (error === undefined) {
                resolvePromise();
            } else {
                reject(error);
            }
        };
        const handleError = (error) => finish(error);
        const handleClose = () => {
            if (expectedReason === undefined) {
                finish();
            }
        };
        const handleMessage = (raw, isBinary) => {
            if (isBinary) {
                return;
            }
            const message = JSON.parse(raw.toString());
            if (message.type !== "exit") {
                return;
            }
            if (expectedReason !== undefined && message.reason !== expectedReason) {
                finish(new Error(`unexpected exit: ${raw}`));
                return;
            }
            finish();
        };
        const timeout = setTimeout(() => finish(new Error("execution socket did not finish")), 15_000);
        socket.on("message", handleMessage);
        socket.on("close", handleClose);
        socket.on("error", handleError);

        if (expectedReason === undefined && socket.readyState === WebSocket.CLOSED) {
            finish();
        }
    });
}

/**
 * WorkerのworkspaceとNsJail子プロセスが残っていないことを確認します。
 */
async function waitForWorkerCleanup() {
    await waitFor(
        "Worker cleanup",
        async () => {
            const workspaces = docker(
                [
                    ...composeArguments(),
                    "exec",
                    "-T",
                    "executor-worker",
                    "find",
                    "/work",
                    "-mindepth",
                    "1",
                    "-maxdepth",
                    "1",
                    "-print",
                ],
                { capture: true },
            );
            const containerId = getWorkerContainerId();
            const processes = docker(["top", containerId, "-eo", "pid,comm,args"], {
                capture: true,
            });
            return workspaces === "" && !/(?:nsjail|\/workspace\/main|clang(?:\s|$))/u.test(processes);
        },
        20_000,
    );
}

/**
 * 公開healthがreadyへ戻るまで待機します。
 */
async function waitForReady() {
    await waitFor(
        "runtime smoke stack readiness",
        async () => {
            const response = await fetch(`${httpOrigin}/api/health`);
            return response.ok;
        },
        120_000,
    );
}

/**
 * 公開healthが現在もreadyであることを即時確認します。
 */
async function assertPublicReadiness(description) {
    const response = await fetch(`${httpOrigin}/api/health`);
    if (!response.ok) {
        throw new Error(`${description}: public health returned ${response.status} ${await response.text()}`);
    }
}

/**
 * LSPの接続・強制切断を反復し、init・zombie・PID・readinessを検証します。
 */
async function verifyRepeatedLspCleanup(cookie) {
    const containerId = getLspContainerId();
    assertLspInitEnabled(containerId);
    await assertPublicReadiness("LSP cleanup開始前にreadinessが失われました");

    const initialSnapshot = await waitForLspQuiescence(containerId, "LSP initial process quiescence");
    let stabilizedPids;
    const settledPids = [initialSnapshot.pidsCurrent];

    for (let iteration = 1; iteration <= lspCleanupIterations; iteration += 1) {
        const connected = await connectLspSession(cookie);
        cookie = connected.cookie;

        const activeSnapshot = readLspProcessSnapshot(containerId);
        if (activeSnapshot.bwrapProcesses < 1 || activeSnapshot.bwrapZombies !== 0) {
            connected.socket.terminate();
            throw new Error(`LSP反復${iteration}回目のbwrap状態が不正です: ${JSON.stringify(activeSnapshot)}`);
        }

        await disconnectLspSession(connected.socket);
        const settledSnapshot = await waitForLspQuiescence(
            containerId,
            `LSP cleanup iteration ${iteration}`,
            stabilizedPids,
        );
        settledPids.push(settledSnapshot.pidsCurrent);
        if (stabilizedPids === undefined) {
            // 初回だけはNodeが遅延生成するthreadを許容し、以後の累積増加をこの値で検出します。
            stabilizedPids = Math.max(initialSnapshot.pidsCurrent, settledSnapshot.pidsCurrent);
        }

        if (getLspContainerId() !== containerId) {
            throw new Error(`LSP反復${iteration}回目の途中でコンテナが再作成されました`);
        }
        await assertPublicReadiness(`LSP反復${iteration}回目の後にreadinessが失われました`);
    }

    if (settledPids.slice(2).some((count) => count > stabilizedPids)) {
        throw new Error(`LSP pids.currentが反復ごとに増加しました: ${settledPids.join(", ")}`);
    }
    console.log(`LSP cleanup pids.current: ${settledPids.join(" -> ")}`);
    return cookie;
}

/**
 * Worker停止後に公開healthがunreadyへ遷移するまで待機します。
 */
async function waitForUnready() {
    await waitFor(
        "runtime smoke stack unready state",
        async () => {
            const response = await fetch(`${httpOrigin}/api/health`);
            return response.status === 503;
        },
        30_000,
    );
}

if (!existsSync(envFile)) {
    throw new Error(`Production環境変数ファイルがありません: ${envFile}`);
}

try {
    docker([...composeArguments(), "up", "--detach", "--build", "--wait"]);
    await waitForReady();

    let cookie = "";
    cookie = await verifyRepeatedLspCleanup(cookie);

    const disconnected = await connectRunningExecution(cookie);
    cookie = disconnected.cookie;
    await waitForWorkerActivity();
    const disconnectedEnd = waitForSocketEnd(disconnected.socket);
    disconnected.socket.terminate();
    await disconnectedEnd;
    await waitForWorkerCleanup();

    const terminated = await connectRunningExecution(cookie);
    cookie = terminated.cookie;
    await waitForWorkerActivity();
    const terminatedEnd = waitForSocketEnd(terminated.socket, "cancelled");
    terminated.socket.send(JSON.stringify({ type: "terminate" }));
    await terminatedEnd;
    terminated.socket.close(1000);
    await waitForWorkerCleanup();

    const crashed = await connectRunningExecution(cookie);
    cookie = crashed.cookie;
    await waitForWorkerActivity();
    const workerContainerId = getWorkerContainerId();
    const crashedEnd = waitForSocketEnd(crashed.socket, "internal_error");
    docker([...composeArguments(), "kill", "--signal", "SIGKILL", "executor-worker"]);
    await crashedEnd;
    await waitForWorkerContainerStopped(workerContainerId);
    await waitForUnready();
    docker([...composeArguments(), "up", "--detach", "executor-worker"]);
    await waitForReady();
    await waitForWorkerCleanup();
    crashed.socket.close(1000);

    const recovered = await connectRunningExecution(cookie);
    await waitForWorkerActivity();
    const recoveredEnd = waitForSocketEnd(recovered.socket, "cancelled");
    recovered.socket.send(JSON.stringify({ type: "terminate" }));
    await recoveredEnd;
    recovered.socket.close(1000);
    await waitForWorkerCleanup();

    console.log("Production runtime cleanup smoke: PASS");
} finally {
    if (!keepStack) {
        docker([...composeArguments(), "down", "--volumes", "--remove-orphans"]);
    }
}
