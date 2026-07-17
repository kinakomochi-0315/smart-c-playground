import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createApp } from "./app.js";
import type { HealthProvider, HealthSnapshot } from "./health.js";
import { LspSessionManager } from "./session-manager.js";
import { TicketService } from "./ticket.js";

const INTERNAL_TOKEN = "i".repeat(32);

/**
 * テストでreadinessを固定するhealth providerです。
 */
class StaticHealthProvider implements HealthProvider {
    readonly #ready: boolean;

    /**
     * 固定するreadinessを受け取ります。
     */
    public constructor(ready: boolean) {
        this.#ready = ready;
    }

    /**
     * 固定したreadinessを返します。
     */
    public isReady(): boolean {
        return this.#ready;
    }

    /**
     * health endpoint用の固定スナップショットを返します。
     */
    public snapshot(): HealthSnapshot {
        return {
            ready: this.#ready,
            checkedAt: "2026-07-16T00:00:00.000Z",
        };
    }
}

/**
 * テスト用アプリケーションと後始末関数を作成します。
 */
async function createTestApp(ready = true): Promise<{
    app: ReturnType<typeof createApp>;
    manager: LspSessionManager;
}> {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "smart-c-lsp-app-test-"));
    const manager = new LspSessionManager({
        workspaceRoot,
        clangdPath: "clangd",
        ticketService: new TicketService("s".repeat(32)),
        idleTtlMs: 60_000,
        absoluteTtlMs: 60_000,
        ticketTtlMs: 60_000,
    });
    return {
        app: createApp({
            manager,
            health: new StaticHealthProvider(ready),
            internalToken: INTERNAL_TOKEN,
        }),
        manager,
    };
}

test("内部認証済みリクエストへLSPセッションを返す", async () => {
    const { app, manager } = await createTestApp();
    const response = await app.request("/internal/sessions", {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "X-Internal-Token": INTERNAL_TOKEN,
        },
        body: JSON.stringify({
            files: [{ name: "main.c", content: "int main(void) { return 0; }\n" }],
            visitorId: "visitor-1",
            clientIp: "192.0.2.1",
        }),
    });
    const body = (await response.json()) as Record<string, unknown>;

    assert.equal(response.status, 201);
    assert.equal(response.headers.get("Cache-Control"), "no-store");
    assert.equal(typeof body.id, "string");
    assert.equal(typeof body.ticket, "string");
    assert.match(String(body.webSocketPath), /^\/ws\/lsp\//);

    await manager.shutdown();
});

test("JSON escape後も64KiB以内のソースを受理する", async () => {
    const { app, manager } = await createTestApp();
    const response = await app.request("/internal/sessions", {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "X-Internal-Token": INTERNAL_TOKEN,
        },
        body: JSON.stringify({
            files: [{ name: "main.c", content: "\n".repeat(64 * 1024) }],
            visitorId: "visitor-1",
            clientIp: "192.0.2.1",
        }),
    });

    assert.equal(response.status, 201);
    await manager.shutdown();
});

test("内部トークンがないリクエストを拒否する", async () => {
    const { app, manager } = await createTestApp();
    const response = await app.request("/internal/sessions", {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
        },
        body: JSON.stringify({
            files: [{ name: "main.c", content: "" }],
            visitorId: "visitor-1",
            clientIp: "192.0.2.1",
        }),
    });

    assert.equal(response.status, 401);
    assert.equal(response.headers.get("Content-Type"), "application/problem+json");
    await manager.shutdown();
});

test("clangdが利用不能ならreadinessとセッション作成を503にする", async () => {
    const { app, manager } = await createTestApp(false);

    assert.equal((await app.request("/internal/health/live")).status, 200);
    assert.equal((await app.request("/internal/health/ready")).status, 503);
    assert.equal((await app.request("/api/health")).status, 503);

    const response = await app.request("/internal/sessions", {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "X-Internal-Token": INTERNAL_TOKEN,
        },
        body: JSON.stringify({
            files: [{ name: "main.c", content: "" }],
            visitorId: "visitor-1",
            clientIp: "192.0.2.1",
        }),
    });
    assert.equal(response.status, 503);

    await manager.shutdown();
});
