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
  | { type: "update"; message: string }
  // Persistent-session frames (python_exec against a provisioned interpreter).
  | { type: "exec_done"; id: string; output: string; images?: PtcImageArtifact[]; total_output_chars?: number }
  | { type: "exec_error"; id: string; message: string; traceback?: string }
  | { type: "session_ready" }
  | { type: "subagent_state"; snapshot: SubagentRuntimeSnapshot }
  | { type: "script_exported"; id: string; path: string; cells: number; wrapped_async: boolean; error?: string };

export interface SubagentAgentRow {
  id: string;
  name: string;
  group?: string | null;
  status: string;
  startedAt?: number;
  elapsedMs?: number;
  socketPath?: string | null;
  windowId?: string | null;
  toolCalls?: number | null;
  thinkingMs?: number | null;
  phase?: string | null;
  label?: string | null;
  labelElapsedMs?: number | null;
  /** tool calls made under the current activity label (viewer detail line) */
  labelCalls?: number | null;
  /** e.g. `read src/auth_test.py` — the call currently executing */
  liveTool?: string | null;
  /** true while the PTC chunk is awaiting this agent (viewer arrow) */
  awaited?: boolean;
  ctx?: { tokens?: number | null; limit?: number | null; percent?: number | null } | null;
}

export interface SubagentRuntimeSnapshot {
  pid?: number;
  depth?: number;
  agents: SubagentAgentRow[];
  totals?: { running?: number; settled?: number; failed?: number };
  /** phase label -> epoch ms when subagents.phase() was called */
  groups?: Record<string, number>;
  timestamp?: number;
}

export interface ScriptExportResult {
  path: string;
  cells: number;
  wrappedAsync: boolean;
}

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
  sessionId?: string;
  execId?: string;
  subagentSnapshot?: SubagentRuntimeSnapshot;
  backgrounded?: boolean;
}

export interface CodeExecutionResult {
  output: string;
  images?: PtcImageArtifact[];
  details: ExecutionDetails;
}
