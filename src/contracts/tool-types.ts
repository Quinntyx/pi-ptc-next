import type {
  AgentToolUpdateCallback,
  ExtensionToolContext,
  ToolDefinition,
  ToolInfo as ExtensionToolInfo,
} from "@earendil-works/pi-coding-agent";
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

export interface ToolInfo extends Omit<ExtensionToolInfo, "sourceInfo"> {
  /**
   * pi >= 0.87 requires sourceInfo on ToolInfo exposed via getAllTools(); our
   * registry synthesizes entries that never passed through pi's loader, so the
   * field is optional here and stamped when bridging back to pi.
   */
  sourceInfo?: ExtensionToolInfo["sourceInfo"];
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
  /**
   * The context pi hands to an extension tool's `execute()`. Since pi 0.99 it
   * is an {@link ExtensionToolContext} (it carries `tools` + `executeTool`),
   * which is exactly what the nested bridge dispatches with.
   */
  ctx: ExtensionToolContext;
  signal?: AbortSignal;
  caller?: CallerMetadata;
}

export type ToolUpdateCallback = AgentToolUpdateCallback<unknown>;
