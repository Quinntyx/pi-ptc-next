import { formatWithOptions } from "util";
import type { PtcSettings } from "./contracts/settings";

/** Default model-visible exec-result preview budget (characters, head+tail combined). */
export const DEFAULT_OUTPUT_PREVIEW_CHARS = 12_000;
/** Runtime-side emergency spool ceiling for total captured cell output (characters, not a model-facing limit). */
export const DEFAULT_MAX_SPOOL_CHARS = 10_000_000;
/** Default max lines returned per read_cell_output page. */
export const DEFAULT_CELL_OUTPUT_LINES = 2_000;
/** Per-page UTF-8 byte cap for cell output; also the overlong-single-line truncation point. */
export const DEFAULT_CELL_OUTPUT_BYTES = 50 * 1024;
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

/**
 * Parse PTC_* environment variables into a PtcSettings (documented defaults
 * applied for unset/invalid values). Also flips process-wide debug logging on
 * when PTC_DEBUG is truthy; call once at extension load.
 */
export function loadSettingsFromEnv(): PtcSettings {
  const settings = {
    executionTimeoutMs: parsePositiveIntEnv(
      process.env.PTC_EXECUTION_TIMEOUT_MS,
      DEFAULT_EXECUTION_TIMEOUT_MS
    ),
    outputPreviewChars: parsePositiveIntEnv(
      process.env.PTC_OUTPUT_PREVIEW_CHARS ?? process.env.PTC_MAX_OUTPUT_CHARS,
      DEFAULT_OUTPUT_PREVIEW_CHARS
    ),
    maxSpoolChars: parsePositiveIntEnv(process.env.PTC_MAX_SPOOL_CHARS, DEFAULT_MAX_SPOOL_CHARS),
    maxParallelToolCalls: parsePositiveIntEnv(
      process.env.PTC_MAX_PARALLEL_TOOL_CALLS,
      DEFAULT_MAX_PARALLEL_TOOL_CALLS
    ),
    debugLogging: parseBooleanEnv(process.env.PTC_DEBUG, false),
    autoRoute: parseBooleanEnv(process.env.PTC_AUTO_ROUTE, true),
    autoRecover: parseBooleanEnv(process.env.PTC_AUTO_RECOVER, false),
    autoRecoverMaxAttempts: parseClampedIntEnv(process.env.PTC_AUTO_RECOVER_MAX_ATTEMPTS, 1, 0, 4),
    callableTools: parseListEnv(process.env.PTC_CALLABLE_TOOLS),
    blockedTools: parseListEnv(process.env.PTC_BLOCKED_TOOLS),
    maxPythonSessions: parseClampedIntEnv(process.env.PTC_MAX_PYTHON_SESSIONS, 4, 1, 32),
    scriptsDir: emptyToUndefined(process.env.PTC_SCRIPTS_DIR),
    subagentFooter: parseBooleanEnv(process.env.PTC_SUBAGENT_FOOTER, true),
  } satisfies PtcSettings;

  debugLoggingEnabled = settings.debugLogging;
  return settings;
}

/**
 * Heuristic mutation-flavor detector over the prompt text. Used to suppress
 * auto-routing to exec_cell and to disallow automatic recovery for
 * mutation-y requests (mutating work stays on the direct tool path).
 */
export function isMutationPrompt(prompt: string): boolean {
  return /\b(edit|write|modify|change|update|fix|create|delete|rename|refactor|patch|implement|add|remove)\b/.test(
    prompt.trim().toLowerCase()
  );
}

/**
 * Heuristic router: true when the prompt looks like a fan-out/aggregation job
 * that belongs in a Python kernel (explicit exec-tool mentions always route;
 * mutation prompts never do). Conservative by design — false negatives are
 * fine, false positives hijack the request.
 */
export function shouldAutoRoutePromptToCodeExecution(prompt: string): boolean {
  const normalized = prompt.trim().toLowerCase();
  if (!normalized) {
    return false;
  }

  // Current tool names (post exec_cell → exec_cell rename); "code_execution"
  // is kept as an alias because prompts often refer to the execution path.
  if (/\b(?:use|call|run|invoke) (?:the )?(?:exec_cell|provision_kernel|inspect_kernel|list_kernels|provision_dependency|code_execution)\b/.test(
    normalized
  )) {
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

function countNewlines(text: string): number {
  let count = 0;
  for (const char of text) {
    if (char === "\n") count += 1;
  }
  return count;
}

// ── Sectioned cell output ────────────────────────────────────────────────────
// The model-visible exec result is composed of host-owned sections. The host
// inserts the section markers at column 0 and indents everything the cell
// produced by two spaces, so provenance is structural (position), not
// prefix-trust: a cell that prints "kernel:" lands *inside* the output section,
// visibly distinct from the real marker.

/**
 * Column-0 section marker names the host composes/parses in exec results.
 * Note the host also emits a `tools:` section (nested-call summary) that is
 * not listed here.
 */
export const OUTPUT_SECTION_NAMES = ["output", "return", "kernel", "subagents", "tools"] as const;

/** Indent a cell-produced body under a column-0 host marker. */
export function sectionize(name: string, body: string): string {
  const trimmed = body.replace(/\r?\n$/, "");
  const indented = trimmed
    .split("\n")
    .map((line) => (line.trim() ? `  ${line}` : ""))
    .join("\n");
  return `${name}:\n${indented}`;
}

export interface OutputSection {
  name: string;
  /** Section body with the two-space cell indent removed. */
  body: string;
}

/**
 * Parse a sectioned result into its sections (dedented). Returns null when the
 * text carries no column-0 section markers (legacy blob or error text) so the
 * caller can render it verbatim.
 */
export function parseSectionedOutput(text: string): OutputSection[] | null {
  const markerRe = /^(output|return|kernel|subagents|tools)\b[^\n]*?:(.*)$/;
  const sections: OutputSection[] = [];
  let current: OutputSection | undefined;
  let sawMarker = false;
  let preamble = "";
  for (const line of text.split("\n")) {
    const match = markerRe.exec(line);
    if (match) {
      sawMarker = true;
      current = { name: match[1], body: match[2] };
      sections.push(current);
      continue;
    }
    if (!current) {
      preamble += `${line}\n`;
      continue;
    }
    current.body += `${line.replace(/^  /, "")}\n`;
  }
  if (!sawMarker) return null;
  void preamble;
  return sections.map((s) => ({ name: s.name, body: s.body.replace(/\n$/, "") }));
}

function previewBounds(output: string, contentChars: number): { headEnd: number; tailStart: number } {
  const headBudget = Math.floor(contentChars * 0.7);
  const tailBudget = contentChars - headBudget;

  let headEnd = output.lastIndexOf("\n", Math.max(0, headBudget));
  let tailStart = output.indexOf("\n", Math.max(0, output.length - tailBudget));
  if (tailStart >= 0) tailStart += 1;

  // A single line has no boundaries to honor. Character slicing is the only
  // bounded representation; read_cell_output applies its overlong-line notice.
  if (headEnd <= 0 || tailStart < 0 || headEnd >= tailStart) {
    headEnd = Math.min(headBudget, output.length);
    tailStart = Math.max(headEnd, output.length - tailBudget);
  }
  return { headEnd, tailStart };
}

function hiddenLineCount(output: string, headEnd: number, tailStart: number): number {
  if (tailStart <= headEnd) return 0;
  const firstHiddenLine = countNewlines(output.slice(0, headEnd)) + (output[headEnd] === "\n" ? 1 : 0);
  const lastHiddenPosition = tailStart - 1;
  const lastHiddenLine = countNewlines(output.slice(0, lastHiddenPosition));
  return Math.max(1, lastHiddenLine - firstHiddenLine + 1);
}

/** Build the bounded model-facing view; the input remains untouched for durable storage. */
export function collapseOutputPreview(output: string, previewChars: number, cellIdx: number): string {
  if (output.length <= previewChars) {
    return output;
  }

  const limit = Math.max(1, Math.floor(previewChars));
  let marker = "";
  let headEnd = 0;
  let tailStart = output.length;

  // Marker digit widths affect the available head/tail budget. A few fixed-point
  // passes settle those widths while preserving the hard preview bound.
  for (let pass = 0; pass < 8; pass += 1) {
    const contentChars = Math.max(0, limit - marker.length - 2);
    ({ headEnd, tailStart } = previewBounds(output, contentChars));
    const hiddenChars = tailStart - headEnd;
    const hiddenLines = hiddenLineCount(output, headEnd, tailStart);
    const nextMarker = `... ${hiddenLines} lines hidden (${hiddenChars} of ${output.length} chars) — full output: read_cell_output(cellIdx=${cellIdx}) ...`;
    if (nextMarker === marker) break;
    marker = nextMarker;
  }

  // Recompute once with the settled marker, then trim only at the inner edges if
  // an unusually tiny configured limit leaves no room for both whole-line sides.
  ({ headEnd, tailStart } = previewBounds(output, Math.max(0, limit - marker.length - 2)));
  let head = output.slice(0, headEnd);
  let tail = output.slice(tailStart);
  let result = `${head}\n${marker}\n${tail}`;
  if (result.length > limit) {
    const excess = result.length - limit;
    const trimHead = Math.min(head.length, Math.ceil(excess * 0.7));
    const trimTail = Math.min(tail.length, excess - trimHead);
    head = head.slice(0, head.length - trimHead);
    tail = tail.slice(trimTail);
    result = `${head}\n${marker}\n${tail}`;
  }
  return result;
}

function truncateUtf8Head(text: string, maxBytes: number): string {
  const buffer = Buffer.from(text, "utf8");
  if (buffer.length <= maxBytes) return text;
  let end = maxBytes;
  while (end > 0 && (buffer[end] & 0xc0) === 0x80) end -= 1;
  return buffer.subarray(0, end).toString("utf8");
}

/**
 * Apply read-like 1-based line slicing and bounded single-line handling:
 * offsets beyond the end throw; a single overlong first line (>
 * DEFAULT_CELL_OUTPUT_BYTES UTF-8 bytes) is head-truncated; pages over
 * DEFAULT_CELL_OUTPUT_LINES lines or DEFAULT_CELL_OUTPUT_BYTES bytes get a
 * continuation notice.
 */
export function sliceCellOutput(
  output: string,
  options: { cellIdx: number; offset?: number; limit?: number }
): string {
  const lines = output.split("\n");
  const offset = Math.max(1, Math.floor(options.offset ?? 1));
  if (offset > lines.length) {
    throw new Error(`Offset ${offset} is beyond end of cell output (${lines.length} lines total)`);
  }

  const requestedLimit = options.limit === undefined
    ? DEFAULT_CELL_OUTPUT_LINES
    : Math.max(1, Math.floor(options.limit));
  const end = Math.min(lines.length, offset - 1 + requestedLimit);
  const selected = lines.slice(offset - 1, end);

  if (selected.length > 0 && Buffer.byteLength(selected[0], "utf8") > DEFAULT_CELL_OUTPUT_BYTES) {
    return `${truncateUtf8Head(selected[0], DEFAULT_CELL_OUTPUT_BYTES)}... [truncated]`;
  }

  const retained: string[] = [];
  let bytes = 0;
  for (const line of selected) {
    const lineBytes = Buffer.byteLength(line, "utf8") + (retained.length > 0 ? 1 : 0);
    if (retained.length >= DEFAULT_CELL_OUTPUT_LINES || bytes + lineBytes > DEFAULT_CELL_OUTPUT_BYTES) break;
    retained.push(line);
    bytes += lineBytes;
  }

  const lastLine = offset + retained.length - 1;
  let result = retained.join("\n");
  if (retained.length < selected.length) {
    result += `\n\n[Showing lines ${offset}-${lastLine} of ${lines.length}. Use offset=${lastLine + 1} to continue.]`;
  } else if (end < lines.length) {
    result += `\n\n[${lines.length - end} more lines in cell output. Use offset=${end + 1} to continue.]`;
  }
  return result;
}

/** Return at most one deterministic nudge for a Python exception/traceback. */
export function pythonErrorHelpHint(errorText: string): string | undefined {
  if (/\b(?:ModuleNotFoundError|ImportError)\b/.test(errorText)) {
    const missing = /No module named ["']([^"']+)["']/.exec(errorText)?.[1]?.split(".")[0];
    return `help: install it with provision_dependency('${missing ?? "<distribution>"}') then re-run`;
  }
  if (/\bNameError\b/.test(errorText)) {
    return "help: name is undefined — define it, or inspect_kernel to see live names (the kernel may have restarted)";
  }
  if (/\bSyntaxError\b/.test(errorText)) {
    return "help: fix the syntax error at the reported line";
  }
  if (/\bFileNotFoundError\b/.test(errorText)) {
    return "help: verify the path exists (read/ls the parent dir)";
  }
  if (/\bAttributeError\b/.test(errorText)) {
    return "help: inspect_kernel to discover the real attribute/API";
  }
  return undefined;
}

/**
 * Append a single deterministic `help:` hint for common Python exceptions to a
 * traceback (or return the hint alone when there is no traceback). Skipped
 * when a help line is already present.
 */
export function appendPythonErrorHelp(traceback: string | undefined, message: string): string | undefined {
  const hint = pythonErrorHelpHint(`${message}\n${traceback ?? ""}`);
  if (!hint || traceback?.split("\n").some((line) => line.startsWith("help:"))) {
    return traceback;
  }
  return traceback ? `${traceback.trimEnd()}\n${hint}` : hint;
}

/** Rough model-token estimate (~4 chars/token, rounded up). */
export function estimateTokensFromChars(chars: number): number {
  return Math.ceil(chars / 4);
}

/**
 * Pre-execution guard for model-authored cells. Throws (before the cell runs)
 * on asyncio.run(...) — top-level await already works — and on direct
 * _rpc_call(...) — generated helpers must be used instead.
 */
export function validateUserCode(userCode: string): void {
  if (/\basyncio\.run\s*\(/.test(userCode)) {
    throw new Error(
      "Top-level await is already available inside exec_cell. Remove asyncio.run(...) and await your coroutines directly."
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

/**
 * Debug logger, gated on the PTC_DEBUG setting captured by
 * loadSettingsFromEnv; writes `[PTC] ...` lines to stdout.
 */
export function debugLog(message: string, ...args: unknown[]): void {
  if (debugLoggingEnabled) {
    process.stdout.write(`${formatLogMessage(message, args)}\n`);
  }
}

/** Emit a process warning tagged with code "PTC" and the same [PTC] prefix. */
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
