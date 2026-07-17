import assert from "node:assert/strict";
import test from "node:test";

import {
    createClangdDocumentUri,
    createClangdEnvironment,
    createClangdProcessSpec,
    createClangdWorkspaceUri,
} from "./clangd-process.js";

test("direct開発時は実workspaceでclangdを起動する", () => {
    const spec = createClangdProcessSpec({
        clangdPath: "clangd",
        workspacePath: "/tmp/session",
    });

    assert.equal(spec.command, "clangd");
    assert.equal(spec.options.cwd, "/tmp/session");
    assert.ok(spec.arguments.includes("--compile-commands-dir=/tmp/session"));
    assert.ok(spec.arguments.includes("--enable-config=false"));
    assert.ok(spec.arguments.includes("-j=1"));
    assert.equal(createClangdDocumentUri("/tmp/session", false), "file:///tmp/session/main.c");
    assert.equal(createClangdWorkspaceUri("/tmp/session", false), "file:///tmp/session");
});

test("productionではbubblewrap内/workspaceとprlimitを使う", () => {
    const spec = createClangdProcessSpec({
        clangdPath: "/usr/bin/clangd",
        workspacePath: "/tmp/smart-c-lsp/session",
        sandboxPath: "/usr/bin/bwrap",
        limiterPath: "/usr/bin/prlimit",
        hiddenPathForSmokeTest: "/tmp/smart-c-lsp/hidden-sentinel",
    });

    assert.equal(spec.command, "/usr/bin/bwrap");
    assert.ok(spec.arguments.includes("--unshare-user"));
    assert.ok(spec.arguments.includes("--unshare-pid"));
    assert.ok(spec.arguments.includes("--unshare-net"));
    assert.deepEqual(
        spec.arguments.slice(spec.arguments.indexOf("--cap-drop"), spec.arguments.indexOf("--cap-drop") + 2),
        ["--cap-drop", "ALL"],
    );
    assert.deepEqual(spec.arguments.slice(spec.arguments.indexOf("--bind"), spec.arguments.indexOf("--bind") + 3), [
        "--bind",
        "/tmp/smart-c-lsp/session",
        "/workspace",
    ]);
    assert.ok(spec.arguments.includes("/usr/bin/prlimit"));
    assert.ok(spec.arguments.includes("--as=402653184:402653184"));
    assert.ok(spec.arguments.includes("--cpu=60:60"));
    assert.ok(spec.arguments.includes("/tmp/smart-c-lsp/hidden-sentinel"));
    assert.equal(createClangdDocumentUri("/tmp/smart-c-lsp/session", true), "file:///workspace/main.c");
    assert.equal(createClangdWorkspaceUri("/tmp/smart-c-lsp/session", true), "file:///workspace");
});

test("clangdへサービス秘密値を継承しない", () => {
    const previousInternalToken = process.env.INTERNAL_SERVICE_TOKEN;
    const previousSigningSecret = process.env.SESSION_SIGNING_SECRET;
    process.env.INTERNAL_SERVICE_TOKEN = "must-not-leak";
    process.env.SESSION_SIGNING_SECRET = "must-not-leak";

    try {
        const environment = createClangdEnvironment("/tmp/session");

        assert.equal(environment.HOME, "/tmp/session");
        assert.equal(environment.INTERNAL_SERVICE_TOKEN, undefined);
        assert.equal(environment.SESSION_SIGNING_SECRET, undefined);
    } finally {
        restoreEnvironment("INTERNAL_SERVICE_TOKEN", previousInternalToken);
        restoreEnvironment("SESSION_SIGNING_SECRET", previousSigningSecret);
    }
});

/**
 * テスト前の環境変数状態を復元します。
 */
function restoreEnvironment(name: string, value: string | undefined): void {
    if (value === undefined) {
        delete process.env[name];
        return;
    }
    process.env[name] = value;
}
