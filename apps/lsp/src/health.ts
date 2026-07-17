import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { createClangdProcessSpec, type ClangdProcessSpec } from "./clangd-process.js";

const DEFAULT_PROBE_INTERVAL_MS = 30_000;
const DEFAULT_PROBE_TIMEOUT_MS = 2_000;

/**
 * clangd readinessの現在値です。
 */
export interface HealthSnapshot {
    ready: boolean;
    checkedAt: string | null;
}

/**
 * HTTP層が参照するreadinessインターフェースです。
 */
export interface HealthProvider {
    isReady(): boolean;
    snapshot(): HealthSnapshot;
}

/**
 * clangd readiness probeの設定です。
 */
export interface ClangdHealthProbeOptions {
    clangdPath: string;
    workspaceRoot: string;
    sandboxPath?: string;
    limiterPath?: string;
    intervalMs?: number;
    timeoutMs?: number;
}

/**
 * clangdを定期的に起動確認し、readinessへ反映します。
 */
export class ClangdHealthProbe implements HealthProvider {
    readonly #clangdPath: string;
    readonly #workspacePath: string;
    readonly #hiddenSentinelPath: string;
    readonly #sandboxPath: string | undefined;
    readonly #limiterPath: string | undefined;
    readonly #intervalMs: number;
    readonly #timeoutMs: number;
    #ready = false;
    #checkedAt: string | null = null;
    #interval: NodeJS.Timeout | null = null;
    #checking: Promise<void> | null = null;

    /**
     * clangd health probeを初期化します。
     */
    public constructor(options: ClangdHealthProbeOptions) {
        this.#clangdPath = options.clangdPath;
        this.#workspacePath = join(options.workspaceRoot, ".health-probe");
        this.#hiddenSentinelPath = join(options.workspaceRoot, ".sandbox-hidden-sentinel");
        this.#sandboxPath = options.sandboxPath;
        this.#limiterPath = options.limiterPath;
        this.#intervalMs = options.intervalMs ?? DEFAULT_PROBE_INTERVAL_MS;
        this.#timeoutMs = options.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
    }

    /**
     * 初回確認を行い、以後の定期確認を開始します。
     */
    public async start(): Promise<void> {
        await mkdir(this.#workspacePath, {
            recursive: true,
            mode: 0o700,
        });
        await Promise.all([
            writeFile(join(this.#workspacePath, "main.c"), "", {
                encoding: "utf8",
                mode: 0o600,
            }),
            writeFile(this.#hiddenSentinelPath, "sandbox must not expose this file", {
                encoding: "utf8",
                mode: 0o600,
            }),
        ]);
        await this.check();
        this.#interval = setInterval(() => {
            void this.check();
        }, this.#intervalMs);
        this.#interval.unref();
    }

    /**
     * 定期確認を停止します。
     */
    public stop(): void {
        if (this.#interval !== null) {
            clearInterval(this.#interval);
            this.#interval = null;
        }
    }

    /**
     * 現在のreadinessを返します。
     */
    public isReady(): boolean {
        return this.#ready;
    }

    /**
     * health endpoint用のスナップショットを返します。
     */
    public snapshot(): HealthSnapshot {
        return {
            ready: this.#ready,
            checkedAt: this.#checkedAt,
        };
    }

    /**
     * clangd --versionが制限時間内に成功するか確認します。
     */
    public async check(): Promise<void> {
        if (this.#checking !== null) {
            return this.#checking;
        }

        this.#checking = this.#runCheck();
        try {
            await this.#checking;
        } finally {
            this.#checking = null;
        }
    }

    /**
     * clangdの単発probeを実行し、結果を保存します。
     */
    async #runCheck(): Promise<void> {
        const spec = createClangdProcessSpec({
            clangdPath: this.#clangdPath,
            workspacePath: this.#workspacePath,
            sandboxPath: this.#sandboxPath,
            limiterPath: this.#limiterPath,
            clangdArguments: ["--version"],
            hiddenPathForSmokeTest: this.#sandboxPath === undefined ? undefined : this.#hiddenSentinelPath,
        });
        this.#ready = await probeProcess(spec, this.#timeoutMs);
        this.#checkedAt = new Date().toISOString();
    }
}

/**
 * 外部コマンドをshellなしで起動し、正常終了を確認します。
 */
async function probeProcess(spec: ClangdProcessSpec, timeoutMs: number): Promise<boolean> {
    return new Promise((resolve) => {
        const child = spawn(spec.command, spec.arguments, {
            ...spec.options,
            stdio: "ignore",
        });
        let settled = false;

        /**
         * probe結果を一度だけ確定します。
         */
        const finish = (ready: boolean): void => {
            if (settled) {
                return;
            }
            settled = true;
            clearTimeout(timeout);
            resolve(ready);
        };

        const timeout = setTimeout(() => {
            child.kill("SIGKILL");
            finish(false);
        }, timeoutMs);
        timeout.unref();

        child.once("error", () => finish(false));
        child.once("exit", (code) => finish(code === 0));
    });
}
