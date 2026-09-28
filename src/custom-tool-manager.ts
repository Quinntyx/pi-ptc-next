import * as fs from "fs";
import * as path from "path";
import { pathToFileURL } from "node:url";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { TSchema } from "@sinclair/typebox";
import type { LoadedTool, PtcToolDefinition } from "./contracts/tool-types";
import { getExplicitCallers, PTC_TOOL_NAMES } from "./contracts/tool-types";
import { BUILTIN_TOOL_NAMES } from "./tools/python-tool-contract";
import type { ToolRegistry } from "./tool-registry";
import { debugLog, logWarning, withActivityLabel } from "./utils";

/**
 * Names a custom tool may never claim: colliding with a builtin would make the
 * custom tool inherit the builtin's classification and fabricated result types
 * (review item L6), while colliding with a registered PTC tool would shadow
 * the extension's own machinery.
 */
const RESERVED_CUSTOM_TOOL_NAMES: ReadonlySet<string> = new Set([
  ...BUILTIN_TOOL_NAMES,
  ...PTC_TOOL_NAMES,
]);

/** Monotonically increasing counter used to cache-bust custom tool imports. */
let importSequence = 0;

// TypeScript rewrites import() to require() for this CommonJS build. Constructing
// the importer at runtime preserves native ESM loading, including `export default`
// tools, while still allowing Node to interoperate with CommonJS tool files.
const importModule = new Function("specifier", "return import(specifier)") as (
  specifier: string
) => Promise<Record<string, unknown>>;

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

/** Structural check: a valid custom tool file default-exports {name, execute, parameters}. */
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

/**
 * Load one custom tool file (default export wins over a bare module export).
 * The import is cache-busted so repeated calls re-execute the file (hot
 * reload); throws when the module does not export a valid tool definition.
 */
export async function loadCustomToolFile(filePath: string): Promise<LoadedTool> {
  const filename = path.basename(filePath);
  // Cache-bust the import: ESM modules are cached by URL and `require.cache`
  // never covers them, so a plain re-import would re-register stale code and
  // hot reload would silently do nothing for the documented `export default`
  // style (review item H3). The query string gives every load a fresh URL.
  importSequence += 1;
  const resolved = require.resolve(filePath);
  delete require.cache[resolved];
  const moduleUrl = `${pathToFileURL(filePath).href}?t=${Date.now()}_${importSequence}`;
  const mod = await importModule(moduleUrl);
  const definition = mod.default || mod;

  if (!isCustomToolDefinition(definition)) {
    throw new Error(`Invalid tool file ${filename}: missing required fields (name, execute, parameters)`);
  }

  return {
    filename,
    tool: buildRegisteredTool(definition),
  };
}

/**
 * Shared directory scan used by both startup (`CustomToolManager.start`) and
 * the test-only `loadCustomToolsFromDir` (review item C2). Load errors are
 * delegated to `onLoadError` so each caller can apply its own error policy.
 */
async function loadToolsFromDir(
  toolsDir: string,
  onLoadError: (filename: string, error: Error) => void
): Promise<LoadedTool[]> {
  if (!fs.existsSync(toolsDir)) {
    return [];
  }

  const filenames = fs.readdirSync(toolsDir).filter((filename) => filename.endsWith(".js")).sort();
  const loadedTools: LoadedTool[] = [];

  for (const filename of filenames) {
    const filePath = path.join(toolsDir, filename);
    try {
      loadedTools.push(await loadCustomToolFile(filePath));
    } catch (error) {
      onLoadError(filename, error instanceof Error ? error : new Error(String(error)));
    }
  }

  return loadedTools;
}

/**
 * Test-only variant of the directory scan: throws an AggregateError listing
 * every load failure instead of delegating to a callback.
 */
export async function loadCustomToolsFromDir(toolsDir: string): Promise<LoadedTool[]> {
  const errors: Error[] = [];
  const loadedTools = await loadToolsFromDir(toolsDir, (_filename, error) => {
    errors.push(error);
  });

  if (errors.length > 0) {
    throw new AggregateError(errors, `Failed to load ${errors.length} custom tool(s)`);
  }

  return loadedTools;
}

/**
 * Watches `<extensionRoot>/tools/*.js` and keeps its custom tools registered
 * with the host: loading at startup, add/change/delete/rename via an fs.watch
 * listener (300 ms debounce, reconciles serialized per file), and re-watch
 * after watcher errors. Reserved names (builtins, PTC tools) and duplicate
 * tool names are rejected.
 */
export class CustomToolManager {
  private readonly toolsDir: string;
  private readonly fileToTool = new Map<string, string>();
  private readonly toolNameToFile = new Map<string, string>();
  private readonly debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly inFlightReconciles = new Map<string, Promise<void>>();
  private watcher: fs.FSWatcher | null = null;
  private rewatchTimer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;

  constructor(
    extensionRoot: string,
    private pi: ExtensionAPI,
    private toolRegistry: ToolRegistry,
    private onToolSetChanged?: () => void
  ) {
    this.toolsDir = path.join(extensionRoot, "tools");
  }

  /**
   * Load all tools from the tools dir (invalid files are warned and skipped),
   * then start watching. Returns a filename → tool-name map.
   */
  async start(): Promise<Map<string, string>> {
    this.closed = false;
    this.ensureToolsDir();

    const loadedTools = await loadToolsFromDir(this.toolsDir, (filename, error) => {
      logWarning(`Skipping invalid custom tool ${filename} during startup: ${error.message}`);
    });

    for (const loadedTool of loadedTools) {
      try {
        this.registerLoadedTool(loadedTool);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logWarning(`Skipping custom tool ${loadedTool.filename} during startup: ${message}`);
      }
    }

    this.startWatching();
    return new Map(this.fileToTool);
  }

  /** Begin watching the tools dir (idempotent); errors trigger a re-watch after 1 s. */
  startWatching(): void {
    if (this.watcher || this.closed) {
      return;
    }

    this.ensureToolsDir();
    const watcher = fs.watch(this.toolsDir, (_eventType, filename) => {
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
          this.enqueueReconcile(filename);
        }, 300)
      );
    });
    // Without an 'error' listener, deleting/renaming the watched directory
    // throws ERR_UNHANDLED_ERROR and watching silently stops (review item L1).
    watcher.on("error", (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      logWarning(`Custom tools watcher error: ${message}`);
      if (this.watcher === watcher) {
        this.watcher = null;
      }
      watcher.close();
      this.scheduleRewatch();
    });
    this.watcher = watcher;
  }

  private scheduleRewatch(): void {
    if (this.closed || this.rewatchTimer) {
      return;
    }

    this.rewatchTimer = setTimeout(() => {
      this.rewatchTimer = null;
      if (!this.closed) {
        try {
          this.startWatching();
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          logWarning(`Custom tools watcher re-watch failed: ${message}`);
        }
      }
    }, 1000);
  }

  /** Stop watching and cancel all pending timers and in-flight reconciles; irreversible. */
  close(): void {
    this.closed = true;
    this.watcher?.close();
    this.watcher = null;
    if (this.rewatchTimer) {
      clearTimeout(this.rewatchTimer);
      this.rewatchTimer = null;
    }
    for (const timer of this.debounceTimers.values()) {
      clearTimeout(timer);
    }
    this.debounceTimers.clear();
    this.inFlightReconciles.clear();
  }

  private ensureToolsDir(): void {
    if (!fs.existsSync(this.toolsDir)) {
      fs.mkdirSync(this.toolsDir, { recursive: true });
    }
  }

  private setToolActive(toolName: string, tool: PtcToolDefinition): void {
    // An explicit `ptc.callers` array is authoritative — including an empty
    // array, which allows no callers at all (review items L3/C4; see
    // getExplicitCallers in contracts/tool-types).
    const resolved = getExplicitCallers(tool.ptc);
    if (resolved.explicit && !resolved.callers.has("direct")) {
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
    if (this.closed) {
      return;
    }

    const { filename } = loadedTool;
    const tool = loadedTool.tool;

    if (RESERVED_CUSTOM_TOOL_NAMES.has(tool.name)) {
      throw new Error(
        `Custom tool file ${filename} declares '${tool.name}', which collides with a reserved builtin/PTC tool name; rejected`
      );
    }

    const existingFile = this.toolNameToFile.get(tool.name);
    if (existingFile && existingFile !== filename) {
      throw new Error(
        `Custom tool file ${filename} declares '${tool.name}', which is already provided by ${existingFile}; duplicate name rejected`
      );
    }

    const previousToolName = this.fileToTool.get(filename);
    if (previousToolName && previousToolName !== tool.name) {
      this.deactivateTool(previousToolName);
      this.toolNameToFile.delete(previousToolName);
      debugLog(`Removed renamed custom tool ${previousToolName} from ${filename}`);
    }

    this.toolRegistry.upsertTool(tool);
    this.pi.registerTool(withActivityLabel(tool));
    this.setToolActive(tool.name, tool);
    this.fileToTool.set(filename, tool.name);
    this.toolNameToFile.set(tool.name, filename);
    this.onToolSetChanged?.();
    debugLog(`Registered custom tool ${tool.name} from ${filename}`);
  }

  private removeFileTool(filename: string, reason: string): void {
    const toolName = this.fileToTool.get(filename);
    if (!toolName) {
      return;
    }

    this.deactivateTool(toolName);
    this.fileToTool.delete(filename);
    if (this.toolNameToFile.get(toolName) === filename) {
      this.toolNameToFile.delete(toolName);
    }
    this.onToolSetChanged?.();
    debugLog(`Removed custom tool ${toolName}: ${reason}`);
  }

  /**
   * Serializes reconciles per file: overlapping events for the same file are
   * chained so they complete in event order (mtime order), never out of order
   * by completion time (review item L2).
   */
  private enqueueReconcile(filename: string): void {
    const previous = this.inFlightReconciles.get(filename) ?? Promise.resolve();
    const task = previous
      .catch(() => {})
      .then(() => {
        if (this.closed) {
          return;
        }
        return this.runReconcile(filename);
      })
      .finally(() => {
        if (this.inFlightReconciles.get(filename) === task) {
          this.inFlightReconciles.delete(filename);
        }
      });
    this.inFlightReconciles.set(filename, task);
  }

  private async runReconcile(filename: string): Promise<void> {
    if (this.closed) {
      return;
    }

    const filePath = path.join(this.toolsDir, filename);
    if (!fs.existsSync(filePath)) {
      this.removeFileTool(filename, `${filename} deleted`);
      return;
    }

    let loadedTool: LoadedTool;
    try {
      loadedTool = await loadCustomToolFile(filePath);
    } catch (error) {
      if (this.closed) {
        return;
      }
      this.removeFileTool(filename, `${filename} became invalid`);
      const message = error instanceof Error ? error.message : String(error);
      logWarning(`Custom tool reload failed for ${filename}: ${message}`);
      return;
    }

    // The import may have taken a while; drop stale reconciles after shutdown
    // so nothing registers once the session is gone (review item L2).
    if (this.closed) {
      return;
    }

    try {
      this.registerLoadedTool(loadedTool);
    } catch (error) {
      this.removeFileTool(filename, `${filename} became invalid`);
      const message = error instanceof Error ? error.message : String(error);
      logWarning(`Custom tool reload failed for ${filename}: ${message}`);
    }
  }
}
