/**
 * Public type surface for the PTC extension. Every name is a re-export of the
 * canonical definition in ./contracts/*, so consumers can import all types
 * from this single module.
 */
import type {
  CallerMetadata as InternalCallerMetadata,
  ExecuteToolContext as InternalExecuteToolContext,
  LoadedTool as InternalLoadedTool,
  PtcCaller as InternalPtcCaller,
  PtcToolDefinition as InternalPtcToolDefinition,
  PtcToolOptions as InternalPtcToolOptions,
  ToolInfo as InternalToolInfo,
  ToolSource as InternalToolSource,
} from "./contracts/tool-types";
import type {
  CodeExecutionResult as InternalCodeExecutionResult,
  ExecutionDetails as InternalExecutionDetails,
  ExecutionOptions as InternalExecutionOptions,
  NormalizedToolResult as InternalNormalizedToolResult,
  PythonSessionManagerHooks as InternalPythonSessionManagerHooks,
  RpcErrorPayload as InternalRpcErrorPayload,
  RpcMessage as InternalRpcMessage,
  SandboxManager as InternalSandboxManager,
  ScriptExportResult as InternalScriptExportResult,
  SessionExecOptions as InternalSessionExecOptions,
  SessionSummary as InternalSessionSummary,
} from "./contracts/execution-types";
import type { PtcSettings as InternalPtcSettings } from "./contracts/settings";

// Tool bridge types (callers, contexts, definitions, registry metadata).
export type CallerMetadata = InternalCallerMetadata;
export type ExecuteToolContext = InternalExecuteToolContext;
export type LoadedTool = InternalLoadedTool;
export type PtcCaller = InternalPtcCaller;
export type PtcToolDefinition = InternalPtcToolDefinition;
export type PtcToolOptions = InternalPtcToolOptions;
export type ToolInfo = InternalToolInfo;
export type ToolSource = InternalToolSource;

// Execution/session types (results, options, protocol payloads, manager contracts).
export type CodeExecutionResult = InternalCodeExecutionResult;
export type ExecutionDetails = InternalExecutionDetails;
export type ExecutionOptions = InternalExecutionOptions;
export type NormalizedToolResult = InternalNormalizedToolResult;
export type PythonSessionManagerHooks = InternalPythonSessionManagerHooks;
export type RpcErrorPayload = InternalRpcErrorPayload;
export type RpcMessage = InternalRpcMessage;
export type SandboxManager = InternalSandboxManager;
export type ScriptExportResult = InternalScriptExportResult;
export type SessionExecOptions = InternalSessionExecOptions;
export type SessionSummary = InternalSessionSummary;

// User-tunable settings shape (populated from PTC_* env vars).
export type PtcSettings = InternalPtcSettings;
