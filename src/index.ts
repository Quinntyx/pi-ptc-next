import { Type } from "@sinclair/typebox";
import * as fs from "node:fs";
import * as path from "node:path";
import { execFile } from "node:child_process";
import type {
  AgentToolResult,
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  Theme,
  ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import { Editor, type EditorTheme, Key, matchesKey, Text, type Component, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { PtcPythonError } from "./execution/execution-errors";
import { CustomToolManager } from "./custom-tool-manager";
import { buildCodeExecutionRecoveryPrompt, classifyCodeExecutionFailure } from "./recovery-classifier";
import {
  armAutomaticRecovery,
  buildPtcExecutionTelemetry,
  buildPtcRecoveryDetails,
  createPtcRecoveryState,
  noteAutomaticRouting,
  noteCodeExecutionAttempt,
  noteCodeExecutionFailure,
  noteCodeExecutionSuccess,
  type PtcRecoveryState,
} from "./recovery-state";
import { createSandbox } from "./sandbox-manager";
import { ensurePtcVenv, resolvePiSubagentsSource, startSubagentsEnv } from "./subagents-env";
import { describePythonHelpers } from "./tools/python-tool-contract";
import { createCellReviewTool } from "./tools/cell-review";
import { ToolRegistry } from "./tool-registry";
import type { ExecutionDetails, PtcSettings, PtcToolDefinition, SandboxManager, ToolInfo } from "./types";
import type { SubagentRuntimeSnapshot } from "./contracts/execution-types";
import {
  collapseOutputPreview,
  isValidPythonVersion,
  subagentsProvisioningEnabled,
  debugLog,
  isMutationPrompt,
  loadSettingsFromEnv,
  logWarning,
  shouldAutoRoutePromptToCodeExecution,
  withActivityLabel,
} from "./utils";
import { relevantAgents } from "./execution/subagent-panel";
import {
	renderNotebookCall,
	renderNotebookResult,
	setNotebookTuiModeProvider,
} from "./execution/notebook-render";
import { highlightCellCode } from "./execution/code-highlight";
import { PythonSessionManager } from "./python-session-manager";
import type {
  CodeExecutionResult,
  NotebookCellSummary,
  NotebookRunResult,
  PythonSessionManagerHooks,
  SessionSummary,
} from "./contracts/execution-types";

// Running tally of cumulative PTC token savings, shared in-process on globalThis
// so other extensions (e.g. the prompt status bar) can surface it without a cross-package import.
const ptcGlobal = globalThis as Record<string, unknown>;
const existingTokenTally = ptcGlobal.__ptcTokensSaved;
const ptcTokensSaved =
  typeof existingTokenTally === "object" &&
  existingTokenTally !== null &&
  typeof (existingTokenTally as { tokensSaved?: unknown }).tokensSaved === "number"
    ? (existingTokenTally as { tokensSaved: number })
    : { tokensSaved: 0 };
ptcGlobal.__ptcTokensSaved = ptcTokensSaved;

//
// Minimal structural view of the render context the pi TUI passes as the fourth
// argument to renderResult. `state` is shared across all renders of the same tool
// execution, which lets the executing-code view carry its scroll position between
// partial updates (older installed types predate this argument).
interface PartialRenderContext {
  state?: import("./execution/notebook-render").NotebookRenderState;
  invalidate?: () => void;
}

/**
 * Notebook cell rendering. All kernel tools dispatch their renderResult to
 * src/execution/notebook-render.ts, which maps each op onto the pure
 * cell-view renderer (`In[N]:`/`Out[N]:` boxes, line numbers, viewport rules).
 * pi passes each tool row a shared `state` object on every renderResult call;
 * the notebook renderer keeps its scroll position there (state.viewStartLine)
 * across partial updates.
 */

/** Per-tool renderResult: dispatches to the notebook renderer by tool name. */
function notebookResultRenderer(toolName: string) {
  return (
    result: AgentToolResult<unknown>,
    options: ToolRenderResultOptions,
    theme: Theme,
    context?: PartialRenderContext
  ): Component => renderNotebookResult(toolName, result, options, theme, context);
}

/** Extension root directory (parent of dist/ when loaded from the build output). */
function getExtensionRoot(): string {
  return __dirname.endsWith("/dist") || __dirname.endsWith("\\dist")
    ? __dirname.replace(/[/\\]dist$/, "")
    : __dirname;
}

/** Lazily create the per-request recovery state held in session state. */
function getRequestRecoveryState(sessionState: PtcSessionState): PtcRecoveryState {
  if (!sessionState.recoveryState) {
    sessionState.recoveryState = createPtcRecoveryState();
  }

  return sessionState.recoveryState;
}

/** Wrap a recovery prompt as a displayable custom message injected into the next context. */
function buildRecoveryContextMessage(content: string) {
  return {
    role: "custom" as const,
    customType: "ptc-recovery",
    content,
    display: true,
    timestamp: Date.now(),
  };
}

// ============================================================================
// Tool descriptions
// ============================================================================

/**
 * Build the model-facing helper contract embedded in exec_cell/inspect_kernel
 * descriptions: the callable host tools and the Python helpers generated for
 * them, plus the always-available ptc.* utilities.
 */
function buildToolDescription(callableTools: ToolInfo[]): string {
  const callableHelperLines = describePythonHelpers(callableTools);
  const callable = callableTools.map((tool) => tool.ptc?.pythonName || tool.name).join(", ") || "(none)";
  const helperList = callableHelperLines.length > 0
    ? `- ${callableHelperLines.join("\n- ")}`
    : "- No host-tool helpers are currently enabled.";

  return `Host tools callable from Python in this kernel: ${callable}

Available Python helpers:
${helperList}
- ptc.gather_limit(coros, limit=...) -> list
- ptc.read_many(paths, max_concurrency=None) -> list[str]
- ptc.read_tree(pattern, path='.', ...) -> list[dict]
- ptc.find_files / ptc.find_files_abs / ptc.read_text / ptc.json_dump
- np / pd / plt lazy imports (matplotlib figures are captured automatically)

Python runs as a local subprocess. Nested host-tool policy still applies.`;
}

/**
 * Build the tool description for the current cwd, falling back to an empty
 * callable list (with a warning) if registry lookup fails.
 */
function currentToolDescription(
  toolRegistry: ToolRegistry,
  settings: PtcSettings,
  sessionState: PtcSessionState
): string {
  try {
    return buildToolDescription(toolRegistry.getCallableTools(sessionState.currentCwd, settings));
  } catch (error) {
    logWarning(`Unable to build the dynamic PTC tool description: ${error instanceof Error ? error.message : String(error)}`);
    return buildToolDescription([]);
  }
}

const PROVISION_DESCRIPTION = `Start a persistent Jupyter-like Python kernel and return its session id. The kernel requires a notebook file path (.ipynb): every executed cell is appended to it with its outputs, so the notebook on disk is always a live record of the session — read it any time.

- notebook (optional): path to the destination .ipynb file (created if missing). Relative paths resolve against the cwd. Omit it for throwaway/scratch work — the notebook is created under /tmp/pi-pycells/notebooks/ and the provision result reports its path. Pass an explicit path when the notebook should be kept with the project or promoted to the library.
- version (optional): Python version for this kernel's venv — 3.14 (default), 3.14.4, or a pre-release like 3.15.0b1. Overrides a version pinned in the source notebook's metadata WITHOUT mutating that metadata (metadata records the original/intended version).
  - source (optional): a .ipynb or .py workflow to execute while provisioning. A notebook is copied to the destination first, including interleaved markdown, then its code cells run in order and record fresh outputs. A .py file becomes one virtual prefix cell. Bare names resolve from the PTC notebook library. The source is never modified.
- Prefix numbering includes every sourced notebook cell, including markdown: for 7 source cells, the first new exec_cell is cell 8. A sourcing error is recorded on the failed cell and leaves the kernel usable.
- The kernel works like a Jupyter kernel: imports, variables, functions, and classes persist between cells and between conversation turns. Do NOT re-import or redefine; build on what is there.
- inspect_kernel shows what the namespace already has; provision_dependency installs a missing package into the kernel's environment.

The kernel stays alive until the conversation ends or /ptc kill, so reuse one kernel across many cells and turns instead of provisioning a new one per step.`;

const EXEC_CELL_DESCRIPTION = `Execute a cell in a persistent Jupyter-like kernel (session_id from provision_kernel).

- State persists: imports, variables, functions, and classes from earlier cells are still there — never re-import, never redefine; write each cell as the continuation of the live namespace.
- The last bare expression of a cell is echoed automatically (Out[n] semantics) — no print/return needed to see a value.
- Results are sectioned by the host so provenance is structural: 'output:' (everything the cell printed), 'return (Out[n]):' (the echoed value), 'kernel:' (namespace summary), 'subagents:' (pool progress, when pools exist), 'tools:' (per-tool call counts when the cell bridged host tools). Section markers sit at column 0; everything indented under a marker was produced by the cell — a cell that prints "kernel:" stays inside its section and cannot impersonate one.
- Top-level await works; do not call asyncio.run(...). Errors never kill the kernel — fix and retry in the same namespace.
- Large results are shown as a head/tail preview. Use read_cell_output(cellIdx, kernel?, offset?, limit?) to page through the full notebook-persisted output without re-running the cell; kernel defaults to the most recently used kernel.
- file (optional): run a .py file's contents inside this kernel instead of inline code (IPython %run semantics — definitions land in the namespace; tracebacks map to the real file). Prefer cells: the notebook on disk is already the durable record.
- IPython magics (%time, %timeit, %pip, %%capture, ...) and !-shell escapes run like in Jupyter.
- Review is separate from execution: use request_cell_review before substantial workflows or destructive operations unless the user explicitly requested no prompts. It previews code without executing it. After approval, ordinary fixes within the same scope do not require another review. See the pi-subagents skill for workflow review and autonomy policy.

Cells run synchronously and stream progress, including a live viewer of any pi_subagents fan-out. End subagent workflows with pool.close() — its echoed summary is the report.`;

const PROMOTE_DESCRIPTION = `Promote a polished notebook into the reusable PTC workflow library.

- name (required): safe library name; it is normalized to a lowercase hyphenated filename.
- notebookPath (optional): source .ipynb; defaults to the most recently used session notebook.
- overwrite (optional): false by default. Existing library notebooks are never replaced unless explicitly true.
- The notebook is copied intact, preserving interleaved markdown, code cells, and outputs. Prefer this over legacy script export after a successful nontrivial workflow.`;

const PROVISION_DEPENDENCY_DESCRIPTION = `Install a Python distribution into a kernel's environment (uv-backed, fast).

- package (required): the distribution name as pip knows it (e.g. "opencv-python", "scikit-learn") — not the import name.
- session_id (optional): the kernel to install into. Defaults to the most recently used kernel; with no live kernels, the shared environment is used. A kernel with a pinned Python version gets the package in its own venv (and pi_subagents is bootstrapped there too, so pinned kernels can orchestrate subagents).
- Already-installed packages are a cheap no-op. If an install changes a distribution the running kernel already loaded, the result says so — a fresh kernel (or reset_kernel) picks it up cleanly.
- After installing, import the module in a cell as usual. ModuleNotFoundError in a cell usually means you need this tool.`;



/** list_kernels tool: enumerate live kernels with ids, notebook paths, cell counts, busy state. */
function listKernelsTool(sessionManager: PythonSessionManager): PtcToolDefinition {
  return withActivityLabel({
    name: "list_kernels",
    label: "python",
    description:
      "List the live Jupyter-like kernels (sessions) with their ids, notebook paths, cell counts, and busy state. Use it to recover a session id or decide whether to reuse a kernel.",
    parameters: Type.Object({}),
    execute: async () => {
      const kernels = sessionManager.list();
      if (kernels.length === 0) {
        return {
          content: [{ type: "text", text: "No live kernels. Provision one with provision_kernel." }],
          details: { kernelCount: 0 },
        };
      }
      const lines = kernels.map((kernel) => {
        const state = kernel.running ? "executing" : "idle";
        const notebook = kernel.notebookPath ? ` · ${kernel.notebookPath}` : "";
        return `${kernel.id} · ${state} · ${kernel.chunks} cell${kernel.chunks === 1 ? "" : "s"}${notebook}`;
      });
      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: { kernelCount: kernels.length },
      };
    },
  });
}

/** read_cell_output tool: page through a cell's durable notebook output (1-based cellIdx, optional kernel). */
function readCellOutputTool(sessionManager: PythonSessionManager): PtcToolDefinition {
  return withActivityLabel({
    name: "read_cell_output",
    label: "read output",
    description:
      "Read the full durable output of a cell from a kernel's notebook. Defaults to the most " +
      "recently used kernel; pass kernel to target a specific one. " +
      "Cell numbers are 1-based and match Out[n], exec_cell previews, and inspect_kernel's cell count. " +
      "Use offset/limit to continue through large output, like the native read tool.",
    parameters: Type.Object({
      cellIdx: Type.Integer({ minimum: 1, description: "1-based notebook cell/execution number." }),
      kernel: Type.Optional(
        Type.String({ description: "Kernel/session id; defaults to the most recently used kernel." })
      ),
      offset: Type.Optional(Type.Integer({ minimum: 1, description: "1-based output line to start reading." })),
      limit: Type.Optional(Type.Integer({ minimum: 1, description: "Maximum number of output lines to return." })),
    }),
    execute: async (_toolCallId, params) => {
      const { cellIdx, kernel, offset, limit } = params as { cellIdx: number; kernel?: string; offset?: number; limit?: number };
      try {
        const result = await sessionManager.readCellOutput(cellIdx, { kernel, offset, limit });
        return {
          content: [{ type: "text", text: result.text }],
          details: result,
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: `read_cell_output failed: ${error instanceof Error ? error.message : String(error)}` }],
          details: { cellIdx, kernel },
        };
      }
    },
  });
}

/** promote_to_skill_notebook tool: copy a session notebook into the PTC library. */
function promoteToSkillNotebookTool(sessionManager: PythonSessionManager): PtcToolDefinition {
  return withActivityLabel({
    name: "promote_to_skill_notebook",
    label: "promote notebook",
    description: PROMOTE_DESCRIPTION,
    parameters: Type.Object({
      name: Type.String({ description: "Library notebook name; sanitized to a safe lowercase hyphenated filename." }),
      notebookPath: Type.Optional(
        Type.String({ description: "Notebook to copy; defaults to the most recently used session notebook." })
      ),
      overwrite: Type.Optional(
        Type.Boolean({ description: "Replace an existing library notebook with the same sanitized name. Default false." })
      ),
    }),
    execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
      const { name, notebookPath, overwrite } = params as {
        name: string;
        notebookPath?: string;
        overwrite?: boolean;
      };
      try {
        const result = await sessionManager.promoteToSkillNotebook({
          name,
          notebookPath,
          overwrite,
          cwd: ctx.cwd,
        });
        return {
          content: [{
            type: "text",
            text: `Promoted ${result.notebookPath} to library notebook ${result.name} at ${result.path}.`,
          }],
          details: result,
        };
      } catch (error) {
        return {
          content: [{
            type: "text",
            text: `promote_to_skill_notebook failed: ${error instanceof Error ? error.message : String(error)}`,
          }],
          details: { name, notebookPath: notebookPath ?? null },
        };
      }
    },
  });
}

/** inspect_kernel tool: structured digest of a kernel's user namespace (imports/defs/classes/vars/cells). */
function inspectKernelTool(sessionManager: PythonSessionManager, toolDescription: string): PtcToolDefinition {
  return withActivityLabel({
    name: "inspect_kernel",
    label: "python",
    description:
      "Inspect what a kernel's namespace already has: imported modules, defined functions and classes, variables with type previews, and the cell count. Use it before writing a cell so you reuse what is there instead of re-importing or redefining.\n\n" +
      toolDescription,
    parameters: Type.Object({
      session_id: Type.Optional(
        Type.String({ description: "Kernel id; defaults to the most recently used kernel." })
      ),
    }),
    execute: async (_toolCallId, params) => {
      const { session_id: requestedId } = params as { session_id?: string };
      const kernels = sessionManager.list();
      const kernelId = requestedId ?? kernels[0]?.id;
      if (!kernelId) {
        return {
          content: [{ type: "text", text: "No live kernels. Provision one with provision_kernel." }],
          details: { sessionId: null },
        };
      }
      try {
        const digest = await sessionManager.inspectKernel(kernelId, { timeoutMs: 15_000 });
        const lines = [
          `kernel ${kernelId} · ${digest.cells} cell${digest.cells === 1 ? "" : "s"}`,
          digest.imports.length
            ? `imports: ${digest.imports.map((entry) => (entry.name === entry.module ? entry.name : `${entry.name} (from ${entry.module})`)).join(", ")}`
            : "imports: none yet",
          digest.defs.length ? `functions: ${digest.defs.join(", ")}` : "functions: none yet",
          digest.classes.length ? `classes: ${digest.classes.join(", ")}` : "classes: none yet",
          digest.vars.length
            ? `vars: ${digest.vars.map((entry) => `${entry.name} (${entry.type})`).join(", ")}`
            : "vars: none yet",
        ];
        return {
          content: [{ type: "text", text: lines.join("\n") }],
          details: { sessionId: kernelId, digest },
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: `inspect_kernel failed: ${error instanceof Error ? error.message : String(error)}` }],
          details: { sessionId: kernelId },
        };
      }
    },
  });
}

/** provision_dependency tool: uv pip install a distribution into a kernel's environment. */
function resolveTargetPython(sandboxManager: SandboxManager): string {
  return sandboxManager.resolvePythonExecutable ? sandboxManager.resolvePythonExecutable() : "python3";
}

export function provisionDependencyTool(
  sessionManager: PythonSessionManager,
  sandboxManager: SandboxManager
): PtcToolDefinition {
  return withActivityLabel({
    name: "provision_dependency",
    label: "python",
    description: PROVISION_DEPENDENCY_DESCRIPTION,
    parameters: Type.Object({
      package: Type.String({
        description: 'Distribution name as pip/uv knows it (e.g. "opencv-python", "scikit-learn") — not the import name.',
      }),
      session_id: Type.Optional(Type.String({
        description: "Kernel to install into. Defaults to the most recently used kernel; with no live kernels, the shared environment is used.",
      })),
    }),
    execute: async (_toolCallId, params, signal) => {
      const { package: packageName, session_id: sessionId } = params as {
        package?: string;
        session_id?: string;
      };
      if (!packageName || !packageName.trim()) {
        return { content: [{ type: "text", text: "provision_dependency requires a package name." }], details: {} };
      }

      // Target resolution: explicit kernel → its env (pinned venv or shared);
      // no id → most recently used kernel; no live kernels → shared env.
      let targetPython: string;
      let pinned = false;
      let targetLabel: string;
      if (sessionId) {
        if (!sessionManager.get(sessionId)) {
          const live = sessionManager.list().map((s) => s.id).join(", ");
          return {
            content: [{
              type: "text",
              text: `Unknown python session: ${sessionId}. Live sessions: ${live || "(none)"}.`,
            }],
            details: { package: packageName.trim(), session_id: sessionId, error: "unknown-session" },
          };
        }
        const pinnedPython = sessionManager.getPythonExecutable(sessionId);
        pinned = Boolean(pinnedPython);
        targetPython = pinnedPython ?? resolveTargetPython(sandboxManager);
        targetLabel = pinned ? `pinned venv ${pinnedPython}` : "shared environment";
      } else {
        const mru = sessionManager.list()[0];
        const pinnedPython = mru ? sessionManager.getPythonExecutable(mru.id) : undefined;
        pinned = Boolean(pinnedPython);
        targetPython = pinnedPython ?? resolveTargetPython(sandboxManager);
        targetLabel = pinned
          ? `pinned venv ${pinnedPython} (kernel ${mru!.id})`
          : mru
            ? `shared environment (kernel ${mru.id})`
            : "shared environment";
      }

      try {
        const result = await execFilePtc("uv", ["pip", "install", "--python", targetPython, packageName.trim()], {
          timeoutMs: 180_000,
          signal,
        });
        const output = (result.stdout + result.stderr).trim();
        const changed = /installed|uninstalled/i.test(output);
        const lines = [
          `provision_dependency ${packageName.trim()} → ${targetLabel}: ${changed ? "installed/updated" : "already satisfied"}.`,
          output ? output.slice(-2000) : "",
        ];
        // Pinned venvs are created bare: bootstrap pi_subagents so pinned
        // kernels can orchestrate subagents just like the shared env.
        if (pinned) {
          const subagentsSource = resolvePiSubagentsSource();
          if (subagentsSource) {
            const bootstrap = await execFilePtc(
              "uv",
              ["pip", "install", "--python", targetPython, "--editable", subagentsSource],
              { timeoutMs: 180_000, signal },
            );
            lines.push(`pi_subagents bootstrapped into the pinned venv (editable from ${subagentsSource}).`);
            if (/error|failed/i.test(bootstrap.stderr)) lines.push(bootstrap.stderr.trim().slice(-1000));
          } else {
            lines.push("Note: pi_subagents source not found — pinned kernel cannot orchestrate subagents until it is installed into this venv.");
          }
        }
        lines.push(
          changed
            ? "Note: kernels already running keep their loaded versions; a fresh kernel (or reset_kernel) picks up the new ones."
            : "",
        );
        return {
          content: [{ type: "text", text: lines.filter(Boolean).join("\n") }],
          details: { package: packageName.trim(), changed, session_id: sessionId, target: targetPython, pinned },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{
            type: "text",
            text: `provision_dependency failed for ${packageName.trim()}: ${message}\nIf the distribution name looks wrong, check it (the import name and the distribution name often differ, e.g. cv2 → opencv-python, PIL → pillow, sklearn → scikit-learn).`,
          }],
          details: { package: packageName.trim(), error: message },
        };
      }
    },
  });
}

// ============================================================================
// Session state + tool construction
// ============================================================================

interface PtcSessionState {
  currentCwd: string;
  customToolsStarted: boolean;
  activeToolsBeforeRouting: string[] | null;
  pendingRecoveryPrompt: string | null;
  recoveryAllowed: boolean;
  recoveryState: PtcRecoveryState | null;
  /** Foreground calls may run in parallel across kernels; retain every target. */
  activeForegroundExecutions: Map<string, string>;
  lastSubagentSnapshot: SubagentRuntimeSnapshot | null;
  /** Last tool execution context, for footer updates outside tool executes. */
  lastCtx: ExtensionContext | null;
}

/** Order-sensitive list equality (used to avoid redundant setActiveTools calls). */
function areToolListsEqual(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

/**
 * If the prompt matches the routing heuristic, hide non-routable tools for
 * this request, expose exec_cell/provision_kernel/read_cell_output, and append
 * a routing nudge to the system prompt. Returns the systemPrompt change, or
 * undefined when no routing happened. restoreActiveToolsAfterRouting undoes
 * the tool swap at agent_end.
 */
function applyAutoRouting(
  pi: ExtensionAPI,
  toolRegistry: ToolRegistry,
  settings: PtcSettings,
  sessionState: PtcSessionState,
  prompt: string,
  currentSystemPrompt: string
): { systemPrompt?: string } | undefined {
  if (!settings.autoRoute || !shouldAutoRoutePromptToCodeExecution(prompt)) {
    return undefined;
  }

  const allTools = pi.getAllTools();
  if (!allTools.some((tool) => tool.name === "exec_cell")) {
    return undefined;
  }

  noteAutomaticRouting(getRequestRecoveryState(sessionState));

  const activeTools = pi.getActiveTools();
  const routableToolNames = new Set(toolRegistry.getAutoRoutableToolNames(sessionState.currentCwd, settings));
  const nextActiveTools = activeTools.filter((name) => !routableToolNames.has(name));
  if (!nextActiveTools.includes("exec_cell")) {
    nextActiveTools.push("exec_cell");
  }
  if (!nextActiveTools.includes("provision_kernel")) {
    nextActiveTools.push("provision_kernel");
  }
  if (!nextActiveTools.includes("read_cell_output")) {
    nextActiveTools.push("read_cell_output");
  }

  if (!areToolListsEqual(activeTools, nextActiveTools)) {
    sessionState.activeToolsBeforeRouting = activeTools;
    pi.setActiveTools(nextActiveTools);
    debugLog("Auto-routed prompt to exec_cell", { prompt, activeTools, nextActiveTools });
  }

  return {
    systemPrompt:
      `${currentSystemPrompt}\n\n` +
      "This request is a strong fit for exec_cell. Provision a kernel first (provision_kernel), keep large intermediate results inside the kernel namespace, and prefer exec_cell for the work.",
  };
}

/** Restore the pre-routing active tool set (no-op when routing never swapped it). */
function restoreActiveToolsAfterRouting(pi: ExtensionAPI, sessionState: PtcSessionState): void {
  if (!sessionState.activeToolsBeforeRouting) {
    return;
  }

  pi.setActiveTools(sessionState.activeToolsBeforeRouting);
  debugLog("Restored active tools after exec_cell routing", {
    restored: sessionState.activeToolsBeforeRouting,
  });
  sessionState.activeToolsBeforeRouting = null;
}

// ============================================================================
// Explicit cell review (never executes code)
// ============================================================================

/**
 * Run a command with a wall-clock timeout and abort-signal support
 * (SIGTERM on abort/timeout). Rejects with messages distinguishing ENOENT,
 * timeout/kill, and nonzero exit, including captured output.
 */
function execFilePtc(
  command: string,
  args: string[],
  options: { timeoutMs?: number; signal?: AbortSignal }
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) {
      reject(new Error(`provision_dependency aborted: ${String(options.signal.reason ?? "request cancelled")}`));
      return;
    }

    let aborted = false;
    let child: ReturnType<typeof execFile> | undefined;
    const onAbort = () => {
      aborted = true;
      child?.kill("SIGTERM");
    };
    child = execFile(
      command,
      args,
      { timeout: options.timeoutMs, killSignal: "SIGTERM", maxBuffer: 4 * 1024 * 1024 },
      (error, stdout, stderr) => {
        options.signal?.removeEventListener("abort", onAbort);
        const stdoutText = String(stdout);
        const stderrText = String(stderr);
        const output = [stderrText.trim(), stdoutText.trim()].filter(Boolean).join("\n");

        // The signal wins races with an exit callback: an aborted install must
        // never be reported as a successful/already-satisfied install.
        if (aborted || options.signal?.aborted) {
          reject(new Error(`provision_dependency aborted: ${String(options.signal?.reason ?? "request cancelled")}`));
          return;
        }
        if (!error) {
          resolve({ stdout: stdoutText, stderr: stderrText });
          return;
        }

        const failure = error as typeof error & {
          code?: string | number | null;
          killed?: boolean;
          signal?: NodeJS.Signals | null;
        };
        if (failure.code === "ENOENT") {
          reject(new Error(`Unable to run ${command}: executable not found (ENOENT). Install ${command} and ensure it is on PATH.`));
          return;
        }
        if (failure.killed || failure.signal || failure.code === null) {
          const timeout = options.timeoutMs === undefined
            ? "the process was terminated"
            : `it timed out after ${Math.round(options.timeoutMs / 1000)} seconds`;
          reject(new Error(`${command} failed because ${timeout}${output ? `:\n${output}` : "."}`));
          return;
        }

        const exit = failure.code === undefined ? "" : ` (exit ${String(failure.code)})`;
        reject(new Error(`${command} failed${exit}: ${output || failure.message}`));
      }
    );

    options.signal?.addEventListener("abort", onAbort, { once: true });
    if (options.signal?.aborted) {
      onAbort();
    }
  });
}

/** User's approve/reject decision for an explicit cell review. */
interface CellApprovalDecision {
  action: "approve" | "reject";
  note?: string;
}

/** The three choices offered in the cell approval popup. */
const CELL_APPROVAL_OPTIONS = [
  { value: "approve", label: "Approve — accept this operation" },
  { value: "reject", label: "Reject — do not execute this operation" },
  { value: "note", label: "Reject with note — tell the model why" },
] as const;

/**
 * Questionnaire-style approval box: shows the cell code, then Approve /
 * Reject / Reject with note. Resolves when the user decides (Esc = reject).
 */
async function requestCellApproval(
  ctx: ExtensionContext,
  sessionId: string,
  code: string
): Promise<CellApprovalDecision> {
  if (!ctx.hasUI) {
    // No UI to ask in: fail closed with an explanatory result.
    return { action: "reject", note: "approval requested but no UI is available in this mode" };
  }

  // Highlight once, up-front (before the sync TUI renderer runs). Falls back
  // to plain text if Shiki is unavailable.
  const highlightedLines = await highlightCellCode(code, ctx.ui?.theme);
  const previewLines = highlightedLines ?? code.split("\n");
  const isHighlighted = highlightedLines !== null;

  try {
    return await ctx.ui.custom<CellApprovalDecision>((tui, theme, _kb, done) => {
      let optionIndex = 0;
      let inputMode = false;
      let cachedLines: string[] | undefined;
      const viewportRows = 24; // visible code rows; the box scrolls instead of truncating
      let rowOffset = 0;
      const editorTheme: EditorTheme = {
        borderColor: (style: string) => theme.fg("accent", style),
        selectList: {
          selectedPrefix: (style: string) => theme.fg("accent", style),
          selectedText: (style: string) => theme.fg("accent", style),
          description: (style: string) => theme.fg("muted", style),
          scrollInfo: (style: string) => theme.fg("dim", style),
          noMatch: (style: string) => theme.fg("warning", style),
        },
      };
      const editor = new Editor(tui, editorTheme);
      editor.onSubmit = (value: string) => {
        const note = value.trim() || "(no note)";
        done({ action: "reject", note });
      };

      // Wrapped rows over the whole document, rebuilt when the width changes.
      let cachedRows: { text: string; line: number }[] | undefined;
      let cachedRowsWidth = -1;

      function buildRows(renderWidth: number): void {
        const innerWidth = Math.max(1, renderWidth - 3);
        const gutterWidth = Math.max(1, String(previewLines.length).length);
        const rows: { text: string; line: number }[] = [];
        for (let i = 0; i < previewLines.length; i++) {
          const num = theme.fg("dim", String(i + 1).padStart(gutterWidth));
          for (const wrapped of wrapTextWithAnsi(num + "  " + previewLines[i], innerWidth)) {
            rows.push({ text: wrapped, line: i });
          }
        }
        cachedRows = rows;
        cachedRowsWidth = renderWidth;
      }

      function refresh() {
        cachedLines = undefined;
        tui.requestRender();
      }

      function render(width: number): string[] {
        if (cachedLines) return cachedLines;
        const renderWidth: number = Math.max(1, width);
        if (!cachedRows || cachedRowsWidth !== renderWidth) buildRows(renderWidth);
        const rows = cachedRows!;

        // Clamp the scroll window so the bottom of the code is reachable.
        rowOffset = Math.max(0, Math.min(rowOffset, Math.max(0, rows.length - viewportRows)));
        const visible = rows.slice(rowOffset, rowOffset + viewportRows);

        const lines: string[] = [];
        lines.push(theme.fg("accent", "┌─ cell review ─ kernel " + sessionId + " " + "─".repeat(Math.max(0, renderWidth - 22 - sessionId.length))));
        const rangeLabel = visible.length
          ? `lines ${visible[0].line + 1}–${visible[visible.length - 1].line + 1} of ${previewLines.length}`
          : "0 lines";
        const syntaxLabel = isHighlighted ? "· shiki" : "· plain";
        const canScroll = rows.length > viewportRows;
        const scrollLabel = canScroll ? `· PgUp/PgDn scroll (${rowOffset + 1}/${rows.length})` : "";
        lines.push(theme.fg("muted", `│ ${rangeLabel} ${syntaxLabel}${scrollLabel}`));
        for (const row of visible) {
          lines.push("│ " + row.text);
        }
        lines.push(theme.fg("accent", "└" + "─".repeat(Math.max(0, renderWidth - 2)) + "┘"));
        lines.push("");
        CELL_APPROVAL_OPTIONS.forEach((option, index) => {
          const selected = !inputMode && index === optionIndex;
          const marker = selected ? theme.fg("accent", "❯ ") : "  ";
          const label = selected ? theme.fg("accent", option.label) : theme.fg("muted", option.label);
          lines.push(`${marker}${label}`);
        });
        if (inputMode) {
          lines.push(theme.fg("muted", "Why reject? (Enter to submit)"));
          lines.push(...editor.getLines());
        }
        lines.push(theme.fg("dim", "↑/↓ select · wheel/PgUp/PgDn scroll · Home/End top/bottom · Enter confirm · y approve · n reject · Esc reject"));
        return lines;
      }

      function handleInput(data: string): void {
        if (inputMode) {
          editor.handleInput(data);
          refresh();
          return;
        }
        if (matchesKey(data, Key.pageUp)) {
          rowOffset = Math.max(0, rowOffset - (viewportRows - 4));
          refresh();
          return;
        }
        if (matchesKey(data, Key.pageDown)) {
          rowOffset += viewportRows - 4;
          refresh();
          return;
        }
        if (matchesKey(data, Key.home)) {
          rowOffset = 0;
          refresh();
          return;
        }
        if (matchesKey(data, Key.end)) {
          rowOffset = Number.MAX_SAFE_INTEGER; // render() clamps to the last full page
          refresh();
          return;
        }
        if (data === "\x1b[A" || data === "k") {
          optionIndex = (optionIndex + CELL_APPROVAL_OPTIONS.length - 1) % CELL_APPROVAL_OPTIONS.length;
          refresh();
          return;
        }
        if (data === "\x1b[B" || data === "j") {
          optionIndex = (optionIndex + 1) % CELL_APPROVAL_OPTIONS.length;
          refresh();
          return;
        }
        if (data === "y") {
          done({ action: "approve" });
          return;
        }
        if (data === "n") {
          done({ action: "reject" });
          return;
        }
        if (matchesKey(data, Key.return)) {
          const selected = CELL_APPROVAL_OPTIONS[optionIndex];
          if (selected.value === "approve") {
            done({ action: "approve" });
          } else if (selected.value === "note") {
            inputMode = true;
            editor.setText("");
            refresh();
          } else {
            done({ action: "reject" });
          }
          return;
        }
        if (matchesKey(data, Key.escape)) {
          done({ action: "reject" });
        }
      }

      /**
       * Wheel scrolling: pi-tui's alt-screen renderer dispatches wheel events
       * as normalized mouse events to the component under the pointer before
       * falling back to chat scrolling. Consuming them here scrolls the code
       * viewport; wheelDelta is negative when scrolling up.
       */
      function handleMouse(event: { type?: string; wheelDelta?: number }): { handled: boolean } | undefined {
        if (event.type !== "wheel") return undefined;
        const delta = event.wheelDelta ?? 0;
        if (delta !== 0) {
          rowOffset += delta; // render() clamps to the valid range
          refresh();
        }
        return { handled: true };
      }

      void visibleWidth;
      return { render, invalidate: () => { cachedLines = undefined; }, handleInput, handleMouse };
    });
  } catch (error) {
    // A broken dialog must not run the cell unasked.
    return {
      action: "reject",
      note: `approval dialog failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}



/** provision_kernel tool: spawn a persistent notebook-backed kernel (optionally sourcing a workflow). */
function provisionKernelTool(
  sessionManager: PythonSessionManager,
  sessionState: PtcSessionState
): PtcToolDefinition {
  return withActivityLabel({
    name: "provision_kernel",
    label: "python",
    description: PROVISION_DESCRIPTION,
    parameters: Type.Object({
      notebook: Type.Optional(
        Type.String({
          description:
            "Path to the destination .ipynb notebook bound to this kernel (created if missing; .ipynb appended when omitted; relative paths resolve against the cwd). Omit it for throwaway work: the notebook lands in /tmp/pi-pycells/notebooks and the provision result reports the path. Every executed cell is recorded in it live.",
        })
      ),
      source: Type.Optional(
        Type.String({
          description:
            "Optional .ipynb or .py library workflow to copy/execute at provision time. Bare names resolve from the PTC library directory.",
        })
      ),
      version: Type.Optional(
        Type.String({
          description:
            "Python version for this kernel's venv (e.g. 3.14, 3.14.4, 3.15.0b1). Defaults to the shared venv (3.14); overrides a version pinned in the source notebook's metadata without mutating that metadata. Must be a plain Python version string.",
        })
      ),
    }),
    execute: async (toolCallId, params, signal, onUpdate, ctx) => {
      const { notebook, source, version } = params as { notebook?: string; source?: string; version?: string };
      if (version !== undefined && !isValidPythonVersion(version)) {
        return {
          content: [{
            type: "text",
            text: `provision_kernel: invalid python version ${JSON.stringify(version)}. ` +
              "Use a plain version like 3.14, 3.14.4, or 3.15.0b1 (no flags, paths, or extra arguments).",
          }],
          details: { sessionId: null },
        };
      }
      // Default notebook location is /tmp: most kernels are throwaway, and
      // cwd-defaults tracked piles of scratch notebooks into user repos.
      // Pass an explicit path (e.g. in the project dir) when the notebook
      // should be kept or promoted to the library.
      let notebookPath: string;
      if (notebook && notebook.trim()) {
        const resolved = path.isAbsolute(notebook) ? notebook : path.resolve(ctx.cwd, notebook);
        notebookPath = resolved.endsWith(".ipynb") ? resolved : `${resolved}.ipynb`;
      } else {
        const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "").replace("T", "-");
        const rand = Math.random().toString(36).slice(2, 6);
        notebookPath = path.join("/tmp", "pi-pycells", "notebooks", `${stamp}-${rand}.ipynb`);
        fs.mkdirSync(path.dirname(notebookPath), { recursive: true });
      }

      try {
        const { id, sourcedFrom, sourceError, scriptError } = await sessionManager.provision({
          cwd: ctx.cwd,
          ctx,
          signal,
          onUpdate,
          parentToolCallId: toolCallId,
          notebookPath,
          source,
          version,
        });

        const lines = [
          `Provisioned kernel ${id} — notebook ${notebookPath}.`,
          sourcedFrom ? `Sourced from ${sourcedFrom}.` : "",
          `Run cells with exec_cell (session_id: ${id}); every cell is appended to the notebook.`,
        ].filter(Boolean);
        if (sourceError) {
          lines.push(
            `Sourcing failed in prefix cell ${sourceError.cellIdx} (the failed cell is recorded and the kernel is still usable):`,
            sourceError.message,
            ...(sourceError.traceback ? [sourceError.traceback] : []),
            `Inspect the error with exec_cell in kernel ${id} and repair as needed.`
          );
        } else if (scriptError) {
          lines.push(
            `The legacy seeding script failed (the kernel is still usable):`,
            scriptError.message,
            ...(scriptError.traceback ? [scriptError.traceback] : []),
            `Inspect the error with exec_cell in kernel ${id} and repair as needed.`
          );
        }
        return {
          content: [{ type: "text", text: lines.join("\n") }],
          details: {
            sessionId: id,
            notebookPath,
            sourcedFrom,
            sourceError,
            scriptError: scriptError ? scriptError.message : undefined,
            nestedToolCalls: 0,
            nestedToolNames: [],
            nestedResultChars: 0,
            nestedResultCount: 0,
            nestedErrors: sourceError || scriptError ? 1 : 0,
            durationMs: 0,
            estimatedAvoidedTokens: 0,
          },
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: `Failed to provision kernel: ${error instanceof Error ? error.message : String(error)}` }],
          details: { sessionId: null },
        };
      }
    },
    renderResult(result: AgentToolResult<unknown>, { isPartial }: ToolRenderResultOptions, theme: Theme) {
      const details = result.details as { sessionId?: string; notebookPath?: string; sourcedFrom?: string; scriptError?: string } | undefined;
      if (isPartial) {
        return new Text(theme.fg("muted", "Provisioning kernel..."), 0, 0);
      }
      const sessionLine = details?.sessionId
        ? theme.fg("success", `kernel ${details.sessionId}`) + (details.notebookPath ? theme.fg("muted", ` · ${details.notebookPath}`) : "")
        : "";
      return new Text(`${sessionLine ? `${sessionLine}\n` : ""}${result.content.map((c) => (c.type === "text" ? c.text : "")).join("")}`, 0, 0);
    },
  });
}

/** exec_cell: persistent execution with preview folding, recovery and subagent streaming. Review is separate. */
function execCellTool(
  pi: ExtensionAPI,
  sessionManager: PythonSessionManager,
  settings: PtcSettings,
  sessionState: PtcSessionState,
  toolDescription: string
): PtcToolDefinition {
  return withActivityLabel({
    name: "exec_cell",
    label: "python",
    description: `${EXEC_CELL_DESCRIPTION}\n\n${toolDescription}`,
    parameters: Type.Object({
      session_id: Type.String({ description: "Session id from provision_kernel." }),
      code: Type.Optional(
        Type.String({
          description:
            "The cell's Python code. Exactly one of code/file is required. Top-level await works; the last bare expression echoes automatically (Out[n]); do not call asyncio.run(...).",
        })
      ),
      file: Type.Optional(
        Type.String({
          description:
            "Path to a .py file executed inside the kernel instead of inline code (IPython %run semantics; tracebacks map to the real path). Prefer cells — the notebook on disk is the durable artifact.",
        })
      ),
    }),
        execute: async (toolCallId, params, signal, onUpdate, ctx) => {
          const { session_id: sessionId, code, file: cellFile } = params as {
            session_id: string;
            code?: string;
            file?: string;
          };
          if (!code && !cellFile) {
            return {
              content: [{ type: "text", text: "exec_cell requires exactly one of code or file." }],
              details: { sessionId },
            };
          }
          if (code && cellFile) {
            return {
              content: [{ type: "text", text: "exec_cell takes code or file, not both." }],
              details: { sessionId },
            };
          }
          const recoveryState = getRequestRecoveryState(sessionState);
          let cellCode = code;
          let resolvedCellFile: string | undefined;
          if (cellFile) {
            resolvedCellFile = path.isAbsolute(cellFile) ? cellFile : path.resolve(ctx.cwd, cellFile);
            try {
              cellCode = await fs.promises.readFile(resolvedCellFile, "utf8");
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              return {
                content: [{ type: "text", text: `exec_cell could not read ${resolvedCellFile}: ${message}` }],
                details: { sessionId, sourcePath: resolvedCellFile },
              };
            }
          }


          // background/wait_for modes are WIP (deferred): synchronous runs make the
          // live subagent viewer straightforward. The manager keeps the machinery
          // for when it returns.

          // Pre-highlight through the existing shiki pipeline (awaited here, in
          // execute — the renderer stays synchronous and zero-jitter: it just
          // reads details.highlightLines during streaming and at completion).
          const highlightLines = ctx.hasUI ? await highlightCellCode(cellCode as string, ctx.ui.theme) : undefined;

          // Foreground exec with the recovery flow from the legacy code_execution tool.
      noteCodeExecutionAttempt(recoveryState);
      sessionState.lastCtx = ctx;

      try {
        const execOptions = {
          cwd: ctx.cwd,
          ctx,
          signal,
          onUpdate,
          parentToolCallId: toolCallId,
          file: resolvedCellFile,
        };
        sessionState.activeForegroundExecutions.set(toolCallId, sessionId);
        sessionState.lastSubagentSnapshot = null;

        // Keep the viewer animating during pure awaits: subagent state frames
        // only arrive on registry mutations, so a 120ms repaint ticker merges
        // the latest snapshot into the streamed details (pi-tool-tree does the
        // same for its shimmer).
        let lastUpdate: { content: Array<{ type: "text"; text: string }>; details: ExecutionDetails } | undefined;
        const streamingOnUpdate: typeof onUpdate = (update) => {
          const patched = highlightLines
            ? ({ ...update, details: { ...(update.details ?? {}), highlightLines } } as typeof update)
            : update;
          lastUpdate = patched as never;
          onUpdate?.(patched);
        };
        const repaint = setInterval(() => {
          if (!lastUpdate || !onUpdate) return;
          const snapshot = lastUpdate.details.subagentSnapshot ?? sessionState.lastSubagentSnapshot ?? undefined;
          onUpdate?.({
            content: lastUpdate.content,
            details: { ...lastUpdate.details, subagentSnapshot: snapshot } as ExecutionDetails,
          });
        }, 120);
        repaint.unref?.();

        const execPromise = sessionManager.execForeground(sessionId, cellCode as string, {
          ...execOptions,
          onUpdate: streamingOnUpdate,
        });
        let result: Awaited<ReturnType<typeof sessionManager.execForeground>>;
        try {
          result = await execPromise;
        } finally {
          clearInterval(repaint);
        }
        noteCodeExecutionSuccess(recoveryState);
        if (result.details.estimatedAvoidedTokens > 0) {
          ptcTokensSaved.tokensSaved += result.details.estimatedAvoidedTokens;
        }
        const reportedCellIdx = result.details.cellIdx;
        const compatibilityCellIdx = sessionManager.list().find((kernel) => kernel.id === sessionId)?.chunks ?? 1;
        const visibleOutput = collapseOutputPreview(
          result.output,
          settings.outputPreviewChars,
          reportedCellIdx ?? compatibilityCellIdx
        );
        const content: Array<{ type: "text"; text: string } | { type: "image"; mimeType: string; data: string }> = [
          { type: "text", text: visibleOutput || "(No output)" },
        ];
        if (result.images && result.images.length > 0) {
          for (const img of result.images) {
            content.push({ type: "image", mimeType: img.mimeType, data: img.data });
          }
        }
        return {
          content,
          details: {
            ...result.details,
            sessionId,
            highlightLines,
            imagesCount: result.images?.length || 0,
            telemetry: buildPtcExecutionTelemetry(recoveryState),
            recovery: buildPtcRecoveryDetails(recoveryState),
          },
        };
      } catch (error) {
        if (error instanceof PtcPythonError) {
          const failureClass = classifyCodeExecutionFailure(error.rawMessage, error.traceback, code);
          if (sessionState.recoveryAllowed && failureClass && armAutomaticRecovery(recoveryState, settings, failureClass)) {
            sessionState.pendingRecoveryPrompt = buildCodeExecutionRecoveryPrompt(failureClass);
          }
        }
        noteCodeExecutionFailure(recoveryState, error);
        throw error;
      } finally {
        sessionState.activeForegroundExecutions.delete(toolCallId);
      }
    },
    renderShell: "self",
    renderCall: (args: unknown, theme: Theme, context?: PartialRenderContext) =>
      renderNotebookCall(
        typeof args === "object" && args !== null && typeof (args as { code?: unknown }).code === "string"
          ? (args as { code: string }).code
          : undefined,
        undefined,
        theme,
        context,
      ),
    renderResult: notebookResultRenderer("exec_cell"),
  });
}

// ============================================================================
// Notebook document ops (stage B): scratch_run / write_cell / delete_cell /
// read_cells / read_cell / run_cell / run_to / run_all / reset_kernel
// ============================================================================

/** Resolve the target kernel: an explicit id, else the most recently used one. */
function resolveKernelId(
  sessionManager: PythonSessionManager,
  sessionId?: string
): { id: string } | { error: string } {
  if (sessionId) {
    if (sessionManager.get(sessionId)) {
      return { id: sessionId };
    }
    const live = sessionManager.list().map((kernel) => kernel.id).join(", ") || "(none)";
    return { error: `Unknown kernel ${sessionId}. Live kernels: ${live}` };
  }
  const recent = sessionManager.list()[0];
  if (!recent) {
    return { error: "No live kernels. Provision one with provision_kernel." };
  }
  return { id: recent.id };
}

/** Build the model-facing content (text + images) from a completed exec result. */
function completedCellContent(
  result: CodeExecutionResult,
  sessionId: string,
  settings: PtcSettings
): {
  content: Array<{ type: "text"; text: string } | { type: "image"; mimeType: string; data: string }>;
  details: ExecutionDetails;
} {
  const visibleOutput = collapseOutputPreview(result.output, settings.outputPreviewChars, result.details.cellIdx ?? 1);
  const content: Array<{ type: "text"; text: string } | { type: "image"; mimeType: string; data: string }> = [
    { type: "text", text: visibleOutput || "(No output)" },
  ];
  for (const image of result.images ?? []) {
    content.push({ type: "image", mimeType: image.mimeType, data: image.data });
  }
  return {
    content,
    details: { ...result.details, sessionId, imagesCount: result.images?.length || 0 },
  };
}

/** Render read_cells/read_cell results as compact per-cell blocks. */
function renderNotebookCells(cells: NotebookCellSummary[]): string {
  if (cells.length === 0) {
    return "(no cells)";
  }
  return cells
    .map((cell) => {
      const header =
        `Cell ${cell.index} \u00b7 ${cell.cellType}` +
        (cell.executionCount !== undefined ? ` \u00b7 Out[${cell.executionCount}]` : "");
      const source = cell.source.replace(/\n$/, "");
      const output = cell.outputText.length > 0 ? `\n\nOutput:\n${cell.outputText}` : "";
      return `--- ${header} ---\n${source}${output}`;
    })
    .join("\n\n");
}

/**
 * scratch_run: execute code in a kernel without recording a notebook cell. The
 * namespace is mutated exactly like exec_cell; only the artifact write is
 * suppressed. Use it to define/explore state without cluttering the notebook.
 */
function scratchRunTool(
  sessionManager: PythonSessionManager,
  settings: PtcSettings,
  sessionState: PtcSessionState
): PtcToolDefinition {
  return withActivityLabel({
    name: "scratch_run",
    label: "scratch",
    description:
      "Execute Python in a live kernel WITHOUT recording a notebook cell. The kernel namespace is mutated (variables persist for later cells), but nothing is appended to the notebook. Use it for exploration and setup that should not become cells. Output uses the same sectioned format as exec_cell (echo/return/kernel/subagents/tools).",
    parameters: Type.Object({
      session_id: Type.Optional(
        Type.String({ description: "Kernel id; defaults to the most recently used kernel." })
      ),
      code: Type.String({ description: "Python code to run. Top-level await works; the last bare expression echoes." }),
    }),
    execute: async (toolCallId, params, signal, onUpdate, ctx) => {
      const { session_id: sessionId, code } = params as {
        session_id?: string;
        code: string;
      };
      const target = resolveKernelId(sessionManager, sessionId);
      if ("error" in target) {
        return { content: [{ type: "text", text: target.error }], details: {} };
      }
      sessionState.lastCtx = ctx;
      sessionState.activeForegroundExecutions.set(toolCallId, target.id);
      try {
        const result = await sessionManager.scratchRun(target.id, code, {
          cwd: ctx.cwd,
          ctx,
          signal,
          onUpdate,
          parentToolCallId: toolCallId,
        });
        if (result.details.estimatedAvoidedTokens > 0) {
          ptcTokensSaved.tokensSaved += result.details.estimatedAvoidedTokens;
        }
        return completedCellContent(result, target.id, settings);
      } finally {
        sessionState.activeForegroundExecutions.delete(toolCallId);
      }
    },
    renderShell: "self",
    renderResult: notebookResultRenderer("scratch_run"),
  });
}

/** write_cell: upsert a code/markdown cell at a position without executing it. */
function writeCellTool(sessionManager: PythonSessionManager): PtcToolDefinition {
  return withActivityLabel({
    name: "write_cell",
    label: "write cell",
    description:
      "Create or replace a notebook cell at a 1-based position, without executing it. Replaces the cell already at that position (its outputs are cleared); appends a new cell when `at` is past the end. Persists to the notebook immediately and updates the same cell model the kernel writes to.",
    parameters: Type.Object({
      session_id: Type.Optional(
        Type.String({ description: "Kernel id; defaults to the most recently used kernel." })
      ),
      at: Type.Integer({
        minimum: 1,
        description: "1-based position: replaces the existing cell there, or appends when past the end.",
      }),
      source: Type.String({ description: "Cell source text." }),
      type: Type.Optional(
        Type.Union([Type.Literal("code"), Type.Literal("markdown")], {
          description: "Cell type; defaults to code.",
        })
      ),
    }),
    execute: async (_toolCallId, params) => {
      const { session_id: sessionId, at, source, type } = params as {
        session_id?: string;
        at: number;
        source: string;
        type?: "code" | "markdown";
      };
      const target = resolveKernelId(sessionManager, sessionId);
      if ("error" in target) {
        return { content: [{ type: "text", text: target.error }], details: {} };
      }
      const cellType = type ?? "code";
      // Peek at the current cell first: its source feeds the renderer's
      // inline diff (replace) or cleared-contents red, and tells insert apart
      // from replace even when the write races with the notebook model.
      let oldSource: string | undefined;
      let replaced = false;
      try {
        const existing = await sessionManager.readCell(target.id, at);
        if (existing.cells.length > 0) {
          replaced = true;
          oldSource = existing.cells[0]!.source;
        }
      } catch {
        // Position past the end (or read failed): treat as an append.
      }
      try {
        const result = await sessionManager.writeCell(target.id, { at, source, cellType });
        const verb = replaced ? "Replaced" : "Appended";
        return {
          content: [
            {
              type: "text",
              text: `${verb} ${cellType} cell at position ${at} (kernel ${target.id}; notebook now has ${result.total} cell${result.total === 1 ? "" : "s"}).`,
            },
          ],
          details: {
            sessionId: target.id,
            at,
            cellType,
            total: result.total,
            cellSource: source,
            oldCellSource: oldSource,
            replaced,
          },
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: `write_cell failed: ${error instanceof Error ? error.message : String(error)}` }],
          details: { sessionId: target.id, at },
        };
      }
    },
    renderShell: "self",
    renderResult: notebookResultRenderer("write_cell"),
  });
}

/** delete_cell: remove a cell; later positions shift down. */
function deleteCellTool(sessionManager: PythonSessionManager): PtcToolDefinition {
  return withActivityLabel({
    name: "delete_cell",
    label: "delete cell",
    description:
      "Remove cell n from the notebook; subsequent cells shift down one position. Persists immediately. The kernel namespace is untouched.",
    parameters: Type.Object({
      session_id: Type.Optional(
        Type.String({ description: "Kernel id; defaults to the most recently used kernel." })
      ),
      n: Type.Integer({ minimum: 1, description: "1-based position of the cell to delete." }),
    }),
    execute: async (_toolCallId, params) => {
      const { session_id: sessionId, n } = params as { session_id?: string; n: number };
      const target = resolveKernelId(sessionManager, sessionId);
      if ("error" in target) {
        return { content: [{ type: "text", text: target.error }], details: {} };
      }
      // Capture the doomed cell's source first: the renderer draws the whole
      // deleted cell (red, gutter included) from it.
      let deletedSource: string | undefined;
      try {
        const existing = await sessionManager.readCell(target.id, n);
        deletedSource = existing.cells[0]?.source;
      } catch {
        // Cell may not exist; the delete below surfaces the real error.
      }
      try {
        const result = await sessionManager.deleteCell(target.id, n);
        return {
          content: [
            {
              type: "text",
              text: `Deleted cell ${n} (kernel ${target.id}; notebook now has ${result.total} cell${result.total === 1 ? "" : "s"}).`,
            },
          ],
          details: { sessionId: target.id, n, total: result.total, cellSource: deletedSource },
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: `delete_cell failed: ${error instanceof Error ? error.message : String(error)}` }],
          details: { sessionId: target.id, n },
        };
      }
    },
    renderShell: "self",
    renderResult: notebookResultRenderer("delete_cell"),
  });
}

/** read_cells: list cells (source + current outputs) over a 1-based window. */
function readCellsTool(sessionManager: PythonSessionManager): PtcToolDefinition {
  return withActivityLabel({
    name: "read_cells",
    label: "read cells",
    description:
      "Read notebook cells with their sources and current outputs, 1-based. Use offset/limit to page. Cell numbers are notebook positions (not execution numbers).",
    parameters: Type.Object({
      session_id: Type.Optional(
        Type.String({ description: "Kernel id; defaults to the most recently used kernel." })
      ),
      offset: Type.Optional(Type.Integer({ minimum: 1, description: "1-based first cell to read; default 1." })),
      limit: Type.Optional(Type.Integer({ minimum: 1, description: "Maximum number of cells to read; default all." })),
    }),
    execute: async (_toolCallId, params) => {
      const { session_id: sessionId, offset, limit } = params as {
        session_id?: string;
        offset?: number;
        limit?: number;
      };
      const target = resolveKernelId(sessionManager, sessionId);
      if ("error" in target) {
        return { content: [{ type: "text", text: target.error }], details: {} };
      }
      try {
        const result = await sessionManager.readCells(target.id, { offset, limit });
        return {
          content: [{ type: "text", text: renderNotebookCells(result.cells) }],
          details: { sessionId: target.id, total: result.total, cells: result.cells },
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: `read_cells failed: ${error instanceof Error ? error.message : String(error)}` }],
          details: { sessionId: target.id },
        };
      }
    },
    renderResult: notebookResultRenderer("read_cells"),
  });
}

/** read_cell: one cell's source + current outputs (1-based position). */
function readCellTool(sessionManager: PythonSessionManager): PtcToolDefinition {
  return withActivityLabel({
    name: "read_cell",
    label: "read cell",
    description:
      "Read one notebook cell (source plus its current outputs) by 1-based position. Use it before run_cell to see the exact code that will execute.",
    parameters: Type.Object({
      session_id: Type.Optional(
        Type.String({ description: "Kernel id; defaults to the most recently used kernel." })
      ),
      n: Type.Integer({ minimum: 1, description: "1-based notebook position." }),
    }),
    execute: async (_toolCallId, params) => {
      const { session_id: sessionId, n } = params as { session_id?: string; n: number };
      const target = resolveKernelId(sessionManager, sessionId);
      if ("error" in target) {
        return { content: [{ type: "text", text: target.error }], details: {} };
      }
      try {
        const result = await sessionManager.readCell(target.id, n);
        return {
          content: [{ type: "text", text: renderNotebookCells(result.cells) }],
          details: { sessionId: target.id, total: result.total, cells: result.cells },
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: `read_cell failed: ${error instanceof Error ? error.message : String(error)}` }],
          details: { sessionId: target.id, n },
        };
      }
    },
    renderShell: "self",
    renderResult: notebookResultRenderer("read_cell"),
  });
}

/** run_cell: execute cell n in place, refreshing only its stored outputs. */
function runCellTool(
  sessionManager: PythonSessionManager,
  settings: PtcSettings,
  sessionState: PtcSessionState
): PtcToolDefinition {
  return withActivityLabel({
    name: "run_cell",
    label: "run cell",
    description:
      "Execute the code cell at 1-based position n in the kernel and replace that cell's stored outputs. The kernel may also be ahead of the notebook, so run_to/run_all run prerequisite cells in order. Use read_cell first to confirm the code.",
    parameters: Type.Object({
      session_id: Type.Optional(
        Type.String({ description: "Kernel id; defaults to the most recently used kernel." })
      ),
      n: Type.Integer({ minimum: 1, description: "1-based position of the code cell to run." }),
    }),
    execute: async (toolCallId, params, signal, onUpdate, ctx) => {
      const { session_id: sessionId, n } = params as {
        session_id?: string;
        n: number;
      };
      const target = resolveKernelId(sessionManager, sessionId);
      if ("error" in target) {
        return { content: [{ type: "text", text: target.error }], details: {} };
      }
      let code = "";
      try {
        const preview = await sessionManager.readCell(target.id, n);
        code = preview.cells[0]?.source ?? "";
      } catch (error) {
        return {
          content: [{ type: "text", text: `run_cell failed: ${error instanceof Error ? error.message : String(error)}` }],
          details: { sessionId: target.id, n },
        };
      }
      sessionState.lastCtx = ctx;
      sessionState.activeForegroundExecutions.set(toolCallId, target.id);
      try {
        const result = await sessionManager.runCell(target.id, n, {
          cwd: ctx.cwd,
          ctx,
          signal,
          onUpdate,
          parentToolCallId: toolCallId,
        });
        if (result.details.estimatedAvoidedTokens > 0) {
          ptcTokensSaved.tokensSaved += result.details.estimatedAvoidedTokens;
        }
        const content = completedCellContent(result, target.id, settings);
        return { content: content.content, details: { ...content.details, runCellIndex: n } };
      } catch (error) {
        return {
          content: [{ type: "text", text: `run_cell failed: ${error instanceof Error ? error.message : String(error)}` }],
          details: { sessionId: target.id, n },
        };
      } finally {
        sessionState.activeForegroundExecutions.delete(toolCallId);
      }
    },
    renderShell: "self",
    renderResult: notebookResultRenderer("run_cell"),
  });
}

/** run_to / run_all: execute a batch of code cells in order. */
function runBatchTool(
  sessionManager: PythonSessionManager,
  sessionState: PtcSessionState,
  opts: { name: "run_to" | "run_all"; label: string; description: string; withN: boolean }
): PtcToolDefinition {
  const parameters = opts.withN
    ? Type.Object({
        session_id: Type.Optional(
          Type.String({ description: "Kernel id; defaults to the most recently used kernel." })
        ),
        n: Type.Integer({ minimum: 1, description: "Run code cells 1..n in order." }),
      })
    : Type.Object({
        session_id: Type.Optional(
          Type.String({ description: "Kernel id; defaults to the most recently used kernel." })
        ),
      });
  return withActivityLabel({
    name: opts.name,
    label: opts.label,
    description: opts.description,
    parameters,
    execute: async (toolCallId, params, signal, onUpdate, ctx) => {
      const { session_id: sessionId, n } = params as { session_id?: string; n?: number };
      const target = resolveKernelId(sessionManager, sessionId);
      if ("error" in target) {
        return { content: [{ type: "text", text: target.error }], details: {} };
      }
      sessionState.lastCtx = ctx;
      sessionState.activeForegroundExecutions.set(toolCallId, target.id);
      try {
        const options = {
          cwd: ctx.cwd,
          ctx,
          signal,
          onUpdate,
          parentToolCallId: toolCallId,
        };
        const result: NotebookRunResult =
          opts.name === "run_to"
            ? await sessionManager.runTo(target.id, n as number, options)
            : await sessionManager.runAll(target.id, options);
        const runSteps = result.steps;
        return {
          content: [{ type: "text", text: result.output }],
          details: { sessionId: target.id, runSteps, failedIndex: result.failedIndex },
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: `${opts.name} failed: ${error instanceof Error ? error.message : String(error)}` }],
          details: { sessionId: target.id },
        };
      } finally {
        sessionState.activeForegroundExecutions.delete(toolCallId);
      }
    },
    renderShell: "self",
    renderResult: notebookResultRenderer(opts.name),
  });
}

/** reset_kernel: restart the interpreter (fresh namespace); the notebook file is untouched. */
function resetKernelTool(sessionManager: PythonSessionManager): PtcToolDefinition {
  return withActivityLabel({
    name: "reset_kernel",
    label: "reset kernel",
    description:
      "Restart the kernel's interpreter: the namespace is empty (all imports/variables/defined functions are gone) and execution numbering restarts at 1. The notebook file on disk is untouched, so its cells remain for run_all/run_cell. Use it to get a clean slate without changing the notebook.",
    parameters: Type.Object({
      session_id: Type.Optional(
        Type.String({ description: "Kernel id; defaults to the most recently used kernel." })
      ),
    }),
    execute: async (toolCallId, params, _signal, _onUpdate, ctx) => {
      const { session_id: sessionId } = params as { session_id?: string };
      const target = resolveKernelId(sessionManager, sessionId);
      if ("error" in target) {
        return { content: [{ type: "text", text: target.error }], details: {} };
      }
      try {
        const summary = await sessionManager.resetKernel(target.id, {
          cwd: ctx.cwd,
          ctx,
          parentToolCallId: toolCallId,
        });
        const notebook = summary.notebookPath ?? "(none)";
        return {
          content: [
            {
              type: "text",
              text: `Restarted kernel ${target.id}: fresh namespace, execution numbering from 1. Notebook ${notebook} untouched.`,
            },
          ],
          details: summary,
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: `reset_kernel failed: ${error instanceof Error ? error.message : String(error)}` }],
          details: { sessionId: target.id },
        };
      }
    },
    renderResult: notebookResultRenderer("reset_kernel"),
  });
}

// ============================================================================
// /workflow command
// ============================================================================

const WORKFLOW_PROMPT = `The user wants to run a task as an orchestrated subagent workflow (they invoked /workflow).

Load the bundled pi-subagents skill (skills/pi-subagents/SKILL.md) and read it fully before doing anything else. Then reason about the user's request above and design the best workflow for it:

1. Decompose the request into agent-sized units and decide the stages (audit/build/review/synth as appropriate), how many subagents per stage, and what each agent's precise, self-contained task brief is.
2. Decide termination: linear fan-out vs. a review/fix cycle (gate any cycle on a metadata rounds cap).
3. Inherit the configured subagent profile's default model unless the user specifies a model; set thinking levels appropriate to the work.
4. Provision a durable notebook-backed kernel in the project's .pi/workflows folder. Use three or more cells: first declare prompts, tasks, schemas, working-directory paths, and other constants; then build the AgentPool, submit tasks, consume results in completion order, and route follow-ups in orchestration-only cells; finally close the pool in a separate teardown cell after reviewing the results. Create the opening orchestration cell with write_cell and present it for review before run_cell, rather than using exec_cell or scratch_run to launch it. Only orchestration logic belongs in the reviewable cell; never inline prompts into it.
5. Set each agent's working directory through Task(cwd=WORKDIR), not instructions in its prompt.
6. Feed results forward yourself: parse structured results in Python and restate them as prose in the next agent's prompt — never paste raw JSON between agents.

If the request is too small to warrant a workflow (a single agent would do), say so and just do the work directly instead.

User request: `;

/** Register the /workflow command: injects the subagent-workflow design prompt as a follow-up message. */
function registerWorkflowCommand(pi: ExtensionAPI): void {
  pi.registerCommand("workflow", {
    description: "Kick off a subagent workflow: has the model load the pi-subagents skill and design a workflow from your request",
    handler: async (args: string | undefined, ctx: ExtensionCommandContext) => {
      const request = (args ?? "").trim();
      if (!request) {
        ctx.ui.notify("usage: /workflow <request to turn into a subagent workflow>", "error");
        return;
      }
      await pi.sendUserMessage(WORKFLOW_PROMPT + request, { deliverAs: "followUp" });
    },
  });
}

// ============================================================================
// /ptc command
// ============================================================================

/**
 * Resolve the session a /ptc action targets: an explicit id, else the most
 * recently targeted foreground session, else the most recent active, else the
 * first live session. Returns { error } when nothing qualifies.
 */
function resolveTargetSession(
  sessionManager: PythonSessionManager,
  sessionState: PtcSessionState,
  requested?: string
): SessionSummary | { error: string } {
  if (requested) {
    const found = sessionManager.list().find((s) => s.id === requested);
    return found ?? { error: `Unknown python session ${requested}. Live: ${sessionManager.list().map((s) => s.id).join(", ") || "(none)"}` };
  }
  const sessions = sessionManager.list();
  const activeSessionIds = Array.from(sessionState.activeForegroundExecutions.values()).reverse();
  const target =
    activeSessionIds.map((id) => sessions.find((session) => session.id === id)).find(Boolean) ??
    sessionManager.mostRecentActive() ??
    sessions[0];
  return target ?? { error: "No python sessions. Provision one with provision_kernel first." };
}

/** Register the /ptc command (interrupt|stop|kill [session_id]; bg/fg are WIP-deferred). */
function registerPtcCommand(pi: ExtensionAPI, sessionManager: PythonSessionManager, sessionState: PtcSessionState): void {
  pi.registerCommand("ptc", {
    description: "Control PTC Python kernels: /ptc <interrupt|kill> [session_id]",
    handler: async (args: string | undefined, ctx: ExtensionCommandContext) => {
      const [actionRaw, requestedId] = (args ?? "").trim().split(/\s+/);
      const action = (actionRaw ?? "").toLowerCase();

      if (!["background", "bg", "foreground", "fg", "interrupt", "stop", "kill"].includes(action)) {
        ctx.ui.notify(
          "usage: /ptc <interrupt|kill> [session_id]  (background|bg|foreground|fg are WIP/deferred)",
          "error"
        );
        return;
      }

      if (action === "background" || action === "bg" || action === "foreground" || action === "fg") {
        ctx.ui.notify("/ptc background|foreground is WIP (deferred) — runs are synchronous for now", "error");
        return;
      }
      const target = resolveTargetSession(sessionManager, sessionState, requestedId);
      if ("error" in target) {
        ctx.ui.notify(target.error, "error");
        return;
      }

      if (action === "interrupt" || action === "stop") {
        // Ctrl-C semantics: the running chunk stops where it is, the session (and
        // anything it spawned) stays alive for the next chunk to reuse.
        const interrupted = sessionManager.interruptRunning(target.id);
        ctx.ui.notify(
          interrupted
            ? `Interrupted the running chunk in session ${target.id} (session left alive)`
            : `Nothing running in session ${target.id}`,
          interrupted ? "info" : "error"
        );
        return;
      }

      // kill
      try {
        await sessionManager.dispose(target.id);
        ctx.ui.notify(`Disposed python session ${target.id}`, "info");
      } catch (error) {
        ctx.ui.notify(`Failed to dispose session ${target.id}: ${error instanceof Error ? error.message : String(error)}`, "error");
      }
    },
  });
}

// ============================================================================
// Subagent runtime (global API + footer)
// ============================================================================

const SUBAGENT_RUNTIME_KEY = Symbol.for("pi-pycells:subagent-runtime");

/** Snapshot shape published on globalThis for other extensions (see createSubagentRuntime). */
interface SubagentRuntimeApi {
  getSnapshot(): {
    sessions: Array<{ sessionId: string; snapshot: SubagentRuntimeSnapshot }>;
    totals: { running: number; settled: number; failed: number };
  } | null;
  subscribe(listener: (payload: { sessionId: string; snapshot: SubagentRuntimeSnapshot }) => void): () => void;
}

/**
 * GlobalThis-published API (key: Symbol.for("pi-pycells:subagent-runtime")) letting
 * other extensions observe PTC subagent pools without a cross-package import:
 * current per-session snapshots plus running/settled/failed totals, and a
 * listener subscription for snapshot updates.
 */
function createSubagentRuntime(sessionManager: PythonSessionManager): SubagentRuntimeApi {
  const listeners = new Set<(payload: { sessionId: string; snapshot: SubagentRuntimeSnapshot }) => void>();

  const hooks: PythonSessionManagerHooks = {
    onSubagentSnapshot: (sessionId, _execId, snapshot) => {
      for (const listener of listeners) {
        try {
          listener({ sessionId, snapshot });
        } catch {
          // broken consumer must not take the runtime down
        }
      }
    },
  };

  return {
    getSnapshot() {
      const sessions = sessionManager.allSubagentSnapshots();
      if (sessions.length === 0) {
        return null;
      }
      const totals = { running: 0, settled: 0, failed: 0 };
      for (const { snapshot } of sessions) {
        totals.running += snapshot.totals?.running ?? 0;
        totals.settled += snapshot.totals?.settled ?? 0;
        totals.failed += snapshot.totals?.failed ?? 0;
      }
      return { sessions, totals };
    },
    subscribe(listener: (payload: { sessionId: string; snapshot: SubagentRuntimeSnapshot }) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/**
 * Update the status-bar subagent indicator (unless disabled or headless):
 * counts of running/done agents relevant to the given exec, cleared when none.
 */
function updateSubagentFooter(
  sessionState: PtcSessionState,
  settings: PtcSettings,
  snapshotOverride?: SubagentRuntimeSnapshot,
  execId?: string
): void {
  if (!settings.subagentFooter) {
    return;
  }
  const ctx = sessionState.lastCtx;
  if (!ctx?.hasUI) {
    return;
  }
  const snapshot = snapshotOverride ?? sessionState.lastSubagentSnapshot ?? undefined;
  const relevant = relevantAgents(snapshot, execId);
  if (relevant.length === 0) {
    ctx.ui.setStatus("ptc-subagents", undefined);
    return;
  }
  const running = relevant.filter((a) => a.status === "running" || a.status === "starting").length;
  const settled = relevant.filter((a) => a.status === "settled" || a.status === "closed").length;
  const bits: string[] = [];
  if (running) bits.push(`● ${running} running`);
  if (settled) bits.push(`✓ ${settled} done`);
  ctx.ui.setStatus("ptc-subagents", `subagents: ${bits.join(" · ")}`);
}

// ============================================================================
// Event handlers
// ============================================================================

/** session_start: scan custom tools, then (re)register all PTC tools. */
async function handleSessionStart(
  customToolManager: CustomToolManager,
  sessionState: PtcSessionState,
  pi: ExtensionAPI,
  toolRegistry: ToolRegistry,
  settings: PtcSettings,
  sessionManager: PythonSessionManager,
  sandboxManager: SandboxManager,
  _event: unknown,
  ctx: ExtensionContext
): Promise<void> {
  sessionState.currentCwd = ctx.cwd;
  if (!sessionState.customToolsStarted) {
    await customToolManager.start();
    sessionState.customToolsStarted = true;
  }

  const toolDescription = currentToolDescription(toolRegistry, settings, sessionState);
  pi.registerTool(provisionKernelTool(sessionManager, sessionState));
  pi.registerTool(execCellTool(pi, sessionManager, settings, sessionState, toolDescription));
  pi.registerTool(listKernelsTool(sessionManager));
  pi.registerTool(readCellOutputTool(sessionManager));
  pi.registerTool(promoteToSkillNotebookTool(sessionManager));
  pi.registerTool(inspectKernelTool(sessionManager, toolDescription));
  pi.registerTool(provisionDependencyTool(sessionManager, sandboxManager));
  pi.registerTool(scratchRunTool(sessionManager, settings, sessionState));
  pi.registerTool(writeCellTool(sessionManager));
  pi.registerTool(deleteCellTool(sessionManager));
  pi.registerTool(readCellsTool(sessionManager));
  pi.registerTool(readCellTool(sessionManager));
  pi.registerTool(createCellReviewTool(sessionManager, requestCellApproval));
  pi.registerTool(runCellTool(sessionManager, settings, sessionState));
  pi.registerTool(
    runBatchTool(sessionManager, sessionState, {
      name: "run_to",
      label: "run to cell",
      description:
        "Execute code cells 1..n in notebook order, stopping at the first error. Code cells only; markdown cells are skipped. Each executed cell's stored outputs are updated in place, and execution numbering advances in run order (notebook positions may differ from execution counts).",
      withN: true,
    })
  );
  pi.registerTool(
    runBatchTool(sessionManager, sessionState, {
      name: "run_all",
      label: "run all",
      description:
        "Execute every code cell in notebook order, stopping at the first error. Markdown cells are skipped; each executed cell's stored outputs are updated in place.",
      withN: false,
    })
  );
  pi.registerTool(resetKernelTool(sessionManager));
}

/**
 * before_agent_start: reset per-request recovery state, decide whether
 * automatic recovery is allowed (mutation prompts disallow it), apply prompt
 * routing, and add a depth note to the system prompt for subagent instances.
 */
function handleBeforeAgentStart(
  pi: ExtensionAPI,
  toolRegistry: ToolRegistry,
  settings: PtcSettings,
  sessionState: PtcSessionState,
  event: { prompt?: string; systemPrompt: string }
): { systemPrompt?: string } | undefined {
  sessionState.pendingRecoveryPrompt = null;
  sessionState.recoveryAllowed = typeof event.prompt === "string" ? !isMutationPrompt(event.prompt) : true;
  sessionState.recoveryState = createPtcRecoveryState();

  let result: { systemPrompt?: string } | undefined;
  if (typeof event.prompt === "string") {
    result = applyAutoRouting(pi, toolRegistry, settings, sessionState, event.prompt, event.systemPrompt);
  }

  // Depth-aware system prompt for subagent instances.
  const depth = Number.parseInt(process.env.PI_SUBAGENT_DEPTH ?? "", 10);
  if (Number.isFinite(depth) && depth > 0) {
    const depthNote =
      `You are a pi subagent at nesting depth ${depth}. Subagent spawning is unavailable: ` +
      "`import pi_subagents` raises NotImplementedError in this environment. `exec_cell` " +
      "remains available for computation. Report your final answer as your last message.";
    result = { ...(result ?? {}), systemPrompt: `${result?.systemPrompt ?? event.systemPrompt}\n\n${depthNote}` };
  }

  return result;
}

/**
 * context: inject a pending recovery prompt (if any) as an extra message and
 * clear it — one recovery nudge per request.
 */
function handleContext(sessionState: PtcSessionState, event: { messages: Array<Record<string, unknown>> }) {
  if (!sessionState.pendingRecoveryPrompt) {
    return undefined;
  }

  const messages = [...event.messages, buildRecoveryContextMessage(sessionState.pendingRecoveryPrompt)];
  sessionState.pendingRecoveryPrompt = null;
  return { messages };
}

/**
 * tool_result: on a failed exec_cell, stamp recovery telemetry/details onto the
 * result so the transcript records what the recovery system observed.
 */
function handleToolResult(
  sessionState: PtcSessionState,
  event: { toolName: string; isError: boolean; details?: unknown }
): { details?: unknown } | undefined {
  if (event.toolName !== "exec_cell" || !event.isError || !sessionState.recoveryState) {
    return undefined;
  }
  const priorDetails =
    typeof event.details === "object" && event.details !== null && !Array.isArray(event.details)
      ? (event.details as Record<string, unknown>)
      : {};
  return {
    details: {
      ...priorDetails,
      telemetry: buildPtcExecutionTelemetry(sessionState.recoveryState),
      recovery: buildPtcRecoveryDetails(sessionState.recoveryState),
    },
  };
}

/** agent_end: restore routed-away tools and clear per-request recovery state. */
function handleAgentEnd(pi: ExtensionAPI, sessionState: PtcSessionState): void {
  restoreActiveToolsAfterRouting(pi, sessionState);
  sessionState.pendingRecoveryPrompt = null;
  sessionState.recoveryAllowed = true;
  sessionState.recoveryState = null;
}

/** session_shutdown: close custom tools, dispose all kernels, clean the sandbox. */
async function handleSessionShutdown(
  customToolManager: CustomToolManager,
  sandboxManager: SandboxManager,
  sessionManager: PythonSessionManager
): Promise<void> {
  customToolManager.close();
  await sessionManager.disposeAll();
  await sandboxManager.cleanup();
}

// ============================================================================
// Extension entry
// ============================================================================

/**
 * PTC extension entry point: load settings from env, create the sandbox,
 * construct the kernel manager (disposing any manager left by a previous
 * extension instance), publish the subagent runtime, kick off background
 * pi_subagents env provisioning, and register commands, tools, and event
 * handlers.
 */
export default async function ptcExtension(pi: ExtensionAPI, context?: ExtensionContext) {
  const settings = loadSettingsFromEnv();
  const extensionRoot = getExtensionRoot();
  // Capture the live settings view once: getSettings() structured-clones per
  // call, so the resolver always reads the CURRENT tuiMode even after a
  // regular↔fullscreen switch (pi re-renders all rows on switch).
  setNotebookTuiModeProvider(() => {
    try {
      return pi.getSettings().tuiMode;
    } catch {
      return undefined; // RPC/non-interactive contexts: collapse to "normal"
    }
  });
  const toolRegistry = new ToolRegistry(pi);
  const sandboxManager = await createSandbox();
  const sessionState: PtcSessionState = {
    currentCwd: context?.cwd ?? process.cwd(),
    customToolsStarted: false,
    activeToolsBeforeRouting: null,
    pendingRecoveryPrompt: null,
    recoveryAllowed: true,
    recoveryState: null,
    activeForegroundExecutions: new Map(),
    lastSubagentSnapshot: null,
    lastCtx: context ?? null,
  };

  // Reload hygiene: an earlier extension instance's sessions die with it.
  const previousManager = (globalThis as Record<string, unknown>).__ptcPythonSessionManager as
    | { disposeAll(): Promise<void> }
    | undefined;
  if (previousManager) {
    await previousManager.disposeAll().catch(() => undefined);
  }

  const sessionManager = new PythonSessionManager(sandboxManager, toolRegistry, settings, extensionRoot, {
    onSubagentSnapshot: (_sessionId, execId, snapshot) => {
      sessionState.lastSubagentSnapshot = snapshot;
      updateSubagentFooter(sessionState, settings, snapshot, execId);
    },
    onInterrupted: (sessionId, text) => {
      // pi records our interrupt error as the tool result, so the model already has
      // the stack. This hook exists for hosts that drop tool results; keep it quiet.
      debugLog(`exec_cell interrupt report for ${sessionId}`, text.slice(0, 200));
    },
  });
  (globalThis as Record<string, unknown>).__ptcPythonSessionManager = sessionManager;
  (globalThis as Record<symbol, unknown>)[SUBAGENT_RUNTIME_KEY] = createSubagentRuntime(sessionManager);

  // Provision the pi_subagents runtime in the background — but only when the
  // user opted in: subagents are OFF unless PI_SUBAGENTS_MAX_CONCURRENT is set
  // to a positive number (which also becomes the global pool cap). An
  // "optional" dependency that installs itself before you asked is just an
  // unrequested install; nothing downloads until you enable it.
  if (subagentsProvisioningEnabled()) {
    // Memoized and shared: the session manager's readiness gate awaits this
    // same promise before its first kernel spawn, so a first-install kernel
    // does not lock in system python3 while packages land in the venv.
    // Provisioning is best-effort, but its failure must not be fully silent:
    // log one warning (details live in ~/.cache/pi-pycells/subagents-sync.log).
    void startSubagentsEnv({ extensionRoot }).then((result) => {
      if (result.status === "failed") {
        console.warn(
          `[PTC] pi_subagents provisioning failed: ${result.reason}. ` +
          "Core Python kernels are unaffected; see ~/.cache/pi-pycells/subagents-sync.log for details."
        );
      }
      });
  } else {
    // Spawned subagent window: the full pi_subagents sync is skipped, but
    // kernels still need the shared venv (there is no system-python fallback).
    void ensurePtcVenv().then((ok) => {
      if (!ok) {
        console.warn(
          "[PTC] could not create the shared Python venv (uv is required — " +
          "https://docs.astral.sh/uv/). Python kernels will fail to start here."
        );
      }
    });
  }

  registerPtcCommand(pi, sessionManager, sessionState);
  registerWorkflowCommand(pi);

  const onToolSetChanged = () => {
    // During initial startup handleSessionStart registers all tools once after
    // the custom-tool scan. Later hot reloads replace these two definitions so
    // the model-facing helper list stays in sync with the callable tool set.
    if (!sessionState.customToolsStarted) {
      return;
    }
    const toolDescription = currentToolDescription(toolRegistry, settings, sessionState);
    pi.registerTool(execCellTool(pi, sessionManager, settings, sessionState, toolDescription));
    pi.registerTool(inspectKernelTool(sessionManager, toolDescription));
  };

  const customToolManager = new CustomToolManager(extensionRoot, pi, toolRegistry, onToolSetChanged);

  const onSessionStart = handleSessionStart.bind(
    undefined,
    customToolManager,
    sessionState,
    pi,
    toolRegistry,
    settings,
    sessionManager,
    sandboxManager
  );
  const onBeforeAgentStart = handleBeforeAgentStart.bind(undefined, pi, toolRegistry, settings, sessionState);
  const onContext = handleContext.bind(undefined, sessionState);
  const onToolResult = handleToolResult.bind(undefined, sessionState);
  const onAgentEnd = handleAgentEnd.bind(undefined, pi, sessionState);
  const onSessionShutdown = handleSessionShutdown.bind(undefined, customToolManager, sandboxManager, sessionManager);

  pi.on("session_start", onSessionStart);
  pi.on("before_agent_start", onBeforeAgentStart);
  (pi as unknown as { on(event: "context", handler: typeof onContext): void }).on("context", onContext);
  pi.on("tool_result", onToolResult);
  pi.on("agent_end", onAgentEnd);
  pi.on("session_shutdown", onSessionShutdown);
}
