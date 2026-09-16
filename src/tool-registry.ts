import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@mariozechner/pi-coding-agent";
import {
  createBashTool,
  createEditTool,
  createFindTool,
  createGrepTool,
  createLsTool,
  createReadTool,
  createWriteTool,
} from "@mariozechner/pi-coding-agent";
import type { TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { classifyBuiltinTool, validatePythonHelperNames } from "./tools/python-tool-contract";
import type { PtcSettings } from "./contracts/settings";
import type { CallerMetadata, ExecuteToolContext, PtcToolDefinition, PtcToolOptions, ToolInfo } from "./contracts/tool-types";
import { logWarning } from "./utils";

const PTC_OWNED_TOOLS = new Set(["provision_python_session", "python_exec", "python_session_to_script"]);

function isPtcOwnedTool(name: string): boolean {
  return PTC_OWNED_TOOLS.has(name);
}

function classifyTool(name: string, ptc?: PtcToolOptions): { isReadOnly: boolean } {
  return classifyBuiltinTool(name, ptc);
}

function getConfiguredCallers(tool: ToolInfo): Set<"direct" | "code_execution"> {
  const configured = tool.ptc?.callers;
  if (configured && configured.length > 0) {
    return new Set(configured);
  }

  if (tool.name === "code_execution" || isPtcOwnedTool(tool.name)) {
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

function toolAllowsDirectCaller(tool: ToolInfo): boolean {
  return getConfiguredCallers(tool).has("direct");
}

function toolAllowsCodeExecutionCaller(tool: ToolInfo): boolean {
  return getConfiguredCallers(tool).has("code_execution");
}

export interface CallableToolRuntime {
  tools: ToolInfo[];
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

export class ToolRegistry {
  private customTools = new Map<string, ToolInfo>();
  private extensionOwnedToolNames = new Set<string>();

  constructor(private pi: ExtensionAPI) {}

  upsertTool<TParams extends TSchema, TDetails>(tool: ToolDefinition<TParams, TDetails>): void {
    const ptc = (tool as PtcToolDefinition<TParams, TDetails>).ptc;
    const classification = classifyTool(tool.name, ptc);
    this.extensionOwnedToolNames.add(tool.name);
    this.customTools.set(tool.name, {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
      execute: tool.execute,
      ptc,
      source: "extension",
      isReadOnly: classification.isReadOnly,
    });
  }

  removeTool(name: string): boolean {
    this.extensionOwnedToolNames.add(name);
    return this.customTools.delete(name);
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
        description: "Find files by glob pattern. Alias of find(). Returns a list of matching relative paths in python_exec.",
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
        allTools.set(piTool.name, {
          ...existing,
          description: piTool.description,
          parameters: piTool.parameters,
        });
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
        source: "extension",
        isReadOnly: classification.isReadOnly,
      });
    }

    return allTools;
  }

  getAllTools(cwd?: string): ToolInfo[] {
    return Array.from(this.buildToolMap(cwd).values());
  }

  getCallableTools(cwd: string, settings: PtcSettings): ToolInfo[] {
    const allTools = this.getAllTools(cwd);
    const allowSet = settings.callableTools ? new Set(settings.callableTools) : null;
    const blockedSet = new Set(settings.blockedTools || []);
    const trustedReadOnlyTools = new Set(settings.trustedReadOnlyTools || []);

    const callableTools = allTools.filter((tool) => {
      if (tool.name === "code_execution" || isPtcOwnedTool(tool.name)) {
        return false;
      }
      if (blockedSet.has(tool.name)) {
        return false;
      }
      if (allowSet && !allowSet.has(tool.name)) {
        return false;
      }
      if (tool.name === "bash" && !settings.allowBash) {
        return false;
      }

      const isBuiltin = tool.source === "builtin" || tool.source === "alias";
      const isTrustedReadOnlyCustom =
        !isBuiltin &&
        tool.ptc?.enabled === true &&
        tool.ptc?.readOnly === true &&
        trustedReadOnlyTools.has(tool.name);

      if (!settings.allowMutations) {
        if (!isBuiltin && !isTrustedReadOnlyCustom) {
          return false;
        }
        if (!tool.isReadOnly && !isTrustedReadOnlyCustom) {
          return false;
        }
      }

      return toolAllowsCodeExecutionCaller(tool) && (isBuiltin || tool.ptc?.enabled === true);
    });

    validatePythonHelperNames(callableTools);
    return callableTools;
  }

  getAutoRoutableToolNames(cwd: string, settings: PtcSettings): string[] {
    const callableNames = new Set(this.getCallableTools(cwd, settings).map((tool) => tool.name));
    return this.getAllTools(cwd)
      .filter((tool) => tool.name !== "code_execution" && !isPtcOwnedTool(tool.name))
      .filter((tool) => toolAllowsDirectCaller(tool))
      .filter((tool) => callableNames.has(tool.name))
      .map((tool) => tool.name);
  }

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
        }) as ExtensionContext & { caller?: CallerMetadata };

        return await tool.execute(toolCallId, params, execution.signal, undefined, ctxWithCaller);
      },
    };
  }
}
