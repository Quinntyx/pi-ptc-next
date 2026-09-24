import { Type } from "@sinclair/typebox";
import * as fs from "node:fs";
import * as path from "node:path";
import type {
  AgentToolResult,
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  Theme,
  ToolRenderResultOptions,
} from "@mariozechner/pi-coding-agent";
import { Text, type Component } from "@mariozechner/pi-tui";
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
import { ensureSubagentsEnv } from "./subagents-env";
import { describePythonHelpers } from "./tools/python-tool-contract";
import { ToolRegistry } from "./tool-registry";
import type { ExecutionDetails, PtcSettings, PtcToolDefinition, SandboxManager, ToolInfo } from "./types";
import type { SubagentRuntimeSnapshot } from "./contracts/execution-types";
import {
  debugLog,
  isMutationPrompt,
  loadSettingsFromEnv,
  shouldAutoRoutePromptToCodeExecution,
  withActivityLabel,
} from "./utils";
import {
  CODE_VIEW_FULL_THRESHOLD,
  CODE_VIEW_HEIGHT,
  computeCodeViewStart,
  type CodeViewState,
} from "./execution/code-view";
import { relevantAgents, renderSubagentPanel } from "./execution/subagent-panel";
import {
  PythonSessionManager,
  UnknownSessionError,
  type PythonSessionManagerHooks,
  type SessionSummary,
} from "./python-session-manager";

// Running tally of cumulative PTC token savings, shared in-process on globalThis
// so other extensions (e.g. the prompt status bar) can surface it without a cross-package import.
const ptcTokensSaved = { tokensSaved: 0 };
(globalThis as Record<string, unknown>).__ptcTokensSaved = ptcTokensSaved;

//
// Minimal structural view of the render context the pi TUI passes as the fourth
// argument to renderResult. `state` is shared across all renders of the same tool
// execution, which lets the executing-code view carry its scroll position between
// partial updates (the installed @mariozechner types predate this argument).
interface PartialRenderContext {
  state?: { viewStartLine?: number };
}

function buildExecutingCodeLines(
  codeLines: string[],
  currentLine: number,
  totalLines: number,
  activeTool: string | undefined,
  theme: Theme,
  state: CodeViewState
): string[] {
  const lines: string[] = [];
  const toolBadge = activeTool ? theme.fg("success", ` • calling ${activeTool}()`) : "";
  lines.push(theme.fg("muted", `Executing Python code (line ${currentLine}/${totalLines})`) + toolBadge);
  lines.push("");

  let startIdx = 0;
  let endIdx = codeLines.length;

  if (codeLines.length > CODE_VIEW_FULL_THRESHOLD) {
    state.viewStartLine = computeCodeViewStart(currentLine, codeLines.length, state.viewStartLine);
    startIdx = state.viewStartLine - 1;
    endIdx = Math.min(codeLines.length, startIdx + CODE_VIEW_HEIGHT);
  } else {
    state.viewStartLine = 1;
  }

  if (startIdx > 0) {
    lines.push(theme.fg("muted", "       │ ..."));
  }

  for (let index = startIdx; index < endIdx; index++) {
    const lineNumber = index + 1;
    const isCurrentLine = lineNumber === currentLine;
    const line = codeLines[index];
    let prefix = `${String(lineNumber).padStart(6, " ")} │ `;
    let content = line;

    if (isCurrentLine) {
      prefix = theme.fg("success", `▶ ${String(lineNumber).padStart(4, " ")} │ `);
      content = theme.fg("text", line);
    } else if (lineNumber < currentLine) {
      prefix = theme.fg("muted", prefix);
      content = theme.fg("muted", line);
    } else {
      prefix = theme.fg("muted", prefix);
    }

    lines.push(prefix + content);
  }

  if (endIdx < codeLines.length) {
    lines.push(theme.fg("muted", "       │ ..."));
  }

  return lines;
}

function renderExecutingCode(
  codeLines: string[],
  currentLine: number,
  totalLines: number,
  activeTool: string | undefined,
  theme: Theme,
  state: CodeViewState
): Component {
  return new Text(buildExecutingCodeLines(codeLines, currentLine, totalLines, activeTool, theme, state).join("\n"), 0, 0);
}


function renderCompletedOutput(
  resultText: string,
  details: ExecutionDetails | undefined,
  theme: Theme
): Component {
  if (!details) {
    return new Text(resultText || "(No output)", 0, 0);
  }

  const durationSec = (details.durationMs / 1000).toFixed(1).replace(/\.0$/, "");
  const avoidTok = details.estimatedAvoidedTokens > 0
    ? ` • ~${details.estimatedAvoidedTokens.toLocaleString()} tokens saved`
    : "";
  const nestedStr = details.nestedToolCalls > 0
    ? `${details.nestedToolCalls} nested call${details.nestedToolCalls > 1 ? "s" : ""}`
    : "local logic";
  const imgStr = details.imagesCount && details.imagesCount > 0
    ? theme.fg("success", ` • ${details.imagesCount} figure${details.imagesCount > 1 ? "s" : ""} generated`)
    : "";
  const sessionStr = details.sessionId
    ? theme.fg("muted", ` • session ${details.sessionId}${details.backgrounded ? " (backgrounded)" : ""}`)
    : "";

  const header = theme.fg(
    "muted",
    `[PTC] ${nestedStr}${avoidTok} • ${durationSec}s`
  ) + imgStr + sessionStr;

  const subagentLines = renderSubagentPanel(details.subagentSnapshot, theme, details.execId);
  const subagentBlock = subagentLines.length > 0 ? `\n${subagentLines.join("\n")}\n` : "";

  const rawBody = resultText || "(No output)";
  const bodyLines = rawBody.split("\n");
  const maxDisplayLines = 25;
  let displayedBody = rawBody;

  if (bodyLines.length > maxDisplayLines) {
    displayedBody = bodyLines.slice(0, maxDisplayLines).join("\n") +
      `\n${theme.fg("muted", `... (${bodyLines.length - maxDisplayLines} more lines omitted in view)`)}`;
  }

  return new Text(`${header}${subagentBlock}\n${displayedBody}`, 0, 0);
}

function getExtensionRoot(): string {
  return __dirname.endsWith("/dist") || __dirname.endsWith("\\dist")
    ? __dirname.replace(/[/\\]dist$/, "")
    : __dirname;
}

function getRequestRecoveryState(sessionState: PtcSessionState): PtcRecoveryState {
  if (!sessionState.recoveryState) {
    sessionState.recoveryState = createPtcRecoveryState();
  }

  return sessionState.recoveryState;
}

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

function buildToolDescription(currentSettings: PtcSettings, callableTools: ToolInfo[]): string {
  const callableHelperLines = describePythonHelpers(callableTools);
  const callable = callableTools.map((tool) => tool.ptc?.pythonName || tool.name).join(", ");
  const dockerBehavior = currentSettings.useDocker
    ? "- Docker isolation is required for this session; if Docker is unavailable, execution fails instead of falling back to subprocess."
    : "- Local subprocess mode is active because PTC_ALLOW_UNSANDBOXED_SUBPROCESS=true. Nested tool policy still applies, but Python itself is not isolated by Docker in this mode.";

  return `Persistent Python sessions with local programmatic tool calling.

Workflow:
1. provision_python_session — start a persistent interpreter, get a session id. Optionally seed it by executing a Python file first.
2. python_exec — run code chunks in that session. It behaves like an interactive Python REPL that stays open: imports, variables, and defined functions carry over to later chunks and later turns, so import each module once and build on it. The cumulative code can be exported as a durable script at any time.
3. python_session_to_script — write the session's cumulative code to a script file on disk, then edit/run it with normal tools.
4. when a chunk's subagents are done and no longer needed, close them with subagents.finish() so their tmux windows do not pile up.

Prefer python_exec for repo-wide analysis, repeated lookups, loops, grouping, ranking, counting, filtering, or any task with 3+ dependent tool calls. Use direct tools for one-file reads, one-off grep/find calls, or tiny lookups.

python_exec runs synchronously and streams progress — including a live viewer of any pi_subagents fan-out the chunk runs (agent status rows render under the code view while it executes). Prefer orchestrating an entire fan-out inside one chunk: spawn the subagents, wait for them, aggregate, return the summary.

Subagents: the autoimported pi_subagents module spawns real pi instances in tmux windows (AgentHandle / AgentSession). Ask it what is available before naming a model — subagents.capabilities(), subagents.best_model_match("astra").slug, subagents.thinking_levels() — then pass model=/thinking= to subagents.agent().

Important rules:
- Top-level await is already available. Do not call asyncio.run(...).
- Definitions persist across chunks: import once, define reusable functions once.
- A chunk's output should be compact; large intermediates stay in the session.
- When the logic stabilizes, export it with python_session_to_script instead of re-running long chunks.

Callable tool set for this session: ${callable}

Python helpers currently available in this session:
- ${callableHelperLines.join("\n- ")}
- ptc.gather_limit(coros, limit=...) -> list
- ptc.read_many(paths, max_concurrency=None) -> list[str]
- ptc.read_tree(pattern, path='.', ...) -> list[dict]
- ptc.find_files / ptc.find_files_abs / ptc.read_text / ptc.json_dump
- np / pd / plt lazy imports (matplotlib figures are captured automatically)
${dockerBehavior}`;
}

const PROVISION_DESCRIPTION = `Start a persistent Python session and return its id. Sessions work exactly like an interactive Python REPL: every python_exec chunk sent to the session runs in the same live interpreter namespace, so modules you import, variables you assign, and functions/classes you define all carry over to later chunks and later turns of the conversation.

Import each module ONCE per session — there is no need to re-import in later chunks; re-importing the same module repeatedly is wasteful and a sign the session was not reused. Likewise define helper functions once and call them from later chunks.

Optionally pass a script path: a path to a Python file that is executed in the session before the id is returned, so the session can start from a prebuilt script (for example one exported earlier via python_session_to_script) and continue working in the resulting environment.

Sessions stay alive until the conversation ends or /ptc kill, so reuse them across turns and across python_exec calls instead of provisioning a new one for each step.`;

const PYTHON_EXEC_DESCRIPTION = `Run Python code inside a persistent, already-provisioned session — like typing into an interactive Python REPL that stays open between calls.

Everything in the namespace carries over to later chunks and later conversation turns: modules imported earlier are still imported (do NOT re-import them), variables assigned earlier are still set, and functions/classes defined earlier are still callable. Write each chunk as the continuation of the live session — build on what is already there instead of rebuilding it.

- session_id (required): id from provision_python_session. Unknown ids error with the list of live sessions.
- Top-level await is available; do not call asyncio.run(...).
- Return a compact final result; a returned dict/list is JSON-serialized automatically.
- Errors do not kill the session: fix and retry in the same namespace.

Runs synchronously and blocks until the chunk finishes — progress streams into the transcript, including a live view of any pi_subagents fan-out the code runs. Prefer doing all orchestration inside one chunk (spawn subagents, wait for them, close them with subagents.finish(), aggregate, return the summary) so the viewer can render the whole fan-out and no subagent windows are left behind.`;

const SCRIPT_EXPORT_DESCRIPTION = `Export the cumulative code of a python session as a durable script file on disk (default ./.pi/scripts/<name>.py). The script is assembled from every chunk executed in the session, in order, with cell separators and a header. Sessions that used top-level await are wrapped in async def main() + asyncio.run(main()).

After export, edit and run the script with normal tools (edit/bash/write/read). session_id defaults to the most recent session.`;

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
  /** /ptc background target: tool call id of the blocking exec in flight. */
  activeForegroundToolCallId: string | null;
  activeForegroundSessionId: string | null;
  lastSubagentSnapshot: SubagentRuntimeSnapshot | null;
  /** Set by /ptc background; observed by the in-flight python_exec. */
  requestedBackground: string | null;
  /** Last tool execution context, for footer updates outside tool executes. */
  lastCtx: ExtensionContext | null;
}

function areToolListsEqual(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

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
  if (!allTools.some((tool) => tool.name === "python_exec")) {
    return undefined;
  }

  noteAutomaticRouting(getRequestRecoveryState(sessionState));

  const activeTools = pi.getActiveTools();
  const routableToolNames = new Set(toolRegistry.getAutoRoutableToolNames(sessionState.currentCwd, settings));
  const nextActiveTools = activeTools.filter((name) => !routableToolNames.has(name));
  if (!nextActiveTools.includes("python_exec")) {
    nextActiveTools.push("python_exec");
  }
  if (!nextActiveTools.includes("provision_python_session")) {
    nextActiveTools.push("provision_python_session");
  }

  if (!areToolListsEqual(activeTools, nextActiveTools)) {
    sessionState.activeToolsBeforeRouting = activeTools;
    pi.setActiveTools(nextActiveTools);
    debugLog("Auto-routed prompt to python_exec", { prompt, activeTools, nextActiveTools });
  }

  return {
    systemPrompt:
      `${currentSystemPrompt}\n\n` +
      "This request is a strong fit for python_exec. Provision a python session first (provision_python_session), keep large intermediate results inside the session, and prefer python_exec for the work.",
  };
}

function restoreActiveToolsAfterRouting(pi: ExtensionAPI, sessionState: PtcSessionState): void {
  if (!sessionState.activeToolsBeforeRouting) {
    return;
  }

  pi.setActiveTools(sessionState.activeToolsBeforeRouting);
  debugLog("Restored active tools after python_exec routing", {
    restored: sessionState.activeToolsBeforeRouting,
  });
  sessionState.activeToolsBeforeRouting = null;
}

// ============================================================================
// Tools
// ============================================================================

function provisionPythonSessionTool(
  pi: ExtensionAPI,
  sessionManager: PythonSessionManager,
  sessionState: PtcSessionState
): PtcToolDefinition {
  return withActivityLabel({
    name: "provision_python_session",
    label: "python",
    description: PROVISION_DESCRIPTION,
    parameters: Type.Object({
      script: Type.Optional(
        Type.String({
          description:
            "Optional path to a Python file executed in the session before the id is returned. Use a prebuilt script (e.g. from python_session_to_script) to start from a prepared environment.",
        })
      ),
    }),
    execute: async (toolCallId, params, signal, onUpdate, ctx) => {
      const { script } = params as { script?: string };
      let scriptCode: string | undefined;
      if (script) {
        const scriptPath = path.isAbsolute(script) ? script : path.resolve(ctx.cwd, script);
        try {
          scriptCode = fs.readFileSync(scriptPath, "utf-8");
        } catch (error) {
          return {
            content: [{ type: "text", text: `Failed to read script ${script}: ${error instanceof Error ? error.message : String(error)}` }],
            details: { sessionId: null, error: "script-read-failed" },
          };
        }
      }

      try {
        const { id, scriptError } = await sessionManager.provision({
          cwd: ctx.cwd,
          ctx,
          signal,
          onUpdate,
          parentToolCallId: toolCallId,
          script: scriptCode,
        });

        const lines = [`Provisioned python session ${id}. Send code chunks with python_exec (session_id: ${id}).`];
        if (scriptError) {
          lines.push(
            `The seeding script failed (the session is still usable):`,
            scriptError.message,
            ...(scriptError.traceback ? [scriptError.traceback] : []),
            `Inspect the error with python_exec in session ${id} and repair as needed.`
          );
        }
        return {
          content: [{ type: "text", text: lines.join("\n") }],
          details: {
            sessionId: id,
            scriptError: scriptError ? scriptError.message : undefined,
            nestedToolCalls: 0,
            nestedToolNames: [],
            nestedResultChars: 0,
            nestedResultCount: 0,
            nestedErrors: scriptError ? 1 : 0,
            durationMs: 0,
            estimatedAvoidedTokens: 0,
          },
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: `Failed to provision python session: ${error instanceof Error ? error.message : String(error)}` }],
          details: { sessionId: null },
        };
      }
    },
    renderResult(result: AgentToolResult<unknown>, { isPartial }: ToolRenderResultOptions, theme: Theme) {
      const details = result.details as { sessionId?: string; scriptError?: string } | undefined;
      if (isPartial) {
        return new Text(theme.fg("muted", "Provisioning python session..."), 0, 0);
      }
      const sessionLine = details?.sessionId ? theme.fg("success", `session ${details.sessionId}`) : "";
      return new Text(`${sessionLine ? `${theme.fg("muted", "[PTC]")} ${sessionLine}\n` : ""}${result.content.map((c) => (c.type === "text" ? c.text : "")).join("")}`, 0, 0);
    },
  });
}

function pythonExecTool(
  pi: ExtensionAPI,
  sessionManager: PythonSessionManager,
  settings: PtcSettings,
  sessionState: PtcSessionState
): PtcToolDefinition {
  return withActivityLabel({
    name: "python_exec",
    label: "python",
    description: PYTHON_EXEC_DESCRIPTION,
    parameters: Type.Object({
      session_id: Type.String({ description: "Session id from provision_python_session." }),
      code: Type.String({
        description:
          "Python code to execute in the session. Top-level await is supported; do not call asyncio.run(...). Definitions persist across chunks; return a compact final result.",
      }),
    }),
        execute: async (toolCallId, params, signal, onUpdate, ctx) => {
          const { session_id: sessionId, code } = params as {
            session_id: string;
            code: string;
          };
          const recoveryState = getRequestRecoveryState(sessionState);
    
          // background/wait_for modes are WIP (deferred): synchronous runs make the
          // live subagent viewer straightforward. The manager keeps the machinery
          // for when it returns.
    
          // Foreground exec with the recovery flow from the legacy code_execution tool.
      noteCodeExecutionAttempt(recoveryState);
      sessionState.lastCtx = ctx;

      try {
        const execOptions = { cwd: ctx.cwd, ctx, signal, onUpdate, parentToolCallId: toolCallId };
        sessionState.activeForegroundToolCallId = toolCallId;
        sessionState.activeForegroundSessionId = sessionId;

        // Keep the viewer animating during pure awaits: subagent state frames
        // only arrive on registry mutations, so a 120ms repaint ticker merges
        // the latest snapshot into the streamed details (pi-tool-tree does the
        // same for its shimmer).
        let lastUpdate: { content: Array<{ type: "text"; text: string }>; details: ExecutionDetails } | undefined;
        const streamingOnUpdate: typeof onUpdate = (update) => {
          lastUpdate = update as never;
          onUpdate?.(update);
        };
        const repaint = setInterval(() => {
          if (!lastUpdate || !onUpdate) return;
          const snapshot = sessionState.lastSubagentSnapshot ?? lastUpdate.details.subagentSnapshot;
          onUpdate?.({
            content: lastUpdate.content,
            details: { ...lastUpdate.details, subagentSnapshot: snapshot } as ExecutionDetails,
          });
        }, 120);
        repaint.unref?.();

        const execPromise = sessionManager.execForeground(sessionId, code, {
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
        const content: Array<{ type: "text"; text: string } | { type: "image"; mimeType: string; data: string }> = [
          { type: "text", text: result.output || "(No output)" },
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
        noteCodeExecutionFailure(recoveryState);
        throw error;
      } finally {
        sessionState.activeForegroundToolCallId = null;
        sessionState.activeForegroundSessionId = null;
      }
    },
    renderResult(
      result: AgentToolResult<unknown>,
      { isPartial }: ToolRenderResultOptions,
      theme: Theme,
      context?: PartialRenderContext
    ) {
      const details = result.details as ExecutionDetails | undefined;
      if (isPartial && details?.userCode && details.userCode.length > 0) {
        const state = (context?.state ?? {}) as CodeViewState;
        // Progress frames set currentLine; fast execs may complete a line tick
        // before the first render, so default to the top of the chunk.
        const currentLine = details.currentLine && details.currentLine > 0 ? details.currentLine : 1;
        const totalLines = details.totalLines || details.userCode.length;
        const lines = buildExecutingCodeLines(
          details.userCode,
          currentLine,
          totalLines,
          details.activeTool,
          theme,
          state
        );
        // The subagent fan renders below the code view when the chunk spawned
        // subagents through pi_subagents.
        const subagentLines = renderSubagentPanel(details.subagentSnapshot, theme, details.execId);
        if (subagentLines.length > 0) {
          lines.push("");
          lines.push(...subagentLines);
        }
        return new Text(lines.join("\n"), 0, 0);
      }

      const text = result.content
        .filter((content): content is { type: "text"; text: string } => content.type === "text")
        .map((content) => content.text)
        .join("");

      return renderCompletedOutput(text, details, theme);
    },
  });
}

function pythonSessionToScriptTool(sessionManager: PythonSessionManager): PtcToolDefinition {
  return withActivityLabel({
    name: "python_session_to_script",
    label: "python",
    description: SCRIPT_EXPORT_DESCRIPTION,
    parameters: Type.Object({
      session_id: Type.Optional(
        Type.String({ description: "Session id; defaults to the most recent session." })
      ),
      path: Type.Optional(
        Type.String({ description: "Absolute or cwd-relative target file path; defaults to ./.pi/scripts/<name>." })
      ),
      name: Type.Optional(
        Type.String({ description: "Script file name when path is not given; defaults to ptc-session-<session_id>.py." })
      ),
    }),
    execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
      const { session_id: requestedId, path: targetPath, name } = params as {
        session_id?: string;
        path?: string;
        name?: string;
      };
      const summaries = sessionManager.list();
      const sessionId = requestedId ?? summaries[0]?.id;
      if (!sessionId) {
        return { content: [{ type: "text", text: "No python sessions to export. Provision one with provision_python_session first." }], details: {} };
      }
      try {
        const result = await sessionManager.toScript(sessionId, { cwd: ctx.cwd, path: targetPath, name });
        return {
          content: [{
            type: "text",
            text: `Exported ${result.cells} cell${result.cells === 1 ? "" : "s"}${result.wrappedAsync ? " (async-wrapped)" : ""} to ${result.path}. Edit it with edit/write tools and run it with bash.`,
          }],
          details: { sessionId, scriptPath: result.path, cells: result.cells, wrappedAsync: result.wrappedAsync },
        };
      } catch (error) {
        return { content: [{ type: "text", text: describeSessionError(error, sessionManager) }], details: { sessionId } };
      }
    },
    renderResult(result: AgentToolResult<unknown>, { isPartial }: ToolRenderResultOptions, theme: Theme) {
      if (isPartial) {
        return new Text(theme.fg("muted", "Exporting session script..."), 0, 0);
      }
      const details = result.details as { scriptPath?: string } | undefined;
      const pathLine = details?.scriptPath ? theme.fg("success", details.scriptPath) : "";
      const text = result.content.map((c) => (c.type === "text" ? c.text : "")).join("");
      return new Text(`${pathLine ? `${theme.fg("muted", "[PTC]")} ${pathLine}\n` : ""}${text}`, 0, 0);
    },
  });
}

function describeSessionError(error: unknown, sessionManager: PythonSessionManager): string {
  if (error instanceof UnknownSessionError) {
    const summaries = sessionManager.list();
    const sessionLines = summaries.map((s) => `  - ${s.id} (${s.chunks} cells${s.hasPendingBackground ? ", pending background" : ""})`);
    return `${error.message}${sessionLines.length ? `\nLive sessions:\n${sessionLines.join("\n")}` : ""}`;
  }
  return error instanceof Error ? error.message : String(error);
}

// ============================================================================
// /ptc command
// ============================================================================

function resolveTargetSession(
  sessionManager: PythonSessionManager,
  sessionState: PtcSessionState,
  requested?: string
): SessionSummary | { error: string } {
  if (requested) {
    const found = sessionManager.list().find((s) => s.id === requested);
    return found ?? { error: `Unknown python session ${requested}. Live: ${sessionManager.list().map((s) => s.id).join(", ") || "(none)"}` };
  }
  const target =
    (sessionState.activeForegroundSessionId ? sessionManager.list().find((s) => s.id === sessionState.activeForegroundSessionId) : undefined) ??
    sessionManager.mostRecentActive() ??
    sessionManager.list()[0];
  return target ?? { error: "No python sessions. Provision one with provision_python_session first." };
}

function registerPtcCommand(pi: ExtensionAPI, sessionManager: PythonSessionManager, sessionState: PtcSessionState): void {
  pi.registerCommand("ptc", {
    description: "Control PTC python sessions: /ptc <interrupt|kill> [session_id] (background/foreground are WIP)",
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

const SUBAGENT_RUNTIME_KEY = Symbol.for("pi-ptc:subagent-runtime");

interface SubagentRuntimeApi {
  getSnapshot(): {
    sessions: Array<{ sessionId: string; snapshot: SubagentRuntimeSnapshot }>;
    totals: { running: number; settled: number; failed: number };
  } | null;
  subscribe(listener: (payload: { sessionId: string; snapshot: SubagentRuntimeSnapshot }) => void): () => void;
}

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
  const settled = relevant.filter((a) => a.status === "settled").length;
  const bits: string[] = [];
  if (running) bits.push(`● ${running} running`);
  if (settled) bits.push(`✓ ${settled} done`);
  ctx.ui.setStatus("ptc-subagents", `subagents: ${bits.join(" · ")}`);
}

// ============================================================================
// Event handlers
// ============================================================================

async function handleSessionStart(
  customToolManager: CustomToolManager,
  sessionState: PtcSessionState,
  pi: ExtensionAPI,
  toolRegistry: ToolRegistry,
  settings: PtcSettings,
  sessionManager: PythonSessionManager,
  _event: unknown,
  ctx: ExtensionContext
): Promise<void> {
  sessionState.currentCwd = ctx.cwd;
  if (!sessionState.customToolsStarted) {
    await customToolManager.start();
    sessionState.customToolsStarted = true;
  }

  pi.registerTool(provisionPythonSessionTool(pi, sessionManager, sessionState));
  pi.registerTool(pythonExecTool(pi, sessionManager, settings, sessionState));
  pi.registerTool(pythonSessionToScriptTool(sessionManager));
}

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
      "`import pi_subagents` raises NotImplementedError in this environment. `python_exec` " +
      "remains available for computation. Report your final answer as your last message.";
    result = { ...(result ?? {}), systemPrompt: `${result?.systemPrompt ?? event.systemPrompt}\n\n${depthNote}` };
  }

  return result;
}

function handleContext(sessionState: PtcSessionState, event: { messages: Array<Record<string, unknown>> }) {
  if (!sessionState.pendingRecoveryPrompt) {
    return undefined;
  }

  const messages = [...event.messages, buildRecoveryContextMessage(sessionState.pendingRecoveryPrompt)];
  sessionState.pendingRecoveryPrompt = null;
  return { messages };
}

function handleAgentEnd(pi: ExtensionAPI, sessionState: PtcSessionState): void {
  restoreActiveToolsAfterRouting(pi, sessionState);
  sessionState.pendingRecoveryPrompt = null;
  sessionState.recoveryAllowed = true;
  sessionState.recoveryState = null;
}

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

export default async function ptcExtension(pi: ExtensionAPI, context?: ExtensionContext) {
  const settings = loadSettingsFromEnv();
  const extensionRoot = getExtensionRoot();
  const toolRegistry = new ToolRegistry(pi);
  const sandboxManager = await createSandbox(settings);
  const sessionState: PtcSessionState = {
    currentCwd: context?.cwd ?? process.cwd(),
    customToolsStarted: false,
    activeToolsBeforeRouting: null,
    pendingRecoveryPrompt: null,
    recoveryAllowed: true,
    recoveryState: null,
    activeForegroundToolCallId: null,
    activeForegroundSessionId: null,
    lastSubagentSnapshot: null,
    requestedBackground: null,
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
      debugLog(`python_exec interrupt report for ${sessionId}`, text.slice(0, 200));
    },
  });
  (globalThis as Record<string, unknown>).__ptcPythonSessionManager = sessionManager;
  (globalThis as Record<symbol, unknown>)[SUBAGENT_RUNTIME_KEY] = createSubagentRuntime(sessionManager);

  // Provision the pi_subagents runtime in the background: create the PTC venv
  // when missing and install/refresh pi_subagents from git. The sync stamp
  // lives inside this package's clone, so `pi update` (which resets and cleans
  // the clone) triggers a fresh sync on the next session start.
  if (!settings.useDocker && !process.env.PI_SUBAGENT_DEPTH) {
    void ensureSubagentsEnv({ extensionRoot }).catch((error) => {
      debugLog("pi_subagents provisioning failed", String(error));
    });
  }

  registerPtcCommand(pi, sessionManager, sessionState);

  const onToolSetChanged = () => undefined;

  const customToolManager = new CustomToolManager(extensionRoot, pi, toolRegistry, onToolSetChanged);

  const onSessionStart = handleSessionStart.bind(
    undefined,
    customToolManager,
    sessionState,
    pi,
    toolRegistry,
    settings,
    sessionManager
  );
  const onBeforeAgentStart = handleBeforeAgentStart.bind(undefined, pi, toolRegistry, settings, sessionState);
  const onContext = handleContext.bind(undefined, sessionState);
  const onAgentEnd = handleAgentEnd.bind(undefined, pi, sessionState);
  const onSessionShutdown = handleSessionShutdown.bind(undefined, customToolManager, sandboxManager, sessionManager);

  pi.on("session_start", onSessionStart);
  pi.on("before_agent_start", onBeforeAgentStart);
  (pi as unknown as { on(event: "context", handler: typeof onContext): void }).on("context", onContext);
  pi.on("agent_end", onAgentEnd);
  pi.on("session_shutdown", onSessionShutdown);
}
