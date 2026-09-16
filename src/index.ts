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

function renderExecutingCode(
  codeLines: string[],
  currentLine: number,
  totalLines: number,
  activeTool: string | undefined,
  theme: Theme,
  state: CodeViewState
): Component {
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

  return new Text(lines.join("\n"), 0, 0);
}

function renderSubagentPanel(snapshot: SubagentRuntimeSnapshot | undefined, theme: Theme): string[] {
  if (!snapshot || !Array.isArray(snapshot.agents) || snapshot.agents.length === 0) {
    return [];
  }

  const totals = snapshot.totals ?? {};
  const running = totals.running ?? snapshot.agents.filter((a) => a.status === "running" || a.status === "starting").length;
  const settled = totals.settled ?? snapshot.agents.filter((a) => a.status === "settled").length;
  const failed = totals.failed ?? snapshot.agents.filter((a) => ["failed", "dead", "stopped"].includes(a.status)).length;

  const lines: string[] = [];
  const parts: string[] = [];
  if (running) parts.push(theme.fg("success", `● ${running} running`));
  if (settled) parts.push(theme.fg("success", `✓ ${settled} done`));
  if (failed) parts.push(theme.fg("warning", `! ${failed} stopped/failed`));
  lines.push(theme.fg("muted", "subagents: ") + parts.join(theme.fg("muted", " · ")));

  for (const agent of snapshot.agents) {
    const seconds = agent.elapsedMs !== undefined ? `${(agent.elapsedMs / 1000).toFixed(1)}s` : "";
    const calls = agent.toolCalls !== undefined && agent.toolCalls !== null ? `${agent.toolCalls} call${agent.toolCalls === 1 ? "" : "s"}` : "";
    const thinking = agent.thinkingMs ? `thinking ${(agent.thinkingMs / 1000).toFixed(1)}s` : "";
    const label = agent.label ?? agent.phase;
    const bits = [seconds, calls, thinking, label].filter(Boolean).join(" · ");
    const marker = agent.status === "settled"
      ? theme.fg("success", "✓")
      : agent.status === "running" || agent.status === "starting"
        ? theme.fg("success", "●")
        : theme.fg("warning", "!");
    lines.push(` ${theme.fg("muted", "├")} ${marker} ${agent.name}${bits ? theme.fg("muted", `  ${bits}`) : ""}`);
  }

  return lines;
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

  const subagentLines = renderSubagentPanel(details.subagentSnapshot, theme);
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
2. python_exec — run code chunks in that session. Imports, definitions, and variables persist across chunks. The cumulative code can be exported as a durable script at any time.
3. python_session_to_script — write the session's cumulative code to a script file on disk, then edit/run it with normal tools.

Prefer python_exec for repo-wide analysis, repeated lookups, loops, grouping, ranking, counting, filtering, or any task with 3+ dependent tool calls. Use direct tools for one-file reads, one-off grep/find calls, or tiny lookups.

python_exec options:
- Default: blocking execution with streaming progress. No hidden backgrounding — background runs are opt-in.
- background: true — queue the chunk and return immediately; the result arrives later as a [ptc-background-complete] message.
- wait_for: "<exec_id>" — block until a previously backgrounded exec completes and return its result.

python_exec can also orchestrate pi subagents via the autoimported pi_subagents module (AgentHandle / AgentSession); subagent status is rendered live under the code view while the session runs.

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

const PROVISION_DESCRIPTION = `Start a persistent Python interpreter session and return its id. Code chunks sent to python_exec share one namespace, so imports and definitions persist.

Takes an optional path to a Python file that is executed first, so the session can start from a prebuilt script (for example one exported earlier via python_session_to_script) and continue working in the resulting environment.`;

const PYTHON_EXEC_DESCRIPTION = `Execute Python code in a persistent session. Chunks run in one shared namespace: imports, functions, and variables from earlier chunks remain available.

Options:
- session_id (required): id from provision_python_session. Unknown ids error with the list of live sessions.
- background (optional): run the chunk without blocking; the result arrives as a [ptc-background-complete] message. Use for long-running work (e.g. waiting on pi_subagents fan-outs) so the session stays responsive.
- wait_for (optional): exec id of a backgrounded chunk in this session; blocks until it completes and returns its result.

Rules:
- Top-level await is available; do not call asyncio.run(...).
- Return a compact final result; a returned dict/list is JSON-serialized automatically.
- Intermediate tool results stay local unless printed or returned.
- Errors do not kill the session: fix and retry in the same namespace.`;

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
      background: Type.Optional(
        Type.Boolean({
          description:
            "Run without blocking: the tool returns immediately with an exec id and the result arrives later as a [ptc-background-complete] message. Use for long-running work such as pi_subagents fan-outs.",
        })
      ),
      wait_for: Type.Optional(
        Type.String({
          description: "Exec id of a backgrounded chunk in this session; blocks until it completes and returns its result.",
        })
      ),
    }),
    execute: async (toolCallId, params, signal, onUpdate, ctx) => {
      const { session_id: sessionId, code, background, wait_for: waitFor } = params as {
        session_id: string;
        code: string;
        background?: boolean;
        wait_for?: string;
      };
      const recoveryState = getRequestRecoveryState(sessionState);

      // Background / wait_for paths do not stream the code view.
      if (background === true) {
        try {
          const { execId } = await sessionManager.execBackground(sessionId, code, { cwd: ctx.cwd, ctx, signal, onUpdate, parentToolCallId: toolCallId });
          return {
            content: [{
              type: "text",
              text: `Backgrounded exec ${execId} in session ${sessionId}. The result arrives as a [ptc-background-complete] message; retrieve it early with python_exec wait_for: "${execId}" if needed.`,
            }],
            details: { sessionId, execId, backgrounded: true },
          };
        } catch (error) {
          return { content: [{ type: "text", text: describeSessionError(error, sessionManager) }], details: { sessionId } };
        }
      }

      if (waitFor) {
        try {
          const result = await sessionManager.waitForExec(sessionId, waitFor);
          return { content: [{ type: "text", text: result.output || "(No output)" }], details: { ...result.details, sessionId, waitedFor: waitFor } };
        } catch (error) {
          return { content: [{ type: "text", text: describeSessionError(error, sessionManager) }], details: { sessionId } };
        }
      }

      // Foreground exec with the recovery flow from the legacy code_execution tool.
      noteCodeExecutionAttempt(recoveryState);
      sessionState.lastCtx = ctx;

      // /ptc background issued before this call starts: go straight to background.
      if (sessionState.requestedBackground === sessionId) {
        sessionState.requestedBackground = null;
        try {
          const { execId } = await sessionManager.execBackground(sessionId, code, { cwd: ctx.cwd, ctx, signal, onUpdate, parentToolCallId: toolCallId });
          return {
            content: [{ type: "text", text: `User manually backgrounded this ptc run (exec ${execId} in session ${sessionId}). The result arrives as a [ptc-background-complete] message.` }],
            details: { sessionId, execId, backgrounded: true, manuallyBackgrounded: true },
          };
        } catch (error) {
          return { content: [{ type: "text", text: describeSessionError(error, sessionManager) }], details: { sessionId } };
        }
      }

      try {
        const execOptions = { cwd: ctx.cwd, ctx, signal, onUpdate, parentToolCallId: toolCallId };
        sessionState.activeForegroundToolCallId = toolCallId;
        sessionState.activeForegroundSessionId = sessionId;
        const execPromise = sessionManager.execForeground(sessionId, code, execOptions);

        // Manual backgrounding race: /ptc background converts the in-flight run.
        let manualBackgroundWatch: ReturnType<typeof setInterval> | undefined;
        const manualBackgroundPromise = new Promise<"manual-background">((resolve) => {
          manualBackgroundWatch = setInterval(() => {
            if (sessionState.requestedBackground === sessionId) {
              clearInterval(manualBackgroundWatch);
              sessionState.requestedBackground = null;
              resolve("manual-background");
            }
          }, 250);
          manualBackgroundWatch.unref?.();
        });
        const outcome = await Promise.race([
          execPromise.then(
            () => "done" as const,
            () => "error" as const
          ),
          manualBackgroundPromise,
        ]);
        if (outcome === "manual-background") {
          const execId = await sessionManager.markBackgrounded(sessionId);
          noteCodeExecutionSuccess(recoveryState);
          return {
            content: [{
              type: "text",
              text: execId
                ? `User manually backgrounded this ptc run. Exec ${execId} continues in session ${sessionId}; the result arrives as a [ptc-background-complete] message.`
                : "User manually backgrounded this ptc run (no exec in flight).",
            }],
            details: { sessionId, execId: execId ?? undefined, backgrounded: true, manuallyBackgrounded: true },
          };
        }

        const result = await execPromise;
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
      if (isPartial && details?.userCode && details.currentLine) {
        const state = (context?.state ?? {}) as CodeViewState;
        const codeComponent = renderExecutingCode(
          details.userCode,
          details.currentLine,
          details.totalLines || details.userCode.length,
          details.activeTool,
          theme,
          state
        ) as unknown as { text?: string };
        // The subagent panel rides below the code view.
        const subagentLines = renderSubagentPanel(details.subagentSnapshot, theme);
        if (subagentLines.length === 0) {
          return codeComponent as unknown as Component;
        }
        const existing = (codeComponent as unknown as { text?: string })?.text ?? "";
        return new Text(`${existing}\n${subagentLines.join("\n")}`, 0, 0);
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
    description: "Control PTC python sessions: /ptc <background|bg|foreground|fg|kill> [session_id]",
    handler: async (args: string | undefined, ctx: ExtensionCommandContext) => {
      const [actionRaw, requestedId] = (args ?? "").trim().split(/\s+/);
      const action = (actionRaw ?? "").toLowerCase();

      if (!["background", "bg", "foreground", "fg", "kill"].includes(action)) {
        ctx.ui.notify("usage: /ptc <background|bg|foreground|fg|kill> [session_id]", "error");
        return;
      }

      const target = resolveTargetSession(sessionManager, sessionState, requestedId);
      if ("error" in target === false && !("id" in target)) {
        ctx.ui.notify(String(target), "error");
        return;
      }
      if ("error" in target) {
        ctx.ui.notify(target.error, "error");
        return;
      }
      const sessionId = target.id;

      if (action === "background" || action === "bg") {
        if (sessionState.activeForegroundSessionId !== sessionId || !sessionState.activeForegroundToolCallId) {
          ctx.ui.notify(`/ptc background: no blocking python_exec in flight in session ${sessionId}`, "error");
          return;
        }
        // The running execute() observes this and converts to a background run.
        sessionState.requestedBackground = sessionId;
        ctx.ui.notify(`Backgrounding python_exec in session ${sessionId}...`, "info");
        return;
      }

      if (action === "foreground" || action === "fg") {
        const pending = sessionManager.pendingBackground(sessionId).filter((entry) => entry.status === "pending");
        if (pending.length === 0) {
          ctx.ui.notify(`/ptc foreground: no pending backgrounded exec in session ${sessionId}`, "error");
          return;
        }
        const execId = pending[pending.length - 1].execId;
        pi.sendMessage(
          {
            customType: "ptc-foreground",
            content: `Bring backgrounded exec ${execId} (session ${sessionId}) back to the foreground: call python_exec with session_id "${sessionId}" and wait_for "${execId}", then report its result.`,
            display: true,
          },
          { triggerTurn: true, deliverAs: "steer" }
        );
        ctx.ui.notify(`Foregrounding exec ${execId} in session ${sessionId}`, "info");
        return;
      }

      // kill
      try {
        await sessionManager.dispose(sessionId);
        ctx.ui.notify(`Disposed python session ${sessionId}`, "info");
      } catch (error) {
        ctx.ui.notify(`Failed to dispose session ${sessionId}: ${error instanceof Error ? error.message : String(error)}`, "error");
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
    onSubagentSnapshot: (sessionId, snapshot) => {
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

function updateSubagentFooter(sessionState: PtcSessionState, settings: PtcSettings): void {
  if (!settings.subagentFooter) {
    return;
  }
  const ctx = sessionState.lastCtx;
  if (!ctx?.hasUI) {
    return;
  }
  const snapshot = sessionState.lastSubagentSnapshot;
  if (!snapshot || snapshot.agents.length === 0) {
    ctx.ui.setStatus("ptc-subagents", undefined);
    return;
  }
  const running = snapshot.totals?.running ?? snapshot.agents.filter((a) => a.status === "running" || a.status === "starting").length;
  const settled = snapshot.totals?.settled ?? snapshot.agents.filter((a) => a.status === "settled").length;
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
    onSubagentSnapshot: (_sessionId, snapshot) => {
      sessionState.lastSubagentSnapshot = snapshot;
      updateSubagentFooter(sessionState, settings);
    },
  });
  (globalThis as Record<string, unknown>).__ptcPythonSessionManager = sessionManager;
  (globalThis as Record<symbol, unknown>)[SUBAGENT_RUNTIME_KEY] = createSubagentRuntime(sessionManager);

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
