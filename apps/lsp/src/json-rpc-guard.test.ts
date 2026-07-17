import assert from "node:assert/strict";
import test from "node:test";

import { LspJsonRpcGuard } from "./json-rpc-guard.js";

const DOCUMENT_URI = "file:///tmp/session/main.c";
const WORKSPACE_URI = "file:///tmp/session";

/**
 * JSON-RPCメッセージをテスト用文字列へ変換します。
 */
function message(value: object): string {
    return JSON.stringify({
        jsonrpc: "2.0",
        ...value,
    });
}

/**
 * initializeとinitializedを通過済みの検証器を作成します。
 */
function createInitializedGuard(overrides: Partial<ConstructorParameters<typeof LspJsonRpcGuard>[0]> = {}) {
    const guard = new LspJsonRpcGuard({
        documentUri: DOCUMENT_URI,
        workspaceUri: WORKSPACE_URI,
        ...overrides,
    });

    assert.deepEqual(
        guard.validateClientMessage(
            message({
                id: 1,
                method: "initialize",
                params: {
                    rootUri: WORKSPACE_URI,
                    workspaceFolders: [
                        {
                            name: "workspace",
                            uri: WORKSPACE_URI,
                        },
                    ],
                    capabilities: {},
                },
            }),
        ),
        { accepted: true },
    );
    assert.deepEqual(
        guard.validateClientMessage(
            message({
                method: "initialized",
                params: {},
            }),
        ),
        { accepted: true },
    );

    return guard;
}

test("単一main.cのopen・増分変更・completionを許可する", () => {
    const guard = createInitializedGuard({
        maxDocumentBytes: 16,
    });

    assert.deepEqual(
        guard.validateClientMessage(
            message({
                method: "textDocument/didOpen",
                params: {
                    textDocument: {
                        uri: DOCUMENT_URI,
                        languageId: "c",
                        version: 1,
                        text: "abc\n",
                    },
                },
            }),
        ),
        { accepted: true },
    );
    assert.deepEqual(
        guard.validateClientMessage(
            message({
                method: "textDocument/didChange",
                params: {
                    textDocument: {
                        uri: DOCUMENT_URI,
                        version: 2,
                    },
                    contentChanges: [
                        {
                            range: {
                                start: { line: 0, character: 3 },
                                end: { line: 0, character: 3 },
                            },
                            text: "def",
                        },
                    ],
                },
            }),
        ),
        { accepted: true },
    );
    assert.deepEqual(
        guard.validateClientMessage(
            message({
                id: 2,
                method: "textDocument/completion",
                params: {
                    textDocument: {
                        uri: DOCUMENT_URI,
                    },
                    position: {
                        line: 0,
                        character: 3,
                    },
                },
            }),
        ),
        { accepted: true },
    );
});

test("ifスニペット相当の単一変更後もcompletionを許可する", () => {
    const guard = createInitializedGuard();
    const source = "int main(void) {\n    if\n}\n";

    assert.deepEqual(
        guard.validateClientMessage(
            message({
                method: "textDocument/didOpen",
                params: {
                    textDocument: {
                        uri: DOCUMENT_URI,
                        languageId: "c",
                        version: 1,
                        text: source,
                    },
                },
            }),
        ),
        { accepted: true },
    );
    assert.deepEqual(
        guard.validateClientMessage(
            message({
                method: "textDocument/didChange",
                params: {
                    textDocument: {
                        uri: DOCUMENT_URI,
                        version: 2,
                    },
                    contentChanges: [
                        {
                            range: {
                                start: { line: 1, character: 4 },
                                end: { line: 1, character: 6 },
                            },
                            rangeLength: 2,
                            text: "if (condition) {\n        \n    }",
                        },
                    ],
                },
            }),
        ),
        { accepted: true },
    );
    assert.deepEqual(
        guard.validateClientMessage(
            message({
                id: 2,
                method: "textDocument/completion",
                params: {
                    textDocument: {
                        uri: DOCUMENT_URI,
                    },
                    position: {
                        line: 1,
                        character: 8,
                    },
                },
            }),
        ),
        { accepted: true },
    );
});

test("CodeMirror 6の初期化から診断までの一連のメッセージを許可する", () => {
    const guard = new LspJsonRpcGuard({
        documentUri: DOCUMENT_URI,
        workspaceUri: WORKSPACE_URI,
    });
    const source = "int main(void) {\n    int x = 1;\n    return x;\n}\n";

    assert.deepEqual(
        guard.validateClientMessage(
            message({
                id: 1,
                method: "initialize",
                params: {
                    processId: null,
                    clientInfo: {
                        name: "@codemirror/lsp-client",
                    },
                    rootUri: WORKSPACE_URI,
                    capabilities: {
                        workspace: {
                            configuration: true,
                        },
                        textDocument: {
                            completion: {},
                            hover: {},
                            publishDiagnostics: {},
                            synchronization: {},
                        },
                    },
                },
            }),
        ),
        { accepted: true },
    );
    assert.deepEqual(
        guard.validateClientMessage(
            message({
                method: "initialized",
                params: {},
            }),
        ),
        { accepted: true },
    );
    assert.deepEqual(
        guard.validateClientMessage(
            message({
                method: "textDocument/didOpen",
                params: {
                    textDocument: {
                        uri: DOCUMENT_URI,
                        languageId: "c",
                        version: 1,
                        text: source,
                    },
                },
            }),
        ),
        { accepted: true },
    );
    assert.deepEqual(
        guard.validateClientMessage(
            message({
                method: "textDocument/didChange",
                params: {
                    textDocument: {
                        uri: DOCUMENT_URI,
                        version: 2,
                    },
                    // CodeMirrorは元文書の座標を保つため、後方の変更から順に同期する場合があります。
                    contentChanges: [
                        {
                            range: {
                                start: { line: 2, character: 13 },
                                end: { line: 2, character: 13 },
                            },
                            rangeLength: 0,
                            text: "\n    }",
                        },
                        {
                            range: {
                                start: { line: 2, character: 4 },
                                end: { line: 2, character: 4 },
                            },
                            rangeLength: 0,
                            text: "if (x) {\n        ",
                        },
                    ],
                },
            }),
        ),
        { accepted: true },
    );
    assert.deepEqual(
        guard.validateClientMessage(
            message({
                id: 2,
                method: "textDocument/completion",
                params: {
                    textDocument: {
                        uri: DOCUMENT_URI,
                    },
                    position: {
                        line: 3,
                        character: 8,
                    },
                },
            }),
        ),
        { accepted: true },
    );
    assert.deepEqual(
        guard.validateClientMessage(
            message({
                id: 3,
                method: "textDocument/hover",
                params: {
                    textDocument: {
                        uri: DOCUMENT_URI,
                    },
                    position: {
                        line: 1,
                        character: 8,
                    },
                },
            }),
        ),
        { accepted: true },
    );
    assert.deepEqual(
        guard.validateServerMessage(
            message({
                method: "textDocument/publishDiagnostics",
                params: {
                    uri: DOCUMENT_URI,
                    version: 2,
                    diagnostics: [
                        {
                            range: {
                                start: { line: 1, character: 8 },
                                end: { line: 1, character: 9 },
                            },
                            severity: 2,
                            source: "clangd",
                            message: "Unused variable 'x'",
                        },
                    ],
                },
            }),
            0,
        ),
        { accepted: true },
    );
});

test("別URI・未許可method・64KiB超過を拒否する", () => {
    const wrongUriGuard = createInitializedGuard();
    const wrongUri = wrongUriGuard.validateClientMessage(
        message({
            method: "textDocument/didOpen",
            params: {
                textDocument: {
                    uri: "file:///etc/passwd",
                    languageId: "c",
                    version: 1,
                    text: "",
                },
            },
        }),
    );
    assert.equal(wrongUri.accepted, false);

    const unknownMethodGuard = createInitializedGuard();
    const unknownMethod = unknownMethodGuard.validateClientMessage(
        message({
            id: 2,
            method: "workspace/executeCommand",
            params: {
                command: "clangd.applyFix",
            },
        }),
    );
    assert.equal(unknownMethod.accepted, false);

    const oversizedGuard = createInitializedGuard({
        maxDocumentBytes: 8,
    });
    const oversized = oversizedGuard.validateClientMessage(
        message({
            method: "textDocument/didOpen",
            params: {
                textDocument: {
                    uri: DOCUMENT_URI,
                    languageId: "c",
                    version: 1,
                    text: "123456789",
                },
            },
        }),
    );
    assert.equal(oversized.accepted, false);
});

test("initializeのrootUri・rootPath・workspaceFoldersをセッションworkspaceへ固定する", () => {
    for (const params of [
        {
            rootPath: "/",
            rootUri: WORKSPACE_URI,
            capabilities: {},
        },
        {
            rootUri: "file:///",
            capabilities: {},
        },
        {
            capabilities: {},
        },
        {
            rootUri: WORKSPACE_URI,
            workspaceFolders: [
                {
                    name: "root",
                    uri: "file:///",
                },
            ],
            capabilities: {},
        },
    ]) {
        const guard = new LspJsonRpcGuard({
            documentUri: DOCUMENT_URI,
            workspaceUri: WORKSPACE_URI,
        });
        const result = guard.validateClientMessage(
            message({
                id: 1,
                method: "initialize",
                params,
            }),
        );
        assert.equal(result.accepted, false);
    }

    const exactRootPathGuard = new LspJsonRpcGuard({
        documentUri: DOCUMENT_URI,
        workspaceUri: WORKSPACE_URI,
    });
    assert.equal(
        exactRootPathGuard.validateClientMessage(
            message({
                id: 1,
                method: "initialize",
                params: {
                    rootPath: "/tmp/session",
                    rootUri: WORKSPACE_URI,
                    capabilities: {},
                },
            }),
        ).accepted,
        true,
    );
});

test("増分変更後の全文サイズを追跡する", () => {
    const guard = createInitializedGuard({
        maxDocumentBytes: 8,
    });
    assert.equal(
        guard.validateClientMessage(
            message({
                method: "textDocument/didOpen",
                params: {
                    textDocument: {
                        uri: DOCUMENT_URI,
                        languageId: "c",
                        version: 1,
                        text: "abc\n",
                    },
                },
            }),
        ).accepted,
        true,
    );
    assert.equal(
        guard.validateClientMessage(
            message({
                method: "textDocument/didChange",
                params: {
                    textDocument: {
                        uri: DOCUMENT_URI,
                        version: 2,
                    },
                    contentChanges: [
                        {
                            range: {
                                start: { line: 0, character: 3 },
                                end: { line: 0, character: 3 },
                            },
                            text: "def",
                        },
                    ],
                },
            }),
        ).accepted,
        true,
    );

    const result = guard.validateClientMessage(
        message({
            method: "textDocument/didChange",
            params: {
                textDocument: {
                    uri: DOCUMENT_URI,
                    version: 3,
                },
                contentChanges: [
                    {
                        range: {
                            start: { line: 0, character: 6 },
                            end: { line: 0, character: 6 },
                        },
                        text: "zz",
                    },
                ],
            },
        }),
    );
    assert.equal(result.accepted, false);
});

test("didChangeの変更件数とJSON構造量を制限する", () => {
    const guard = createInitializedGuard();
    assert.equal(
        guard.validateClientMessage(
            message({
                method: "textDocument/didOpen",
                params: {
                    textDocument: {
                        uri: DOCUMENT_URI,
                        languageId: "c",
                        version: 1,
                        text: "",
                    },
                },
            }),
        ).accepted,
        true,
    );

    const tooManyChanges = guard.validateClientMessage(
        message({
            method: "textDocument/didChange",
            params: {
                textDocument: {
                    uri: DOCUMENT_URI,
                    version: 2,
                },
                contentChanges: Array.from({ length: 129 }, () => ({
                    text: "",
                })),
            },
        }),
    );
    assert.equal(tooManyChanges.accepted, false);

    const excessiveNodesGuard = new LspJsonRpcGuard({
        documentUri: DOCUMENT_URI,
        workspaceUri: WORKSPACE_URI,
    });
    const excessiveNodes = excessiveNodesGuard.validateClientMessage(
        message({
            id: 1,
            result: Array.from({ length: 16_385 }, () => null),
        }),
    );
    assert.equal(excessiveNodes.accepted, false);
});

test("受信rateとセッション累積量を制限する", () => {
    const rateGuard = new LspJsonRpcGuard({
        documentUri: DOCUMENT_URI,
        workspaceUri: WORKSPACE_URI,
        clientMaxMessagesPerWindow: 1,
    });
    assert.equal(
        rateGuard.validateClientMessage(
            message({
                id: 1,
                method: "initialize",
                params: {
                    rootUri: WORKSPACE_URI,
                    capabilities: {},
                },
            }),
        ).accepted,
        true,
    );
    const rateResult = rateGuard.validateClientMessage(
        message({
            method: "initialized",
            params: {},
        }),
    );
    assert.deepEqual(rateResult, {
        accepted: false,
        closeCode: 1013,
        reason: "LSP message rate exceeded",
    });

    const bytesGuard = new LspJsonRpcGuard({
        documentUri: DOCUMENT_URI,
        workspaceUri: WORKSPACE_URI,
        clientMaxSessionBytes: 8,
    });
    const bytesResult = bytesGuard.validateClientMessage(
        message({
            id: 1,
            result: null,
        }),
    );
    assert.deepEqual(bytesResult, {
        accepted: false,
        closeCode: 1009,
        reason: "LSP request budget exceeded",
    });
});

test("diagnosticsはmain.cだけを許可し、送信サイズとbufferを制限する", () => {
    const guard = createInitializedGuard({
        serverMaxMessageBytes: 512,
        serverMaxBufferedBytes: 512,
        serverMaxSessionBytes: 1024,
    });
    assert.deepEqual(
        guard.validateServerMessage(
            message({
                method: "textDocument/publishDiagnostics",
                params: {
                    uri: DOCUMENT_URI,
                    diagnostics: [],
                },
            }),
            0,
        ),
        { accepted: true },
    );

    const wrongUri = guard.validateServerMessage(
        message({
            method: "textDocument/publishDiagnostics",
            params: {
                uri: "file:///etc/passwd",
                diagnostics: [],
            },
        }),
        0,
    );
    assert.equal(wrongUri.accepted, false);

    const bufferedGuard = createInitializedGuard({
        serverMaxBufferedBytes: 1,
    });
    assert.deepEqual(
        bufferedGuard.validateServerMessage(
            message({
                id: 1,
                result: null,
            }),
            1,
        ),
        {
            accepted: false,
            closeCode: 1013,
            reason: "LSP response buffer is full",
        },
    );
});
