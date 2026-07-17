import type {
    CreateExecutionRequest,
    CreateExecutionResponse,
    CreateLspSessionRequest,
    CreateLspSessionResponse,
    CSourceFile as ContractCSourceFile,
    ExecutionClientMessage,
    ExecutionPhase as WireExecutionPhase,
    ExecutionServerMessage,
    ProblemDetails as ContractProblemDetails,
    TerminalSize as ContractTerminalSize,
} from "@smart-c/contracts";

export type LspStatus = "idle" | "connecting" | "connected" | "reconnecting" | "unavailable";

export type CSourceFile = ContractCSourceFile;

export type ExecutionPhase = "idle" | "creating" | "disconnected" | WireExecutionPhase;

export type ProblemDetails = ContractProblemDetails;

export type LspSessionRequest = CreateLspSessionRequest;

export type LspSessionResponse = CreateLspSessionResponse;

export type TerminalSize = ContractTerminalSize;

export type ExecutionRequest = CreateExecutionRequest;

export type ExecutionResponse = CreateExecutionResponse;

export type ExecutionClientEvent = ExecutionClientMessage;

export type ExecutionPhaseEvent = Extract<ExecutionServerMessage, { type: "phase" }>;

export type CompilerOutputEvent = Extract<ExecutionServerMessage, { type: "compiler_output" }>;

export type ExecutionExitEvent = Extract<ExecutionServerMessage, { type: "exit" }>;

export type ExecutionErrorEvent = Extract<ExecutionServerMessage, { type: "error" }>;

export type ExecutionPongEvent = Extract<ExecutionServerMessage, { type: "pong" }>;

export type ExecutionHelloEvent = Extract<ExecutionServerMessage, { type: "hello" }>;

export type ExecutionServerEvent = ExecutionServerMessage;

export interface DiagnosticCounts {
    errors: number;
    warnings: number;
}

export interface PersistedSettings {
    paneRatio: number;
    activeTab: "code" | "io";
}

export interface PersistedProject {
    files: CSourceFile[];
    activeFileName: string;
}
