import assert from "node:assert/strict";
import test from "node:test";

import { loadConfig } from "./config.js";

test("必須の秘密値と既定値を読み込める", () => {
    const config = loadConfig({
        INTERNAL_SERVICE_TOKEN: "i".repeat(32),
        SESSION_SIGNING_SECRET: "s".repeat(32),
    });

    assert.equal(config.port, 3001);
    assert.equal(config.host, "0.0.0.0");
    assert.equal(config.webOrigin, "http://localhost:8080");
    assert.equal(config.workspaceRoot, "/tmp/smart-c-lsp");
    assert.equal(config.clangdPath, "clangd");
    assert.equal(config.clangdSandboxPath, undefined);
    assert.equal(config.clangdLimiterPath, undefined);
    assert.equal(config.maxSessions, 8);
    assert.equal(config.maxSessionsPerVisitor, 1);
    assert.equal(config.maxSessionsPerIp, 2);
});

test("WebSocketの公開オリジンを検証する", () => {
    const config = loadConfig({
        INTERNAL_SERVICE_TOKEN: "i".repeat(32),
        SESSION_SIGNING_SECRET: "s".repeat(32),
        WEB_ORIGIN: "https://playground.example.com",
    });

    assert.equal(config.webOrigin, "https://playground.example.com");
    assert.throws(
        () =>
            loadConfig({
                INTERNAL_SERVICE_TOKEN: "i".repeat(32),
                SESSION_SIGNING_SECRET: "s".repeat(32),
                WEB_ORIGIN: "https://playground.example.com/path",
            }),
        /WEB_ORIGIN/,
    );
});

test("短い秘密値を拒否する", () => {
    assert.throws(
        () =>
            loadConfig({
                INTERNAL_SERVICE_TOKEN: "short",
                SESSION_SIGNING_SECRET: "s".repeat(32),
            }),
        /INTERNAL_SERVICE_TOKEN/,
    );
});

test("セッション上限を環境変数で上書きできる", () => {
    const config = loadConfig({
        INTERNAL_SERVICE_TOKEN: "i".repeat(32),
        SESSION_SIGNING_SECRET: "s".repeat(32),
        LSP_MAX_SESSIONS: "12",
        LSP_MAX_SESSIONS_PER_VISITOR: "2",
        LSP_MAX_SESSIONS_PER_IP: "4",
    });

    assert.equal(config.maxSessions, 12);
    assert.equal(config.maxSessionsPerVisitor, 2);
    assert.equal(config.maxSessionsPerIp, 4);
});

test("Productionではclangd sandboxとprocess limiterを必須にする", () => {
    assert.throws(
        () =>
            loadConfig({
                NODE_ENV: "production",
                INTERNAL_SERVICE_TOKEN: "i".repeat(32),
                SESSION_SIGNING_SECRET: "s".repeat(32),
            }),
        /CLANGD_SANDBOX_PATH/,
    );

    const config = loadConfig({
        NODE_ENV: "production",
        INTERNAL_SERVICE_TOKEN: "i".repeat(32),
        SESSION_SIGNING_SECRET: "s".repeat(32),
        CLANGD_SANDBOX_PATH: "/usr/bin/bwrap",
        CLANGD_LIMITER_PATH: "/usr/bin/prlimit",
    });
    assert.equal(config.clangdSandboxPath, "/usr/bin/bwrap");
    assert.equal(config.clangdLimiterPath, "/usr/bin/prlimit");
});
