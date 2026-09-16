import { formatWithOptions } from "util";
import type { PtcSettings } from "./contracts/settings";

const DEFAULT_MAX_OUTPUT_SIZE = 100_000;
const DEFAULT_EXECUTION_TIMEOUT_MS = 270_000;
const DEFAULT_MAX_PARALLEL_TOOL_CALLS = 8;
const DEBUG_PREFIX = "[PTC]";

let debugLoggingEnabled = false;

function parseBooleanEnv(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) {
    return fallback;
  }

  const normalized = value.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

function parsePositiveIntEnv(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseClampedIntEnv(value: string | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined || value === "") {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  return Math.min(max, Math.max(min, parsed));
}

function parseListEnv(value: string | undefined): string[] | undefined {
  if (!value) {
    return undefined;
  }

  const items = value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);

  return items.length > 0 ? items : undefined;
}

function emptyToUndefined(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

export function loadSettingsFromEnv(): PtcSettings {
  const settings = {
    executionTimeoutMs: parsePositiveIntEnv(
      process.env.PTC_EXECUTION_TIMEOUT_MS,
      DEFAULT_EXECUTION_TIMEOUT_MS
    ),
    maxOutputChars: parsePositiveIntEnv(process.env.PTC_MAX_OUTPUT_CHARS, DEFAULT_MAX_OUTPUT_SIZE),
    allowMutations: parseBooleanEnv(process.env.PTC_ALLOW_MUTATIONS, false),
    allowBash: parseBooleanEnv(process.env.PTC_ALLOW_BASH, false),
    maxParallelToolCalls: parsePositiveIntEnv(
      process.env.PTC_MAX_PARALLEL_TOOL_CALLS,
      DEFAULT_MAX_PARALLEL_TOOL_CALLS
    ),
    useDocker: parseBooleanEnv(process.env.PTC_USE_DOCKER, false),
    allowUnsandboxedSubprocess: parseBooleanEnv(process.env.PTC_ALLOW_UNSANDBOXED_SUBPROCESS, false),
    debugLogging: parseBooleanEnv(process.env.PTC_DEBUG, false),
    autoRoute: parseBooleanEnv(process.env.PTC_AUTO_ROUTE, true),
    autoRecover: parseBooleanEnv(process.env.PTC_AUTO_RECOVER, false),
    autoRecoverMaxAttempts: parseClampedIntEnv(process.env.PTC_AUTO_RECOVER_MAX_ATTEMPTS, 1, 0, 1),
    trustedReadOnlyTools: parseListEnv(process.env.PTC_TRUSTED_READ_ONLY_TOOLS),
    callableTools: parseListEnv(process.env.PTC_CALLABLE_TOOLS),
    blockedTools: parseListEnv(process.env.PTC_BLOCKED_TOOLS),
    maxPythonSessions: parseClampedIntEnv(process.env.PTC_MAX_PYTHON_SESSIONS, 4, 1, 32),
    scriptsDir: emptyToUndefined(process.env.PTC_SCRIPTS_DIR),
    subagentsProfile: emptyToUndefined(process.env.PTC_SUBAGENTS_PROFILE),
    subagentFooter: parseBooleanEnv(process.env.PTC_SUBAGENT_FOOTER, true),
  } satisfies PtcSettings;

  debugLoggingEnabled = settings.debugLogging;
  return settings;
}

export function isMutationPrompt(prompt: string): boolean {
  return /\b(edit|write|modify|change|update|fix|create|delete|rename|refactor|patch|implement|add|remove)\b/.test(
    prompt.trim().toLowerCase()
  );
}

export function shouldAutoRoutePromptToCodeExecution(prompt: string): boolean {
  const normalized = prompt.trim().toLowerCase();
  if (!normalized) {
    return false;
  }

  if (/\b(?:use|call|run|invoke) (?:the )?python_exec\b/.test(normalized)) {
    return true;
  }

  if (isMutationPrompt(normalized)) {
    return false;
  }

  const hasFanout =
    /(?:\*\*\/|\*\.[a-z0-9]+\b|\bglob\b|\bcodebase\b|\brepo\b|\brepository\b|\ball files\b|\bevery file\b|\bentire codebase\b|\bentire repo\b|\bacross (?:the )?(?:repo|codebase)\b|\bfirst \d+\b.*\bfiles?\b|\bmany files\b|\bmultiple files\b|\bfor each\b|\bfor every\b|\beach file\b)/.test(
      normalized
    );

  const hasProcessing =
    /\b(count|group|aggregate|rank|sort|top \d+|summari[sz]e|compare|statistics|histogram|frequency|frequencies|distribution|dedup|filter|tabulate)\b/.test(
      normalized
    );

  const hasContextPressure =
    /\b(compact json|json only|summary only|summaries only|keep intermediate|keep intermediates|stay out of chat|out of chat|without flooding|don't flood)\b/.test(
      normalized
    );

  return (hasFanout && (hasProcessing || hasContextPressure)) || (hasProcessing && hasContextPressure);
}

export function truncateOutput(output: string, maxOutputChars: number = DEFAULT_MAX_OUTPUT_SIZE): string {
  if (output.length <= maxOutputChars) {
    return output;
  }

  const truncated = output.substring(0, maxOutputChars);
  const truncationNotice = `\n\n[Output truncated - showing first ${maxOutputChars} characters of ${output.length}]`;
  return truncated + truncationNotice;
}

export function formatPythonError(message: string, traceback?: string): string {
  if (traceback) {
    return `Python execution error:\n${message}\n\nTraceback:\n${traceback}`;
  }
  return `Python execution error: ${message}`;
}

export function estimateTokensFromChars(chars: number): number {
  return Math.ceil(chars / 4);
}

export function validateUserCode(userCode: string): void {
  if (/\basyncio\.run\s*\(/.test(userCode)) {
    throw new Error(
      "Top-level await is already available inside python_exec. Remove asyncio.run(...) and await your coroutines directly."
    );
  }

  if (/\b_rpc_call\s*\(/.test(userCode)) {
    throw new Error(
      "Use the generated helper functions such as read(), glob(), find(), grep(), ls(), or ptc.read_many() instead of calling _rpc_call(...) directly."
    );
  }
}

function formatLogMessage(message: string, args: unknown[]): string {
  const suffix =
    args.length > 0
      ? ` ${args.map((arg) => formatWithOptions({ colors: false, depth: 4 }, arg)).join(" ")}`
      : "";
  return `${DEBUG_PREFIX} ${message}${suffix}`;
}

export function debugLog(message: string, ...args: unknown[]): void {
  if (debugLoggingEnabled) {
    process.stdout.write(`${formatLogMessage(message, args)}\n`);
  }
}

export function logWarning(message: string, ...args: unknown[]): void {
  process.emitWarning(formatLogMessage(message, args), { code: "PTC" });
}

/**
 * pi-tool-tree labels each tool call with a model-supplied `activity` word and groups
 * neighboring calls by it. It publishes its wrapper on globalThis so other extensions
 * can opt in without a cross-package import, and so the wrapper can be a no-op when
 * that extension is not installed or its `toolActivityParam` setting is off. The
 * wrapper adds an `activity` property to the schema, defaults a missing label, and
 * strips the label again before `execute` receives the arguments.
 */
export function withActivityLabel<T extends object>(tool: T): T {
  const integration = (
    globalThis as unknown as Record<symbol, { wrapTool?: (tool: unknown) => unknown } | undefined>
  )[Symbol.for("pi-tool-tree:activity-api")];
  if (typeof integration?.wrapTool !== "function") {
    return tool;
  }
  return integration.wrapTool(tool) as T;
}
