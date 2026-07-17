import type {
    ExecutionRequest,
    ExecutionResponse,
    LspSessionRequest,
    LspSessionResponse,
    ProblemDetails,
} from "@/types/wire";

/**
 * Problem Detailsの内容を保持するクライアント向けAPIエラーです。
 */
export class ApiError extends Error {
    readonly status: number;
    readonly retryAfterSeconds?: number;

    constructor(problem: ProblemDetails) {
        super(problem.detail ?? problem.title);
        this.name = "ApiError";
        this.status = problem.status;
        this.retryAfterSeconds = problem.retryAfterSeconds;
    }
}

/**
 * ProxyなどがJSON以外を返した場合も、HTTP状態から利用者向けエラーを復元します。
 */
function createFallbackProblem(response: Response): ProblemDetails {
    const retryAfter = Number(response.headers.get("retry-after"));
    const messages: Partial<Record<number, string>> = {
        413: "C言語ソースは64KiB以内にしてください。",
        429: "操作回数が多すぎます。少し待ってから再試行してください。",
        502: "内部サービスから正しい応答を受け取れませんでした。",
        503: "サービスを一時的に利用できません。",
    };
    const status = response.ok ? 502 : response.status;

    return {
        type: `https://smart-c-playground.invalid/problems/${status}`,
        title: status === 413 ? "リクエストが大きすぎます" : "リクエストに失敗しました",
        status,
        detail: messages[status] ?? `HTTP ${status} エラーが発生しました。`,
        ...(Number.isFinite(retryAfter) && retryAfter > 0
            ? {
                  retryAfterSeconds: retryAfter,
              }
            : {}),
    };
}

/**
 * JSON APIへPOSTし、成功時の型付きレスポンスを返します。
 */
async function postJson<TRequest, TResponse>(path: string, body: TRequest, signal?: AbortSignal): Promise<TResponse> {
    const response = await fetch(path, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        signal,
    });
    const text = await response.text();
    let value: TResponse | ProblemDetails;

    try {
        value = JSON.parse(text) as TResponse | ProblemDetails;
    } catch {
        throw new ApiError(createFallbackProblem(response));
    }

    if (!response.ok) {
        throw new ApiError(value as ProblemDetails);
    }

    return value as TResponse;
}

/**
 * 現在のソースからclangdのLSPセッションを作成します。
 */
export function createLspSession(request: LspSessionRequest): Promise<LspSessionResponse> {
    return postJson<LspSessionRequest, LspSessionResponse>("/api/lsp/sessions", request);
}

/**
 * C言語のコンパイル・実行セッションを作成します。
 */
export function createExecution(request: ExecutionRequest, signal?: AbortSignal): Promise<ExecutionResponse> {
    return postJson<ExecutionRequest, ExecutionResponse>("/api/executions", request, signal);
}
