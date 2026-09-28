import type {
  AgentToolUpdateCallback,
  ExtensionContext,
  ToolDefinition,
  ToolInfo as ExtensionToolInfo,
} from "@mariozechner/pi-coding-agent";
import type { TSchema } from "@sinclair/typebox";

export type PtcCaller = "direct" | "code_execution";

/** Canonical names registered by this extension in registerPtcTools(). */
export const PTC_TOOL_NAMES = [
  "provision_kernel",
  "exec_cell",
  "list_kernels",
  "inspect_kernel",
  "provision_dependency",
] as const;

export interface PtcToolOptions {
  enabled?: boolean;
  readOnly?: boolean;
  pythonName?: string;
  callers?: PtcCaller[];
}

/**
 * Decided semantics for the explicit `ptc.callers` allowlist (review items L3/C4,
 * shared by `CustomToolManager.setToolActive` and `ToolRegistry.getConfiguredCallers`):
 *
 * - An explicit `callers` array is authoritative — including an empty array.
 *   `callers: []` means "no callers allowed": the tool is never directly
 *   activated and never exposed to `code_execution`. It must never be treated
 *   as "unset".
 * - When `callers` is omitted, each consumer applies its own defaults
 *   (see `ToolRegistry.getConfiguredCallers`); the `{ explicit: false }` branch
 *   carries no caller set for that reason.
 */
export type ResolvedCallers =
  | { explicit: true; callers: ReadonlySet<PtcCaller> }
  | { explicit: false };

export function getExplicitCallers(ptc?: PtcToolOptions): ResolvedCallers {
  const configured = ptc?.callers;
  if (Array.isArray(configured)) {
    return { explicit: true, callers: new Set(configured) };
  }
  return { explicit: false };
}

export type PtcToolDefinition<
  TParams extends TSchema = TSchema,
  TDetails = unknown,
> = ToolDefinition<TParams, TDetails> & {
  ptc?: PtcToolOptions;
};

export interface LoadedTool {
  tool: PtcToolDefinition;
  filename: string;
}

export type ToolSource = "builtin" | "alias" | "extension";

export interface ToolInfo extends ExtensionToolInfo {
  execute: ToolDefinition["execute"];
  source: ToolSource;
  isReadOnly: boolean;
  ptc?: PtcToolOptions;
}

export interface CallerMetadata {
  type: "code_execution";
  parentToolCallId?: string;
  nestedCallId: string;
}

export interface ExecuteToolContext {
  ctx: ExtensionContext;
  signal?: AbortSignal;
  caller?: CallerMetadata;
}

export type ToolUpdateCallback = AgentToolUpdateCallback<unknown>;
