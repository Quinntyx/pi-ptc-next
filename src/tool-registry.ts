import type { ExtensionAPI, ExtensionToolContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
  createBashTool,
  createEditTool,
  createFindTool,
  createGrepTool,
  createLsTool,
  createReadTool,
  createWriteTool,
} from "@earendil-works/pi-coding-agent";
import type { TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { classifyBuiltinTool, validatePythonHelperNames } from "./tools/python-tool-contract";
import type { PtcSettings } from "./contracts/settings";
import type { CallerMetadata, ExecuteToolContext, PtcCaller, PtcToolDefinition, PtcToolOptions, ToolInfo } from "./contracts/tool-types";
import { getExplicitCallers, PTC_TOOL_NAMES as BASE_PTC_TOOL_NAMES } from "./contracts/tool-types";
import { logWarning } from "./utils";

// Kept here as the effective registry denylist so host-only PTC tools cannot be
// exposed recursively inside exec_cell, even before the public contracts grow.
export const PTC_TOOL_NAMES = [...BASE_PTC_TOOL_NAMES, "read_cell_output"] as const;

const PTC_OWNED_TOOLS: ReadonlySet<string> = new Set(PTC_TOOL_NAMES);

/** Whether `name` is one of the PTC-owned tool names (see PTC_TOOL_NAMES). */
function isPtcOwnedTool(name: string): boolean {
  return PTC_OWNED_TOOLS.has(name);
}

/** Read-only classification for a tool: explicit `ptc.readOnly` wins, else the builtin contract, else false. */
function classifyTool(name: string, ptc?: PtcToolOptions): { isReadOnly: boolean } {
  return classifyBuiltinTool(name, ptc);
}

function getConfiguredCallers(tool: ToolInfo): Set<PtcCaller> {
  // An explicit `ptc.callers` array is authoritative — including an empty array,
  // which means no callers at all (see getExplicitCallers in contracts/tool-types).
  const resolved = getExplicitCallers(tool.ptc);
  if (resolved.explicit) {
    return new Set(resolved.callers);
  }

  if (isPtcOwnedTool(tool.name)) {
    return new Set(["direct"]);
  }

  if (tool.source === "builtin" || tool.source === "alias") {
    return new Set(["direct", "code_execution"]);
  }

  if (tool.ptc?.enabled === true) {
    return new Set(["direct", "code_execution"]);
  }

  return new Set(["direct"]);
}

/** Whether the tool may be invoked directly by the model (not just from inside a cell). */
function toolAllowsDirectCaller(tool: ToolInfo): boolean {
  return getConfiguredCallers(tool).has("direct");
}

/** Whether the tool is exposed as a Python helper inside `exec_cell` cells. */
function toolAllowsCodeExecutionCaller(tool: ToolInfo): boolean {
  return getConfiguredCallers(tool).has("code_execution");
}

export interface CallableToolRuntime {
  /** The filtered, validated tool set exposed to cells (mirrors getCallableTools). */
  tools: ToolInfo[];
  /**
   * Execute one bridged tool call from inside a cell. Throws for unknown tool
   * names or schema-invalid params; `nestedCallId` becomes the tool call id.
   */
  runTool(toolName: string, params: unknown, nestedCallId: string): Promise<unknown>;
}

type BuiltinTool =
  | ReturnType<typeof createReadTool>
  | ReturnType<typeof createBashTool>
  | ReturnType<typeof createEditTool>
  | ReturnType<typeof createWriteTool>
  | ReturnType<typeof createGrepTool>
  | ReturnType<typeof createFindTool>
  | ReturnType<typeof createLsTool>;

type BuiltinToolFactory = (cwd: string) => BuiltinTool;

/** Validate `params` against the tool's TypeBox schema; throws with up to three error details. */
function validateToolParams(tool: ToolInfo, params: unknown): void {
  if (Value.Check(tool.parameters as TSchema, params)) {
    return;
  }

  const details = [...Value.Errors(tool.parameters as TSchema, params)]
    .slice(0, 3)
    .map((error) => `${error.path || "/"}: ${error.message}`)
    .join("; ");
  const suffix = details ? ` ${details}` : "";
  throw new Error(`Invalid parameters for ${tool.name}.${suffix}`.trim());
}

/**
 * Unified view over builtin, custom (extension-registered), and host tools.
 *
 * Extension-registered tools shadow host tools with the same name; PTC-owned
 * tools are kept out of the callable set (cells reach them via the RPC bridge
 * instead). No tools are policy-gated (yolo mode): the Python process is
 * unsandboxed, so filtering the model's tools would be futile enforcement.
 */
export class ToolRegistry {
  private customTools = new Map<string, ToolInfo>();
  private extensionOwnedToolNames = new Set<string>();

  constructor(private pi: ExtensionAPI) {}

  /** Register or replace an extension-owned tool; it shadows any host tool with the same name. */
  upsertTool<TParams extends TSchema, TDetails>(tool: ToolDefinition<TParams, TDetails>): void {
    const ptc = (tool as PtcToolDefinition<TParams, TDetails>).ptc;
    const classification = classifyTool(tool.name, ptc);
    this.extensionOwnedToolNames.add(tool.name);
    this.customTools.set(tool.name, {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
      execute: tool.execute,
      // Custom tools are ordinary model-facing tools unless the author says
      // otherwise; the host requires an explicit exposure now.
      exposure: tool.exposure ?? "direct",
      ptc,
      source: "extension",
      isReadOnly: classification.isReadOnly,
    });
  }

  /**
   * Remove a previously upserted custom tool. Returns false when no custom
   * tool with that name existed (builtins and host tools are never removed).
   */
  removeTool(name: string): boolean {
    // Only claim the name as extension-owned when a custom tool was actually
    // removed; otherwise a no-op removeTool("bash") would permanently hide the
    // builtin from buildToolMap (review item L5).
    const removed = this.customTools.delete(name);
    if (removed) {
      this.extensionOwnedToolNames.add(name);
    }
    return removed;
  }

  private createBuiltinTools(cwd: string): Map<string, ToolInfo> {
    const builtins = new Map<string, ToolInfo>();
    const factories: Array<{ name: string; create: BuiltinToolFactory }> = [
      { name: "read", create: createReadTool },
      { name: "bash", create: createBashTool },
      { name: "edit", create: createEditTool },
      { name: "write", create: createWriteTool },
      { name: "grep", create: createGrepTool },
      { name: "find", create: createFindTool },
      { name: "ls", create: createLsTool },
    ];

    for (const { name, create } of factories) {
      try {
        const tool = create(cwd);
        const executeBuiltin = tool.execute as ToolInfo["execute"];
        const classification = classifyTool(tool.name);
        builtins.set(name, {
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
          source: "builtin",
          isReadOnly: classification.isReadOnly,
          exposure: "direct",
          execute: async (toolCallId, params, signal, onUpdate, ctx) =>
            await executeBuiltin(toolCallId, params, signal, onUpdate, ctx),
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logWarning(`Builtin tool '${name}' failed to initialize: ${message}`);
      }
    }

    const findTool = builtins.get("find");
    if (findTool) {
      builtins.set("glob", {
        ...findTool,
        name: "glob",
        description: "Find files by glob pattern. Alias of find(). Returns a list of matching relative paths in exec_cell.",
        source: "alias",
        isReadOnly: true,
      });
    }

    return builtins;
  }

  private buildToolMap(cwd?: string): Map<string, ToolInfo> {
    const allTools = new Map<string, ToolInfo>();
    const builtinTools = this.createBuiltinTools(cwd || process.cwd());

    for (const builtin of builtinTools.values()) {
      allTools.set(builtin.name, builtin);
    }

    for (const customTool of this.customTools.values()) {
      allTools.set(customTool.name, customTool);
    }

    for (const piTool of this.pi.getAllTools()) {
      if (this.extensionOwnedToolNames.has(piTool.name) && !this.customTools.has(piTool.name)) {
        continue;
      }

      const existing = allTools.get(piTool.name);
      if (existing) {
        // Prefer the clean custom-tool schema/params: pi's copy is wrapped by the
        // activity-label integration and gains an `activity` parameter the tool
        // author never declared (review item L4). pi's ToolInfo carries no
        // additional label information, so only fill in a missing description.
        if (!existing.description && piTool.description) {
          allTools.set(piTool.name, { ...existing, description: piTool.description });
        }
        continue;
      }

      const classification = classifyTool(piTool.name);
      allTools.set(piTool.name, {
        name: piTool.name,
        description: piTool.description,
        parameters: piTool.parameters,
        execute: async () => {
          throw new Error(`Tool ${piTool.name} execute function not available`);
        },
        // Preserve whatever the host declared for this tool.
        exposure: piTool.exposure,
        source: "extension",
        isReadOnly: classification.isReadOnly,
      });
    }

    return allTools;
  }

  /** All known tools (builtin + custom + host), custom winning over host on name collisions. */
  getAllTools(cwd?: string): ToolInfo[] {
    return Array.from(this.buildToolMap(cwd).values());
  }

  /**
   * Tools exposed to cells as Python helpers: PTC-owned tools are excluded,
   * and a tool must permit the `code_execution` caller (builtin/alias, or
   * `ptc.enabled` for extension tools). No policy gate exists beyond the
   * PTC_CALLABLE_TOOLS/PTC_BLOCKED_TOOLS lists (yolo mode). Throws on
   * duplicate or reserved Python helper names.
   */
  getCallableTools(cwd: string, settings: PtcSettings): ToolInfo[] {
    const allTools = this.getAllTools(cwd);
    const allowSet = settings.callableTools ? new Set(settings.callableTools) : null;
    const blockedSet = new Set(settings.blockedTools || []);

    const callableTools = allTools.filter((tool) => {
      if (isPtcOwnedTool(tool.name)) {
        return false;
      }
      if (blockedSet.has(tool.name)) {
        return false;
      }
      if (allowSet && !allowSet.has(tool.name)) {
        return false;
      }
      // No tools are policy-gated here: the Python process itself is unsandboxed
      // (yolo mode), so filtering host tools (bash included — os.system and
      // subprocess reach the same places) is futile enforcement. Real
      // isolation arrives with the planned VM-based sandboxing; only the
      // PTC_CALLABLE_TOOLS/PTC_BLOCKED_TOOLS lists apply.
      const isBuiltin = tool.source === "builtin" || tool.source === "alias";
      return toolAllowsCodeExecutionCaller(tool) && (isBuiltin || tool.ptc?.enabled === true);
    });

    validatePythonHelperNames(callableTools);
    return callableTools;
  }

  /** Names of tools the model may still call directly even when auto-routing to code execution. */
  getAutoRoutableToolNames(cwd: string, settings: PtcSettings): string[] {
    const callableNames = new Set(this.getCallableTools(cwd, settings).map((tool) => tool.name));
    return this.getAllTools(cwd)
      .filter((tool) => !isPtcOwnedTool(tool.name))
      .filter((tool) => toolAllowsDirectCaller(tool))
      .filter((tool) => callableNames.has(tool.name))
      .map((tool) => tool.name);
  }

  /**
   * Build the runtime handed to a cell: the callable tool set plus a `runTool`
   * that stamps a `code_execution` caller (with parent/nested call ids) into
   * the extension context before dispatching.
   */
  createCallableToolRuntime(
    cwd: string,
    settings: PtcSettings,
    execution: ExecuteToolContext & { parentToolCallId?: string }
  ): CallableToolRuntime {
    const callableTools = this.getCallableTools(cwd, settings);
    const callableToolMap = new Map(callableTools.map((tool) => [tool.name, tool]));

    return {
      tools: callableTools,
      runTool: async (toolName, params, nestedCallId) => {
        const tool = callableToolMap.get(toolName);
        if (!tool) {
          throw new Error(
            `Unknown callable tool: ${toolName}. Available: ${Array.from(callableToolMap.keys()).join(", ")}`
          );
        }

        validateToolParams(tool, params);

        const toolCallId = nestedCallId || `ptc_${Date.now()}_${Math.random().toString(36).substring(7)}`;
        const ctxWithCaller = Object.assign({}, execution.ctx, {
          caller: {
            type: "code_execution",
            parentToolCallId: execution.parentToolCallId,
            nestedCallId: toolCallId,
          } satisfies CallerMetadata,
        }) as ExtensionToolContext & { caller?: CallerMetadata };

        return await tool.execute(toolCallId, params, execution.signal, undefined, ctxWithCaller);
      },
    };
  }
}
