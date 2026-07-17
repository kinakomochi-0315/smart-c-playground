import { fileURLToPath } from "node:url";

export const LSP_DOCUMENT_MAX_BYTES = 64 * 1024;
export const LSP_CLIENT_RATE_WINDOW_MS = 10_000;
export const LSP_CLIENT_MAX_MESSAGES_PER_WINDOW = 300;
export const LSP_CLIENT_MAX_SESSION_BYTES = 32 * 1024 * 1024;
export const LSP_SERVER_MAX_MESSAGE_BYTES = 1024 * 1024;
export const LSP_SERVER_MAX_BUFFERED_BYTES = 1024 * 1024;
export const LSP_SERVER_MAX_SESSION_BYTES = 64 * 1024 * 1024;
export const LSP_MAX_CONTENT_CHANGES = 128;

const MAX_JSON_NODES = 16_384;
const MAX_JSON_DEPTH = 64;

const CLIENT_METHODS = new Set([
    "$/cancelRequest",
    "$/setTrace",
    "codeAction/resolve",
    "codeLens/resolve",
    "colorPresentation",
    "completionItem/resolve",
    "documentLink/resolve",
    "exit",
    "initialize",
    "initialized",
    "inlayHint/resolve",
    "shutdown",
    "textDocument/codeAction",
    "textDocument/codeLens",
    "textDocument/colorPresentation",
    "textDocument/completion",
    "textDocument/declaration",
    "textDocument/definition",
    "textDocument/diagnostic",
    "textDocument/didChange",
    "textDocument/didClose",
    "textDocument/didOpen",
    "textDocument/didSave",
    "textDocument/documentColor",
    "textDocument/documentHighlight",
    "textDocument/documentLink",
    "textDocument/documentSymbol",
    "textDocument/foldingRange",
    "textDocument/formatting",
    "textDocument/hover",
    "textDocument/implementation",
    "textDocument/inlayHint",
    "textDocument/linkedEditingRange",
    "textDocument/moniker",
    "textDocument/onTypeFormatting",
    "textDocument/prepareRename",
    "textDocument/rangeFormatting",
    "textDocument/references",
    "textDocument/rename",
    "textDocument/selectionRange",
    "textDocument/semanticTokens/full",
    "textDocument/semanticTokens/full/delta",
    "textDocument/semanticTokens/range",
    "textDocument/signatureHelp",
    "textDocument/typeDefinition",
    "textDocument/willSave",
    "textDocument/willSaveWaitUntil",
    "window/workDoneProgress/cancel",
    "workspace/didChangeConfiguration",
]);

const DOCUMENT_METHODS = new Set(
    [...CLIENT_METHODS].filter(
        (method) => method.startsWith("textDocument/") && !method.startsWith("textDocument/did"),
    ),
);
const URI_PROPERTY_NAMES = new Set(["uri", "targetUri", "oldUri", "newUri"]);

/**
 * JSON-RPC境界違反時にWebSocketへ返す切断情報です。
 */
export type JsonRpcGuardResult =
    | {
          accepted: true;
      }
    | {
          accepted: false;
          closeCode: 1008 | 1009 | 1013;
          reason: string;
      };

/**
 * LSP JSON-RPC検証器の設定です。
 */
export interface LspJsonRpcGuardOptions {
    documentUri: string;
    workspaceUri: string;
    maxDocumentBytes?: number;
    clientRateWindowMs?: number;
    clientMaxMessagesPerWindow?: number;
    clientMaxSessionBytes?: number;
    serverMaxMessageBytes?: number;
    serverMaxBufferedBytes?: number;
    serverMaxSessionBytes?: number;
    now?: () => number;
}

interface JsonObject {
    [key: string]: unknown;
}

/**
 * 単一main.cへ許可したLSPメッセージだけを通過させます。
 */
export class LspJsonRpcGuard {
    readonly #documentUri: string;
    readonly #workspaceUri: string;
    readonly #maxDocumentBytes: number;
    readonly #clientRateWindowMs: number;
    readonly #clientMaxMessagesPerWindow: number;
    readonly #clientMaxSessionBytes: number;
    readonly #serverMaxMessageBytes: number;
    readonly #serverMaxBufferedBytes: number;
    readonly #serverMaxSessionBytes: number;
    readonly #now: () => number;
    #clientWindowStartedAt: number;
    #clientMessagesInWindow = 0;
    #clientSessionBytes = 0;
    #serverSessionBytes = 0;
    #initializeSeen = false;
    #initializedSeen = false;
    #shutdownSeen = false;
    #documentText: string | null = null;
    #documentVersion: number | null = null;

    /**
     * セッション固有URIと通信量上限を保持します。
     */
    public constructor(options: LspJsonRpcGuardOptions) {
        this.#documentUri = options.documentUri;
        this.#workspaceUri = options.workspaceUri;
        this.#maxDocumentBytes = options.maxDocumentBytes ?? LSP_DOCUMENT_MAX_BYTES;
        this.#clientRateWindowMs = options.clientRateWindowMs ?? LSP_CLIENT_RATE_WINDOW_MS;
        this.#clientMaxMessagesPerWindow = options.clientMaxMessagesPerWindow ?? LSP_CLIENT_MAX_MESSAGES_PER_WINDOW;
        this.#clientMaxSessionBytes = options.clientMaxSessionBytes ?? LSP_CLIENT_MAX_SESSION_BYTES;
        this.#serverMaxMessageBytes = options.serverMaxMessageBytes ?? LSP_SERVER_MAX_MESSAGE_BYTES;
        this.#serverMaxBufferedBytes = options.serverMaxBufferedBytes ?? LSP_SERVER_MAX_BUFFERED_BYTES;
        this.#serverMaxSessionBytes = options.serverMaxSessionBytes ?? LSP_SERVER_MAX_SESSION_BYTES;
        this.#now = options.now ?? Date.now;
        this.#clientWindowStartedAt = this.#now();
    }

    /**
     * ブラウザからclangdへ送るJSON-RPCを検証します。
     */
    public validateClientMessage(content: string): JsonRpcGuardResult {
        const contentBytes = Buffer.byteLength(content, "utf8");
        const budgetResult = this.#consumeClientBudget(contentBytes);
        if (!budgetResult.accepted) {
            return budgetResult;
        }

        const message = parseJsonObject(content);
        if (message === null || message.jsonrpc !== "2.0") {
            return policyViolation("Invalid JSON-RPC message");
        }
        if (hasUnexpectedUri(message, this.#documentUri, this.#workspaceUri)) {
            return policyViolation("Unexpected document URI");
        }

        if (message.method === undefined) {
            return isJsonRpcResponse(message) ? accepted() : policyViolation("Invalid JSON-RPC response");
        }
        if (typeof message.method !== "string" || !CLIENT_METHODS.has(message.method)) {
            return policyViolation("LSP method is not allowed");
        }

        return this.#validateClientMethod(message.method, message.params);
    }

    /**
     * clangdからブラウザへ送るJSON-RPCのサイズと送信待ち量を検証します。
     */
    public validateServerMessage(content: string, bufferedAmount: number): JsonRpcGuardResult {
        const contentBytes = Buffer.byteLength(content, "utf8");
        if (contentBytes > this.#serverMaxMessageBytes) {
            return sizeViolation("LSP response is too large");
        }
        if (bufferedAmount + contentBytes > this.#serverMaxBufferedBytes) {
            return overloadViolation("LSP response buffer is full");
        }
        if (this.#serverSessionBytes + contentBytes > this.#serverMaxSessionBytes) {
            return sizeViolation("LSP response budget exceeded");
        }

        const message = parseJsonObject(content);
        if (message === null || message.jsonrpc !== "2.0") {
            return policyViolation("Invalid server JSON-RPC message");
        }
        if (hasUnexpectedUri(message, this.#documentUri, this.#workspaceUri)) {
            return policyViolation("Unexpected server document URI");
        }

        this.#serverSessionBytes += contentBytes;
        return accepted();
    }

    /**
     * methodごとの状態遷移と単一文書制約を検証します。
     */
    #validateClientMethod(method: string, params: unknown): JsonRpcGuardResult {
        if (method === "$/cancelRequest" || method === "$/setTrace") {
            return accepted();
        }
        if (method === "initialize") {
            if (this.#initializeSeen || !isValidInitializeParams(params, this.#workspaceUri)) {
                return policyViolation("Invalid initialize request");
            }
            this.#initializeSeen = true;
            return accepted();
        }
        if (method === "initialized") {
            if (!this.#initializeSeen || this.#initializedSeen) {
                return policyViolation("Invalid initialized notification");
            }
            this.#initializedSeen = true;
            return accepted();
        }
        if (method === "shutdown") {
            if (!this.#initializedSeen || this.#shutdownSeen) {
                return policyViolation("Invalid shutdown request");
            }
            this.#shutdownSeen = true;
            return accepted();
        }
        if (method === "exit") {
            return this.#shutdownSeen ? accepted() : policyViolation("Exit before shutdown");
        }
        if (!this.#initializedSeen || this.#shutdownSeen) {
            return policyViolation("LSP session is not active");
        }

        switch (method) {
            case "textDocument/didOpen":
                return this.#validateDidOpen(params);
            case "textDocument/didChange":
                return this.#validateDidChange(params);
            case "textDocument/didClose":
                return this.#validateDidClose(params);
            case "textDocument/didSave":
                return this.#validateDidSave(params);
            case "workspace/didChangeConfiguration":
                return isSafeConfigurationChange(params)
                    ? accepted()
                    : policyViolation("Workspace configuration is not allowed");
            default:
                return DOCUMENT_METHODS.has(method) && !hasExactTextDocument(params, this.#documentUri)
                    ? policyViolation("Unexpected text document")
                    : accepted();
        }
    }

    /**
     * main.cのdidOpenと初期全文を検証します。
     */
    #validateDidOpen(params: unknown): JsonRpcGuardResult {
        if (this.#documentText !== null || !isJsonObject(params) || !isJsonObject(params.textDocument)) {
            return policyViolation("Invalid didOpen notification");
        }

        const textDocument = params.textDocument;
        if (
            textDocument.uri !== this.#documentUri ||
            typeof textDocument.text !== "string" ||
            !isSafeDocumentText(textDocument.text, this.#maxDocumentBytes) ||
            !isDocumentVersion(textDocument.version)
        ) {
            return policyViolation("Invalid didOpen document");
        }

        this.#documentText = textDocument.text;
        this.#documentVersion = textDocument.version;
        return accepted();
    }

    /**
     * main.cの増分変更を適用し、適用後も64KiB以下か検証します。
     */
    #validateDidChange(params: unknown): JsonRpcGuardResult {
        if (
            this.#documentText === null ||
            this.#documentVersion === null ||
            !isJsonObject(params) ||
            !isJsonObject(params.textDocument) ||
            params.textDocument.uri !== this.#documentUri ||
            !isDocumentVersion(params.textDocument.version) ||
            params.textDocument.version <= this.#documentVersion ||
            !Array.isArray(params.contentChanges) ||
            params.contentChanges.length === 0 ||
            params.contentChanges.length > LSP_MAX_CONTENT_CHANGES
        ) {
            return policyViolation("Invalid didChange notification");
        }

        let nextText = this.#documentText;
        for (const change of params.contentChanges) {
            const applied = applyDocumentChange(nextText, change, this.#maxDocumentBytes);
            if (applied === null) {
                return policyViolation("Invalid or oversized document change");
            }
            nextText = applied;
        }

        this.#documentText = nextText;
        this.#documentVersion = params.textDocument.version;
        return accepted();
    }

    /**
     * main.cだけを閉じ、再open可能な状態へ戻します。
     */
    #validateDidClose(params: unknown): JsonRpcGuardResult {
        if (this.#documentText === null || !hasExactTextDocument(params, this.#documentUri)) {
            return policyViolation("Invalid didClose notification");
        }

        this.#documentText = null;
        this.#documentVersion = null;
        return accepted();
    }

    /**
     * didSaveに全文が含まれる場合も同じ文書上限を適用します。
     */
    #validateDidSave(params: unknown): JsonRpcGuardResult {
        if (this.#documentText === null || !hasExactTextDocument(params, this.#documentUri) || !isJsonObject(params)) {
            return policyViolation("Invalid didSave notification");
        }
        if (params.text === undefined) {
            return accepted();
        }
        if (typeof params.text !== "string" || !isSafeDocumentText(params.text, this.#maxDocumentBytes)) {
            return policyViolation("Invalid didSave document");
        }

        this.#documentText = params.text;
        return accepted();
    }

    /**
     * クライアントのrateと累積受信量を更新します。
     */
    #consumeClientBudget(contentBytes: number): JsonRpcGuardResult {
        const now = this.#now();
        if (now - this.#clientWindowStartedAt >= this.#clientRateWindowMs) {
            this.#clientWindowStartedAt = now;
            this.#clientMessagesInWindow = 0;
        }
        if (this.#clientMessagesInWindow >= this.#clientMaxMessagesPerWindow) {
            return overloadViolation("LSP message rate exceeded");
        }
        if (this.#clientSessionBytes + contentBytes > this.#clientMaxSessionBytes) {
            return sizeViolation("LSP request budget exceeded");
        }

        this.#clientMessagesInWindow += 1;
        this.#clientSessionBytes += contentBytes;
        return accepted();
    }
}

/**
 * initializeがセッションworkspaceだけをルートとしているか検証します。
 */
function isValidInitializeParams(params: unknown, workspaceUri: string): boolean {
    if (!isJsonObject(params)) {
        return false;
    }
    if (params.rootUri !== workspaceUri) {
        return false;
    }
    const workspacePath = fileURLToPath(workspaceUri);
    if (params.rootPath !== undefined && params.rootPath !== null && params.rootPath !== workspacePath) {
        return false;
    }
    if (params.workspaceFolders !== undefined && params.workspaceFolders !== null) {
        if (
            !Array.isArray(params.workspaceFolders) ||
            params.workspaceFolders.length !== 1 ||
            !isJsonObject(params.workspaceFolders[0]) ||
            params.workspaceFolders[0].uri !== workspaceUri
        ) {
            return false;
        }
    }
    if (
        params.initializationOptions !== undefined &&
        params.initializationOptions !== null &&
        (!isJsonObject(params.initializationOptions) || Object.keys(params.initializationOptions).length > 0)
    ) {
        return false;
    }

    return true;
}

/**
 * 設定変更ではclangd設定を注入せず、既定のnullまたは空設定だけを許可します。
 */
function isSafeConfigurationChange(params: unknown): boolean {
    if (!isJsonObject(params)) {
        return false;
    }

    return (
        params.settings === undefined ||
        params.settings === null ||
        (isJsonObject(params.settings) && Object.keys(params.settings).length === 0)
    );
}

/**
 * params内のTextDocumentIdentifierが対象main.cと一致するか判定します。
 */
function hasExactTextDocument(params: unknown, documentUri: string): boolean {
    return isJsonObject(params) && isJsonObject(params.textDocument) && params.textDocument.uri === documentUri;
}

/**
 * JSON文字列を単一のJSON-RPCオブジェクトとして解析します。
 */
function parseJsonObject(content: string): JsonObject | null {
    try {
        const parsed: unknown = JSON.parse(content);
        return isJsonObject(parsed) ? parsed : null;
    } catch {
        return null;
    }
}

/**
 * JSON-RPCレスポンスに必要なidとresult/errorを検証します。
 */
function isJsonRpcResponse(message: JsonObject): boolean {
    const id = message.id;
    const hasValidId = typeof id === "string" || typeof id === "number" || id === null;
    const hasResult = Object.hasOwn(message, "result");
    const hasError = Object.hasOwn(message, "error");
    return hasValidId && hasResult !== hasError;
}

/**
 * JSON値にセッション外URIが含まれていないか反復的に調べます。
 */
function hasUnexpectedUri(value: JsonObject, documentUri: string, workspaceUri: string): boolean {
    const pending: Array<{ depth: number; value: unknown }> = [{ depth: 0, value }];
    let visitedNodes = 0;

    while (pending.length > 0) {
        const entry = pending.pop();
        if (entry === undefined) {
            break;
        }
        visitedNodes += 1;
        if (visitedNodes > MAX_JSON_NODES || entry.depth > MAX_JSON_DEPTH) {
            return true;
        }

        const current = entry.value;
        if (Array.isArray(current)) {
            for (const child of current) {
                pending.push({
                    depth: entry.depth + 1,
                    value: child,
                });
            }
            continue;
        }
        if (!isJsonObject(current)) {
            continue;
        }

        for (const [key, child] of Object.entries(current)) {
            if (
                URI_PROPERTY_NAMES.has(key) &&
                typeof child === "string" &&
                child !== documentUri &&
                child !== workspaceUri
            ) {
                return true;
            }
            if (Array.isArray(child) || isJsonObject(child)) {
                pending.push({
                    depth: entry.depth + 1,
                    value: child,
                });
            }
        }
    }

    return false;
}

/**
 * didChange 1件をUTF-16 position規則で適用します。
 */
function applyDocumentChange(currentText: string, rawChange: unknown, maximumBytes: number): string | null {
    if (!isJsonObject(rawChange) || typeof rawChange.text !== "string" || rawChange.text.includes("\0")) {
        return null;
    }

    let nextText: string;
    if (rawChange.range === undefined) {
        nextText = rawChange.text;
    } else {
        if (!isJsonObject(rawChange.range)) {
            return null;
        }
        const startOffset = positionToOffset(currentText, rawChange.range.start);
        const endOffset = positionToOffset(currentText, rawChange.range.end);
        if (
            startOffset === null ||
            endOffset === null ||
            startOffset > endOffset ||
            (rawChange.rangeLength !== undefined &&
                (!Number.isSafeInteger(rawChange.rangeLength) || (rawChange.rangeLength as number) < 0))
        ) {
            return null;
        }
        nextText = currentText.slice(0, startOffset) + rawChange.text + currentText.slice(endOffset);
    }

    return isSafeDocumentText(nextText, maximumBytes) ? nextText : null;
}

/**
 * LSPのUTF-16 line/character位置をJavaScript文字列offsetへ変換します。
 */
function positionToOffset(text: string, rawPosition: unknown): number | null {
    if (
        !isJsonObject(rawPosition) ||
        !Number.isSafeInteger(rawPosition.line) ||
        !Number.isSafeInteger(rawPosition.character) ||
        (rawPosition.line as number) < 0 ||
        (rawPosition.character as number) < 0
    ) {
        return null;
    }

    const targetLine = rawPosition.line as number;
    const targetCharacter = rawPosition.character as number;
    let lineStart = 0;
    for (let line = 0; line < targetLine; line += 1) {
        const newline = text.indexOf("\n", lineStart);
        if (newline < 0) {
            return null;
        }
        lineStart = newline + 1;
    }

    const newline = text.indexOf("\n", lineStart);
    let lineEnd = newline < 0 ? text.length : newline;
    if (lineEnd > lineStart && text.charCodeAt(lineEnd - 1) === 13) {
        lineEnd -= 1;
    }
    if (targetCharacter > lineEnd - lineStart) {
        return null;
    }

    return lineStart + targetCharacter;
}

/**
 * 文書本文がNULを含まずUTF-8バイト上限内か判定します。
 */
function isSafeDocumentText(text: string, maximumBytes: number): boolean {
    return !text.includes("\0") && Buffer.byteLength(text, "utf8") <= maximumBytes;
}

/**
 * LSP文書versionが非負の安全な整数か判定します。
 */
function isDocumentVersion(value: unknown): value is number {
    return Number.isSafeInteger(value) && (value as number) >= 0;
}

/**
 * nullと配列を除くJSONオブジェクトか判定します。
 */
function isJsonObject(value: unknown): value is JsonObject {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 検証成功を表す共通値を返します。
 */
function accepted(): JsonRpcGuardResult {
    return { accepted: true };
}

/**
 * JSON-RPCポリシー違反を表します。
 */
function policyViolation(reason: string): JsonRpcGuardResult {
    return {
        accepted: false,
        closeCode: 1008,
        reason,
    };
}

/**
 * メッセージまたは累積量の超過を表します。
 */
function sizeViolation(reason: string): JsonRpcGuardResult {
    return {
        accepted: false,
        closeCode: 1009,
        reason,
    };
}

/**
 * 一時的なrateまたは送信待ち超過を表します。
 */
function overloadViolation(reason: string): JsonRpcGuardResult {
    return {
        accepted: false,
        closeCode: 1013,
        reason,
    };
}
