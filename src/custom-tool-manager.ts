import * as fs from "fs";
import * as path from "path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { TSchema } from "@sinclair/typebox";
import type { LoadedTool, PtcToolDefinition } from "./contracts/tool-types";
import type { ToolRegistry } from "./tool-registry";
import { debugLog, logWarning, withActivityLabel } from "./utils";

function buildRegisteredTool(definition: PtcToolDefinition): PtcToolDefinition {
  return {
    name: definition.name,
    label: definition.label || definition.name,
    description: definition.description || definition.name,
    parameters: definition.parameters,
    execute: definition.execute,
    ptc: definition.ptc,
  };
}

function hasSchemaShape(value: unknown): value is TSchema {
  return typeof value === "object" && value !== null;
}

function isCustomToolDefinition(value: unknown): value is PtcToolDefinition {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }

  const candidate = value as Partial<PtcToolDefinition>;
  return (
    typeof candidate.name === "string" &&
    typeof candidate.execute === "function" &&
    hasSchemaShape(candidate.parameters)
  );
}

export async function loadCustomToolFile(filePath: string): Promise<LoadedTool> {
  const filename = path.basename(filePath);
  const resolved = require.resolve(filePath);
  delete require.cache[resolved];
  const mod = await import(filePath);
  const definition = mod.default || mod;

  if (!isCustomToolDefinition(definition)) {
    throw new Error(`Invalid tool file ${filename}: missing required fields (name, execute, parameters)`);
  }

  return {
    filename,
    tool: buildRegisteredTool(definition),
  };
}

export async function loadCustomToolsFromDir(toolsDir: string): Promise<LoadedTool[]> {
  if (!fs.existsSync(toolsDir)) {
    return [];
  }

  const filenames = fs.readdirSync(toolsDir).filter((filename) => filename.endsWith(".js"));
  const loadedTools: LoadedTool[] = [];
  const errors: Error[] = [];

  for (const filename of filenames) {
    const filePath = path.join(toolsDir, filename);
    try {
      loadedTools.push(await loadCustomToolFile(filePath));
    } catch (error) {
      errors.push(error instanceof Error ? error : new Error(String(error)));
    }
  }

  if (errors.length > 0) {
    throw new AggregateError(errors, `Failed to load ${errors.length} custom tool(s)`);
  }

  return loadedTools;
}

export class CustomToolManager {
  private readonly toolsDir: string;
  private readonly fileToTool = new Map<string, string>();
  private readonly debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private watcher: fs.FSWatcher | null = null;

  constructor(
    extensionRoot: string,
    private pi: ExtensionAPI,
    private toolRegistry: ToolRegistry,
    private onToolSetChanged?: () => void
  ) {
    this.toolsDir = path.join(extensionRoot, "tools");
  }

  seed(initialFileMap: Map<string, string>): void {
    for (const [filename, toolName] of initialFileMap.entries()) {
      this.fileToTool.set(filename, toolName);
    }
  }

  async start(): Promise<Map<string, string>> {
    this.ensureToolsDir();

    for (const filename of fs.readdirSync(this.toolsDir).filter((entry) => entry.endsWith(".js"))) {
      const filePath = path.join(this.toolsDir, filename);
      try {
        this.registerLoadedTool(await loadCustomToolFile(filePath));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logWarning(`Skipping invalid custom tool ${filename} during startup: ${message}`);
      }
    }

    this.startWatching();
    return new Map(this.fileToTool);
  }

  startWatching(): void {
    if (this.watcher) {
      return;
    }

    this.ensureToolsDir();
    this.watcher = fs.watch(this.toolsDir, (_eventType, filename) => {
      if (!filename || !filename.endsWith(".js")) {
        return;
      }

      const existing = this.debounceTimers.get(filename);
      if (existing) {
        clearTimeout(existing);
      }

      this.debounceTimers.set(
        filename,
        setTimeout(() => {
          this.debounceTimers.delete(filename);
          void this.reconcileFile(filename);
        }, 300)
      );
    });
  }

  close(): void {
    this.watcher?.close();
    this.watcher = null;
    for (const timer of this.debounceTimers.values()) {
      clearTimeout(timer);
    }
    this.debounceTimers.clear();
  }

  private ensureToolsDir(): void {
    if (!fs.existsSync(this.toolsDir)) {
      fs.mkdirSync(this.toolsDir, { recursive: true });
    }
  }

  private setToolActive(toolName: string, tool: PtcToolDefinition): void {
    if (Array.isArray(tool.ptc?.callers) && !tool.ptc.callers.includes("direct")) {
      return;
    }

    const activeTools = this.pi.getActiveTools();
    if (!activeTools.includes(toolName)) {
      this.pi.setActiveTools([...activeTools, toolName]);
    }
  }

  private deactivateTool(toolName: string): void {
    this.toolRegistry.removeTool(toolName);
    const activeTools = this.pi.getActiveTools();
    this.pi.setActiveTools(activeTools.filter((name) => name !== toolName));
  }

  private registerLoadedTool(loadedTool: LoadedTool): void {
    const previousToolName = this.fileToTool.get(loadedTool.filename);
    if (previousToolName && previousToolName !== loadedTool.tool.name) {
      this.deactivateTool(previousToolName);
      debugLog(`Removed renamed custom tool ${previousToolName} from ${loadedTool.filename}`);
    }

    this.toolRegistry.upsertTool(loadedTool.tool);
    this.pi.registerTool(withActivityLabel(loadedTool.tool));
    this.setToolActive(loadedTool.tool.name, loadedTool.tool);
    this.fileToTool.set(loadedTool.filename, loadedTool.tool.name);
    this.onToolSetChanged?.();
    debugLog(`Registered custom tool ${loadedTool.tool.name} from ${loadedTool.filename}`);
  }

  private removeFileTool(filename: string, reason: string): void {
    const toolName = this.fileToTool.get(filename);
    if (!toolName) {
      return;
    }

    this.deactivateTool(toolName);
    this.fileToTool.delete(filename);
    this.onToolSetChanged?.();
    debugLog(`Removed custom tool ${toolName}: ${reason}`);
  }

  private async reconcileFile(filename: string): Promise<void> {
    const filePath = path.join(this.toolsDir, filename);
    if (!fs.existsSync(filePath)) {
      this.removeFileTool(filename, `${filename} deleted`);
      return;
    }

    try {
      const loadedTool = await loadCustomToolFile(filePath);
      this.registerLoadedTool(loadedTool);
    } catch (error) {
      this.removeFileTool(filename, `${filename} became invalid`);
      const message = error instanceof Error ? error.message : String(error);
      logWarning(`Custom tool reload failed for ${filename}: ${message}`);
    }
  }
}
