import { Type } from "@sinclair/typebox";
import type { ExtensionAPI, ExtensionContext, Theme } from "@mariozechner/pi-coding-agent";
import { Text, type Component } from "@mariozechner/pi-tui";
import { CodeExecutor } from "./code-executor";
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
import { debugLog, isMutationPrompt, loadSettingsFromEnv, shouldAutoRoutePromptToCodeExecution } from "./utils";

function renderExecutingCode(
  codeLines: string[],
  currentLine: number,
  totalLines: number,
  activeTool: string | undefined,
  theme: Theme
): Component {
  const lines: string[] = [];
  const toolBadge = activeTool ? theme.fg("success", ` • calling ${activeTool}()`) : "";
  lines.push(theme.fg("muted", `Executing Python code (line ${currentLine}/${totalLines})`) + toolBadge);
  lines.push("");

  let startIdx = 0;
  let endIdx = codeLines.length;

  if (codeLines.length > 12) {
    startIdx = Math.max(0, currentLine - 4);
    endIdx = Math.min(codeLines.length, startIdx + 10);
    if (endIdx - startIdx < 10 && startIdx > 0) {
      startIdx = Math.max(0, endIdx - 10);
    }
  }

  if (startIdx > 0) {
    lines.push(theme.fg("muted", "      │ ..."));
  }

  for (let index = startIdx; index < endIdx; index++) {
    const lineNumber = index + 1;
    const isCurrentLine = lineNumber === currentLine;
    const line = codeLines[index];
    let prefix = `${String(lineNumber).padStart(5, " ")} │ `;
    let content = line;

    if (isCurrentLine) {
      prefix = theme.fg("success", `  ▶ ${String(lineNumber).padStart(2, " ")} │ `);
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
    lines.push(theme.fg("muted", "      │ ..."));
  }

  return new Text(lines.join("\n"), 0, 0);
}

function renderCompletedOutput(resultText: string, details: ExecutionDetails | undefined, theme: Theme): Component {
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

  const header = theme.fg(
    "muted",
    `[PTC] ${nestedStr}${avoidTok} • ${durationSec}s`
  ) + imgStr;

  const rawBody = resultText || "(No output)";
  const bodyLines = rawBody.split("\n");
  const maxDisplayLines = 25;
  let displayedBody = rawBody;

  if (bodyLines.length > maxDisplayLines) {
    displayedBody = bodyLines.slice(0, maxDisplayLines).join("\n") +
      `\n${theme.fg("muted", `... (${bodyLines.length - maxDisplayLines} more lines omitted in view)`)}`;
  }

  return new Text(`${header}

${displayedBody}`, 0, 0);
}

function buildToolDescription(currentSettings: PtcSettings, callableTools: ToolInfo[]): string {
  const callableHelperLines = describePythonHelpers(callableTools);
  const callable = callableTools.map((tool) => tool.ptc?.pythonName || tool.name).join(", ");
  const dockerBehavior = currentSettings.useDocker
    ? "- Docker isolation is required for this session; if Docker is unavailable, execution fails instead of falling back to subprocess."
    : "- Local subprocess mode is active because PTC_ALLOW_UNSANDBOXED_SUBPROCESS=true. Nested tool policy still applies, but Python itself is not isolated by Docker in this mode.";

  return `Execute Python code with local programmatic tool calling.

Prefer this tool first for repo-wide analysis, repeated lookups, loops, grouping, ranking, counting, filtering, or any task with 3+ dependent tool calls. Use direct tools instead for one-file reads, one-off grep/find calls, or tiny lookups.

Strong signals to use code_execution:
- Scan many files and return counts, grouped summaries, rankings, or compact JSON
- Run the same tool across many inputs and aggregate the results
- Keep large intermediate results out of the chat context

Examples:
- Count imports across src/**/*.ts and return the top 10 packages
- Analyze the first 8 test files and return compact JSON only
- Check many endpoints or records, then return only the failures

Important rules:
- Top-level await is already available. Do not call asyncio.run(...).
- Use generated helpers such as read(), glob(), find(), grep(), ls(), and ptc.* helpers. Do not call _rpc_call(...) directly.
- Return a compact final answer only. If you return a dict/list, it will be JSON-serialized automatically.
- Intermediate tool results stay local to this tool run and are not sent back to the model unless you include them in the final output.
- Prefer compact JSON summaries over raw dumps.
${dockerBehavior}

Prefer these patterns:
- Many file reads from explicit paths: ptc.read_many(paths, max_concurrency=...)
- Find and read an entire tree: ptc.read_tree(pattern=..., path=..., max_files=..., concurrency=...)
- Bounded concurrency for arbitrary coroutines: ptc.gather_limit(coros, limit=...)
- Relative file discovery: glob(...) or ptc.find_files(...)
- Absolute file discovery for later read()/write(): ptc.find_files_abs(...)

Python helpers currently available in this session:
- ${callableHelperLines.join("\n- ")}
- ptc.gather_limit(coros, limit=...) -> list
- ptc.read_many(paths, max_concurrency=..., offset=None, line_limit=None) -> list[str]
- ptc.read_tree(pattern=..., path='.', max_files=1000, concurrency=..., offset=None, line_limit=None) -> list[dict]
- ptc.find_files(pattern='**/*', path='.', max_files=1000) -> list[str]
- ptc.find_files_abs(pattern='**/*', path='.', max_files=1000) -> list[str]
- ptc.read_text(path, offset=None, limit=None) -> str
- ptc.json_dump(value) -> str

Callable tool set for this session: ${callable}

Example:

entries = await ptc.read_tree(pattern="**/*.ts", path="src", max_files=1000, concurrency=6)
return {
  "files": len(entries),
  "sample_lengths": [len(entry["content"]) for entry in entries[:3]],
}`;
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

function buildCodeExecutionTool(
  currentSettings: PtcSettings,
  callableTools: ToolInfo[],
  codeExecutor: CodeExecutor,
  sessionState: PtcSessionState
): PtcToolDefinition {
  return {
    name: "code_execution",
    label: "Code Execution",
    description: buildToolDescription(currentSettings, callableTools),
    parameters: Type.Object({
      code: Type.String({
        description:
          "Python code to execute. Top-level await is supported; do not call asyncio.run(...). Prefer returning a compact final result.",
      }),
    }),
    execute: async (toolCallId, { code }, signal, onUpdate, ctx) => {
      const recoveryState = getRequestRecoveryState(sessionState);
      noteCodeExecutionAttempt(recoveryState);

      try {
        const result = await codeExecutor.execute(code, {
          cwd: ctx.cwd,
          ctx,
          signal,
          onUpdate,
          parentToolCallId: toolCallId,
          recoveryState,
        });

        noteCodeExecutionSuccess(recoveryState);
        const content: Array<{ type: "text"; text: string } | { type: "image"; mimeType: string; data: string }> = [
          { type: "text" as const, text: result.output || "(No output)" },
        ];

        if (result.images && result.images.length > 0) {
          for (const img of result.images) {
            content.push({
              type: "image" as const,
              mimeType: img.mimeType,
              data: img.data,
            });
          }
        }

        return {
          content,
          details: {
            ...result.details,
            imagesCount: result.images?.length || 0,
            telemetry: buildPtcExecutionTelemetry(recoveryState),
            recovery: buildPtcRecoveryDetails(recoveryState),
          },
        };
      } catch (error) {
        if (error instanceof PtcPythonError) {
          const failureClass = classifyCodeExecutionFailure(error.rawMessage, error.traceback, code);
          if (sessionState.recoveryAllowed && failureClass && armAutomaticRecovery(recoveryState, currentSettings, failureClass)) {
            sessionState.pendingRecoveryPrompt = buildCodeExecutionRecoveryPrompt(failureClass);
          }
        }

        noteCodeExecutionFailure(recoveryState);
        throw error;
      }
    },
    renderResult(result, { isPartial }, theme) {
      const details = result.details as ExecutionDetails | undefined;
      if (isPartial && details?.userCode && details.currentLine) {
        return renderExecutingCode(
          details.userCode,
          details.currentLine,
          details.totalLines || details.userCode.length,
          details.activeTool,
          theme
        );
      }

      const text = result.content
        .filter((content): content is { type: "text"; text: string } => content.type === "text")
        .map((content) => content.text)
        .join("");

      return renderCompletedOutput(text, details, theme);
    },
  };
}

interface PtcSessionState {
  currentCwd: string;
  customToolsStarted: boolean;
  activeToolsBeforeRouting: string[] | null;
  pendingRecoveryPrompt: string | null;
  recoveryAllowed: boolean;
  recoveryState: PtcRecoveryState | null;
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
  if (!allTools.some((tool) => tool.name === "code_execution")) {
    return undefined;
  }

  noteAutomaticRouting(getRequestRecoveryState(sessionState));

  const activeTools = pi.getActiveTools();
  const routableToolNames = new Set(toolRegistry.getAutoRoutableToolNames(sessionState.currentCwd, settings));
  const nextActiveTools = activeTools.filter((name) => !routableToolNames.has(name));
  if (!nextActiveTools.includes("code_execution")) {
    nextActiveTools.push("code_execution");
  }

  if (!areToolListsEqual(activeTools, nextActiveTools)) {
    sessionState.activeToolsBeforeRouting = activeTools;
    pi.setActiveTools(nextActiveTools);
    debugLog("Auto-routed prompt to code_execution", { prompt, activeTools, nextActiveTools });
  }

  return {
    systemPrompt:
      `${currentSystemPrompt}\n\n` +
      "This request is a strong fit for code_execution. Prefer calling code_execution first and keep large intermediate results inside Python unless the user explicitly asked to see them.",
  };
}

function restoreActiveToolsAfterRouting(pi: ExtensionAPI, sessionState: PtcSessionState): void {
  if (!sessionState.activeToolsBeforeRouting) {
    return;
  }

  pi.setActiveTools(sessionState.activeToolsBeforeRouting);
  debugLog("Restored active tools after code_execution routing", {
    restored: sessionState.activeToolsBeforeRouting,
  });
  sessionState.activeToolsBeforeRouting = null;
}

function registerCodeExecutionTool(
  pi: ExtensionAPI,
  toolRegistry: ToolRegistry,
  settings: PtcSettings,
  codeExecutor: CodeExecutor,
  currentCwd: string,
  sessionState: PtcSessionState
): void {
  const callableTools = toolRegistry.getCallableTools(currentCwd, settings);
  pi.registerTool(buildCodeExecutionTool(settings, callableTools, codeExecutor, sessionState));
}

function registerCodeExecutionToolForState(
  pi: ExtensionAPI,
  toolRegistry: ToolRegistry,
  settings: PtcSettings,
  codeExecutor: CodeExecutor,
  sessionState: PtcSessionState
): void {
  registerCodeExecutionTool(pi, toolRegistry, settings, codeExecutor, sessionState.currentCwd, sessionState);
}

async function handleSessionStart(
  customToolManager: CustomToolManager,
  sessionState: PtcSessionState,
  pi: ExtensionAPI,
  toolRegistry: ToolRegistry,
  settings: PtcSettings,
  codeExecutor: CodeExecutor,
  _event: unknown,
  ctx: ExtensionContext
): Promise<void> {
  sessionState.currentCwd = ctx.cwd;
  if (!sessionState.customToolsStarted) {
    await customToolManager.start();
    sessionState.customToolsStarted = true;
  }

  registerCodeExecutionTool(pi, toolRegistry, settings, codeExecutor, sessionState.currentCwd, sessionState);
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

  if (typeof event.prompt !== "string") {
    return undefined;
  }

  return applyAutoRouting(pi, toolRegistry, settings, sessionState, event.prompt, event.systemPrompt);
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
  sandboxManager: SandboxManager
): Promise<void> {
  customToolManager.close();
  await sandboxManager.cleanup();
}

export default async function ptcExtension(pi: ExtensionAPI, context?: ExtensionContext) {
  const settings = loadSettingsFromEnv();
  const extensionRoot = getExtensionRoot();
  const toolRegistry = new ToolRegistry(pi);
  const sandboxManager = await createSandbox(settings);
  const codeExecutor = new CodeExecutor(sandboxManager, toolRegistry, settings, extensionRoot);
  const sessionState: PtcSessionState = {
    currentCwd: context?.cwd ?? process.cwd(),
    customToolsStarted: false,
    activeToolsBeforeRouting: null,
    pendingRecoveryPrompt: null,
    recoveryAllowed: true,
    recoveryState: null,
  };

  const onToolSetChanged = registerCodeExecutionToolForState.bind(
    undefined,
    pi,
    toolRegistry,
    settings,
    codeExecutor,
    sessionState
  );
  const customToolManager = new CustomToolManager(extensionRoot, pi, toolRegistry, onToolSetChanged);

  const onSessionStart = handleSessionStart.bind(
    undefined,
    customToolManager,
    sessionState,
    pi,
    toolRegistry,
    settings,
    codeExecutor
  );
  const onBeforeAgentStart = handleBeforeAgentStart.bind(undefined, pi, toolRegistry, settings, sessionState);
  const onContext = handleContext.bind(undefined, sessionState);
  const onAgentEnd = handleAgentEnd.bind(undefined, pi, sessionState);
  const onSessionShutdown = handleSessionShutdown.bind(undefined, customToolManager, sandboxManager);

  pi.on("session_start", onSessionStart);
  pi.on("before_agent_start", onBeforeAgentStart);
  (pi as unknown as { on(event: "context", handler: typeof onContext): void }).on("context", onContext);
  pi.on("agent_end", onAgentEnd);
  pi.on("session_shutdown", onSessionShutdown);
}
