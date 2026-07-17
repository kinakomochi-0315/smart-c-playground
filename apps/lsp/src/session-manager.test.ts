import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { LspSessionManager, SessionLimitError } from "./session-manager.js";
import { TicketService } from "./ticket.js";

/**
 * テスト用のセッション管理を一時ディレクトリ上に作成します。
 */
async function createTestManager(
    overrides: Partial<ConstructorParameters<typeof LspSessionManager>[0]> = {},
): Promise<LspSessionManager> {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "smart-c-lsp-test-"));
    return new LspSessionManager({
        workspaceRoot,
        clangdPath: "clangd",
        ticketService: new TicketService("s".repeat(32)),
        idleTtlMs: 60_000,
        absoluteTtlMs: 60_000,
        ticketTtlMs: 60_000,
        ...overrides,
    });
}

test("全ソースとC17 compile_flags.txtを作成して一回限りチケットを発行する", async () => {
    const manager = await createTestManager();
    const response = await manager.createSession({
        files: [
            { name: "main.c", content: "int main(void) { return answer(); }\n" },
            { name: "aaa.h", content: "int answer(void);\n" },
            { name: "aaa.c", content: "int answer(void) { return 0; }\n" },
        ],
        visitorId: "visitor-1",
        clientIp: "192.0.2.1",
    });

    const mainPath = fileURLToPath(response.documentUris["main.c"]);
    assert.equal(await readFile(mainPath, "utf8"), "int main(void) { return answer(); }\n");
    assert.equal(await readFile(fileURLToPath(response.documentUris["aaa.h"]), "utf8"), "int answer(void);\n");
    assert.equal(
        await readFile(join(mainPath, "..", "compile_flags.txt"), "utf8"),
        "-xc\n-std=c17\n-Wall\n-Wextra\n-Wpedantic\n",
    );

    assert.deepEqual(manager.authorizeWebSocket(response.id, response.webSocketPath, response.ticket), {
        authorized: true,
        sessionId: response.id,
    });
    assert.deepEqual(manager.authorizeWebSocket(response.id, response.webSocketPath, response.ticket), {
        authorized: false,
        status: 409,
        code: "ticket_used",
    });

    await manager.shutdown();
});

test("未使用チケットの期限切れでセッションとworkspaceを削除する", async () => {
    const manager = await createTestManager({
        ticketTtlMs: 10,
    });
    const response = await manager.createSession({
        files: [{ name: "main.c", content: "" }],
        visitorId: "visitor-1",
        clientIp: "192.0.2.1",
    });
    const mainPath = fileURLToPath(response.documentUris["main.c"]);

    await new Promise<void>((resolve) => {
        setTimeout(resolve, 30);
    });

    assert.equal(manager.stats().active, 0);
    await assert.rejects(readFile(mainPath, "utf8"), { code: "ENOENT" });
    await manager.shutdown();
});

test("visitor単位とIP単位の同時セッション上限を適用する", async () => {
    const manager = await createTestManager({
        maxSessions: 8,
        maxSessionsPerVisitor: 1,
        maxSessionsPerIp: 2,
    });
    await manager.createSession({
        files: [{ name: "main.c", content: "" }],
        visitorId: "visitor-1",
        clientIp: "192.0.2.1",
    });

    await assert.rejects(
        manager.createSession({
            files: [{ name: "main.c", content: "" }],
            visitorId: "visitor-1",
            clientIp: "192.0.2.2",
        }),
        (error: unknown) => error instanceof SessionLimitError && error.kind === "visitor",
    );

    await manager.createSession({
        files: [{ name: "main.c", content: "" }],
        visitorId: "visitor-2",
        clientIp: "192.0.2.1",
    });
    await assert.rejects(
        manager.createSession({
            files: [{ name: "main.c", content: "" }],
            visitorId: "visitor-3",
            clientIp: "192.0.2.1",
        }),
        (error: unknown) => error instanceof SessionLimitError && error.kind === "ip",
    );

    await manager.shutdown();
});

test("異なるパスへチケットを流用できない", async () => {
    const manager = await createTestManager();
    const response = await manager.createSession({
        files: [{ name: "main.c", content: "" }],
        visitorId: "visitor-1",
        clientIp: "192.0.2.1",
    });

    assert.deepEqual(manager.authorizeWebSocket(response.id, "/ws/lsp/not-the-session", response.ticket), {
        authorized: false,
        status: 401,
        code: "invalid_ticket",
    });

    await manager.shutdown();
});

test("sandbox利用時はブラウザへ/workspace/main.cだけを公開する", async () => {
    const manager = await createTestManager({
        clangdSandboxPath: "/usr/bin/bwrap",
        clangdLimiterPath: "/usr/bin/prlimit",
    });
    const response = await manager.createSession({
        files: [{ name: "main.c", content: "" }],
        visitorId: "visitor-1",
        clientIp: "192.0.2.1",
    });

    assert.equal(response.workspaceUri, "file:///workspace");
    assert.equal(response.documentUris["main.c"], "file:///workspace/main.c");
    await manager.shutdown();
});
