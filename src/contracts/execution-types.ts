import type { ChildProcess } from "child_process";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { PtcExecutionTelemetry, PtcRecoveryDetails, PtcRecoveryState } from "../recovery-state";
import type { ToolUpdateCallback } from "./tool-types";

export interface SandboxManager {
  spawn(code: string, cwd: string): ChildProcess;
  /** Terminate one execution. Implementations may kill its whole process group. */
  terminate?(proc: ChildProcess, signal: NodeJS.Signals): boolean;
  getRuntimeWorkspaceRoot(cwd: string): string;
  cleanup(): Promise<void>;
}

export interface NormalizedToolResult {
  value: unknown;
  estimatedChars: number;
}

export interface RpcErrorPayload {
  type: string;
  message: string;
  stack?: string;
}

export interface PtcImageArtifact {
  mimeType: string;
  data: string;
  width?: number;
  height?: number;
}

export type RpcMessage =
  | { type: "tool_call"; id: string; tool: string; params: Record<string, unknown> }
  | { type: "tool_result"; id: string; value?: unknown; error?: RpcErrorPayload }
  | { type: "execution_progress"; line: number; total_lines: number }
  | { type: "stdout"; text: string }
  | { type: "complete"; output: string; images?: PtcImageArtifact[]; total_output_chars?: number }
  | { type: "error"; message: string; traceback?: string }
  | { type: "update"; message: string };

interface ExecutionMetrics {
  nestedToolCalls: number;
  nestedToolNames: string[];
  nestedResultChars: number;
  nestedResultCount: number;
  nestedErrors: number;
  durationMs: number;
  estimatedAvoidedTokens: number;
}

export interface ExecutionOptions {
  cwd: string;
  ctx: ExtensionContext;
  signal?: AbortSignal;
  onUpdate?: ToolUpdateCallback;
  parentToolCallId?: string;
  recoveryState?: PtcRecoveryState;
}

export interface ExecutionDetails extends ExecutionMetrics {
  currentLine?: number;
  totalLines?: number;
  userCode?: string[];
  activeTool?: string;
  imagesCount?: number;
  telemetry?: PtcExecutionTelemetry;
  recovery?: PtcRecoveryDetails;
}

export interface CodeExecutionResult {
  output: string;
  images?: PtcImageArtifact[];
  details: ExecutionDetails;
}
