/**
 * Notebook op renderer — maps every PTC kernel tool result onto the pure
 * cell-view module (`./cell-view`). This is the only layer that knows about
 * pi's render contract; cell-view knows nothing about pi.
 *
 * Design constraints honored here:
 * - **Synchronous, zero-jitter.** No shiki, no async swaps, no
 *   `context.invalidate()` from continuations. Everything renders in one phase;
 *   the output is a pure function of `(toolName, result, options, state)`, so
 *   resumed sessions and ctrl+o toggles reproduce the exact same geometry.
 * - **Width at paint time.** `renderResult` has no width argument, so every
 *   box is built inside `Component.render(width)`: terminal resizes re-truncate
 *   instead of leaving stale-width fences behind.
 * - **Truthful numbering.** `In[N]` uses the execution count the RPC reported
 *   (`details.cellIdx`) for executed cells, the notebook position for
 *   non-executing doc ops, and falls back to the unnumbered `In:` variant when
 *   the frame carries no number. Numbers are never invented.
 * - **Stable geometry.** Shared, theme-keyed Shiki work runs asynchronously;
 *   redraws replace colors without changing raw-text-derived geometry.
 * - **Real fullscreen scrolling.** Each input/output box has its own persistent
 *   wheel-scroll window; regular mode retains terminal scrollback.
 */

import { Text, type Component } from "@earendil-works/pi-tui";
import { NotebookComponent } from "./notebook-component";
import { cachedCellHighlights, cellHighlightKey, highlightCellCode } from "./code-highlight";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { parseSectionedOutput } from "../utils";
import {
  FULLSCREEN_VIEWPORT_LINES,
  renderClearedCell,
  renderDeletedCell,
  renderEditedCell,
  renderInCell,
  renderLabeledBox,
  renderOutCell,
  type BodyRow,
  type CellRenderOptions,
  type ViewportMode,
} from "./cell-view";
import {
  CODE_VIEW_FULL_THRESHOLD,
  CODE_VIEW_HEIGHT,
  computeCodeViewStart,
  type CodeViewState,
} from "./code-view";
import type { ExecutionDetails, NotebookCellSummary, NotebookRunStep } from "../contracts/execution-types";

/** Structural view of the result pi hands to renderResult. */
export interface NotebookToolResult {
  content: Array<{ type: string; text?: string }>;
  details?: unknown;
  isError?: boolean;
}

/** Shared per-row renderer state (pi passes one object per tool row by reference). */
export interface NotebookRenderState {
  /** 1-based first visible code line, carried over from the executing view. */
  viewStartLine?: number;
  scrollPositions?: Record<string, number>;
  /** Call previews yield to the partial/final input box at paint time. */
  resultOwnsInput?: boolean;
  callCode?: string;
  highlights?: Map<string, string[] | null>;
  pendingHighlights?: Set<string>;
}

/** Structural view of pi's ToolRenderResultOptions. */
export interface NotebookRenderOptions {
  expanded?: boolean;
  isPartial?: boolean;
}

/** Structural view of the fourth renderResult argument (context.state). */
export interface NotebookRenderContext {
  state?: NotebookRenderState;
  invalidate?: () => void;
}

/**
 * Op-specific detail fields threaded through by the tool execute() paths on
 * top of the exec details every frame carries.
 */
export interface CellOpDetails extends ExecutionDetails {
  /** write_cell: the written source; delete_cell: the deleted cell's source. */
  cellSource?: string;
  /** write_cell: previous source when an existing cell was replaced. */
  oldCellSource?: string;
  /** write_cell: true when an existing cell was replaced (not appended). */
  replaced?: boolean;
  /** run_cell: 1-based notebook position of the executed cell. */
  runCellIndex?: number;
  /** run_to/run_all: per-cell outcomes in run order. */
  runSteps?: NotebookRunStep[];
  /** run_to/run_all: 1-based position of the first failing cell. */
  failedIndex?: number;
  /** Pre-highlighted code lines (synchronous shiki output), one per code line. */
  highlightLines?: string[];
  /** read_cells / read_cell: the returned cells with sources and outputs. */
  cells?: NotebookCellSummary[];
  /** write_cell: 1-based position written. */
  at?: number;
  /** delete_cell: 1-based position deleted. */
  n?: number;
}

// ---------------------------------------------------------------------------
// Fullscreen / viewport mapping (R1 signal: pi.getSettings().tuiMode)
// ---------------------------------------------------------------------------

export type TuiModeResolver = () => "regular" | "fullscreen" | undefined;

let tuiModeProvider: TuiModeResolver | undefined;

/**
 * Install the live tuiMode resolver. The host passes `() => pi.getSettings().tuiMode`
 * — a per-call structured clone, so every render observes the CURRENT mode even
 * after a regular↔fullscreen switch (pi re-mounts and re-renders all rows on
 * switch). Unset/throwing resolvers collapse to "normal".
 */
export function setNotebookTuiModeProvider(provider: TuiModeResolver | undefined): void {
  tuiModeProvider = provider;
}

/** Map pi's (expanded, tuiMode) pair onto the cell renderer's viewport mode. */
export function currentViewportMode(expanded: boolean): ViewportMode {
  if (expanded) return "expanded";
  let tuiMode: string | undefined;
  try {
    tuiMode = tuiModeProvider?.();
  } catch {
    tuiMode = undefined;
  }
  return tuiMode === "fullscreen" ? "fullscreen" : "normal";
}

// ---------------------------------------------------------------------------
// Plumbing
// ---------------------------------------------------------------------------

/** Width-aware Component: cell boxes are built at paint time, per width. */
function bodyLineCount(text: string): number {
  return text.replace(/\n$/, "").split("\n").length;
}

/** Start async work outside geometry; only the colors change when it finishes. */
function renderHighlights(
  code: string,
  supplied: string[] | undefined,
  theme: Theme,
  state: NotebookRenderState,
  redraw?: () => void,
): string[] | undefined {
  const key = cellHighlightKey(code, theme);
  const cached = cachedCellHighlights(code, theme) ?? state.highlights?.get(key);
  if (cached !== undefined) return cached ?? undefined;
  if (!redraw) return supplied;
  const pending = state.pendingHighlights ??= new Set();
  if (!pending.has(key)) {
    pending.add(key);
    void highlightCellCode(code, theme).then((lines) => {
      pending.delete(key);
      const highlights = state.highlights ??= new Map();
      if (highlights.size >= 8) highlights.clear();
      highlights.set(key, lines);
      redraw();
    });
  }
  return undefined;
}
function resultText(result: NotebookToolResult): string {
  return result.content
    .filter((part): part is { type: "text"; text: string } => part.type === "text")
    .map((part) => part.text)
    .join("");
}

function boxOptions(
  details: CellOpDetails,
  expanded: boolean,
  theme: Theme | undefined,
  state: NotebookRenderState,
): Omit<CellRenderOptions, "width"> {
  return {
    mode: currentViewportMode(expanded),
    theme,
    // Scroll persistence: continue where the executing view left off. The
    // core clamps this into the valid range for the final body length.
    viewStart: state.viewStartLine,
  };
}

// ---------------------------------------------------------------------------
// Executing frames (isPartial): live code view + live Out box
// ---------------------------------------------------------------------------

/**
 * Build the model-visible executing-code view: a header with progress and the
 * active nested tool, then a line-numbered viewport of the cell. For long
 * cells (> CODE_VIEW_FULL_THRESHOLD lines) the viewport follows currentLine
 * via the shared state so scroll position persists across updates.
 */
export function buildExecutingCodeLines(
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
    // The 6-char number field + separator keeps the rail at a constant column
    // for every row. The current line swaps the rail glyph for the marker IN
    // that column (▸ has no wide presentation, unlike ▶).
    const numberField = String(lineNumber).padStart(6, " ");
    let prefix = `${numberField} │ `;
    let content = line;

    if (isCurrentLine) {
      prefix = theme.fg("success", `${numberField} ▸ `);
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

/**
 * Partial-frame component for exec-like tools: the static executing-code view
 * (width-independent, as before) plus the LIVE Out box, which IS width-aware —
 * the box is rebuilt at paint time from Component.render(width) so terminal
 * resizes never leave a stale-width fence behind. `details.liveOutput` carries
 * the emulated stdout screen (\r/EL/cursor moves already interpreted by the
 * session manager); expanded (ctrl+o) shows the full live screen.
 */
/** Streaming (isPartial) frame: executing code view + live output box. */
function renderExecutingFrame(
  toolName: string,
  details: CellOpDetails,
  theme: Theme,
  state: NotebookRenderState,
  expanded: boolean,
  redraw?: () => void,
): Component {
  return new NotebookComponent((width, layout) => {
    const code = (details.userCode ?? []).join("\n");
    const mode = currentViewportMode(expanded);
    const cellNumber = toolName === "scratch_run" ? undefined : details.cellIdx ?? null;
    const opts = { width, mode, cellNumber, theme, labelBackground: "toolPendingBg" as const };
    const lines = layout.box("input", bodyLineCount(code), {
      ...opts, viewStart: state.viewStartLine,
      highlightLines: renderHighlights(code, details.highlightLines, theme, state, redraw),
    }, (options) => renderInCell(code, options));
    if (details.activeTool) lines.push(theme.fg("muted", `· calling ${details.activeTool}()`));
    const liveText = (details.liveOutput ?? []).join("\n");
    const hidden = details.liveOutputHidden ?? 0;
    if (!liveText && !hidden) return lines;
    lines.push("");
    if (hidden > 0) lines.push(theme.fg("muted", `... ${hidden} earlier output lines`));
    const total = bodyLineCount(liveText);
    // Retain the live tail in regular mode; fullscreen additionally allows
    // independent wheel scrolling, suspended while the user inspects history.
    lines.push(...layout.box("output", total, {
      ...opts, mode: expanded ? "expanded" : "fullscreen",
      viewStart: Math.max(1, total - FULLSCREEN_VIEWPORT_LINES + 1),
    }, (options) => renderOutCell(liveText, options), lines.length, true, mode === "fullscreen"));
    return lines;
  }, state, redraw);
}
// ---------------------------------------------------------------------------
// Call phase (renderCall): the In box for the submitted code. During
// execution this same box is what the partial frames render, so the tool
// call never shows a raw/truncated argument dump.
export function renderNotebookCall(
  code: string | undefined,
  options: { width?: number } | undefined,
  theme: Theme,
  context?: NotebookRenderContext,
): Component {
  const state = context?.state ?? {};
  if (code !== undefined) state.callCode = code;
  return new NotebookComponent((width, layout) => {
    // Pi retains both call and result components. Read shared state at PAINT
    // time (after both renderer callbacks), so even the first result replaces
    // this preview without a duplicate or an extra invalidation round.
    if (state.resultOwnsInput) return [];
    const source = code ?? "";
    if (!source.trim()) return [];
    return layout.box("input", bodyLineCount(source), {
      width: options?.width ?? width,
      mode: currentViewportMode(false),
      cellNumber: null,
      theme,
      labelBackground: "toolPendingBg",
      highlightLines: renderHighlights(source, undefined, theme, state, context?.invalidate),
    }, (opts) => renderInCell(source, opts));
  }, state, context?.invalidate);
}
// Completed frames, per op
// ---------------------------------------------------------------------------

/** exec_cell / run_cell / scratch_run: In[N] box + Out[N] box. */
function renderExecCompleted(
  toolName: string,
  result: NotebookToolResult,
  details: CellOpDetails,
  expanded: boolean,
  theme: Theme,
  state: NotebookRenderState,
  redraw?: () => void,
): Component {
  if (details.userCode === undefined && state.callCode === undefined) return renderFallback(result, theme);
  return new NotebookComponent((width, layout) => {
    const opts = boxOptions(details, expanded, theme, state);
    const cellNumber = toolName === "scratch_run" ? undefined : details.cellIdx ?? null;
    const code = details.userCode?.join("\n") ?? state.callCode ?? "";
    const text = outBoxContent(resultText(result)) || "(No output)";
    const outputStyle = result.isError ? "error" as const : text === "(No output)" ? "muted" as const : undefined;
    const labelBackground = result.isError ? "toolErrorBg" as const : "toolSuccessBg" as const;
    const base = { ...opts, width, cellNumber, labelBackground };
    const lines = layout.box("input", bodyLineCount(code), {
      ...base, highlightLines: renderHighlights(code, details.highlightLines, theme, state, redraw),
    }, (options) => renderInCell(code, options));
    lines.push("");
    lines.push(...layout.box("output", bodyLineCount(text), { ...base, viewStart: 1, outputStyle },
      (options) => renderOutCell(text, options), lines.length));
    return lines;
  }, state, redraw);
}
/**
 * Jupyter-style Out content: stdout plus the echoed value, without the
 * model-facing section markers (`kernel:`, `subagents:`, `tools:` digests)
 * and without re-stating `Out[N]:` inside the box — the gutter already says
 * it. Falls back to the raw text when it is not sectioned (plain tracebacks).
 */
function outBoxContent(sectioned: string): string {
  const sections = parseSectionedOutput(sectioned);
  if (!sections) return sectioned.replace(/\n$/, "");
  const parts: string[] = [];
  for (const section of sections) {
    if (section.name === "output") {
      if (section.body.trim()) parts.push(section.body);
    } else if (section.name === "return") {
      // The runtime's echo already prefixes `Out[N]:`; the gutter says it too.
      const body = section.body.replace(/^Out\[\d+\]:\s*/m, "");
      if (body.trim()) parts.push(body);
    }
    // kernel / subagents / tools digests stay out of the notebook Out box.
  }
  return parts.join("\n");
}

/** write_cell: insert → In box; replace → inline diff; replace-with-empty → cleared red. */
function renderWriteCompleted(
  result: NotebookToolResult,
  details: CellOpDetails,
  expanded: boolean,
  theme: Theme,
  state: NotebookRenderState,
  redraw?: () => void,
): Component {
  const source = details.cellSource;
  if (source === undefined) return renderFallback(result, theme);
  return new NotebookComponent((width, layout) => {
    const opts = { ...boxOptions(details, expanded, theme, state), width, cellNumber: null };
    const oldSource = details.oldCellSource;
    if (details.replaced && oldSource !== undefined) {
      if (!source.trim()) return layout.box("input", bodyLineCount(oldSource), opts,
        (options) => renderClearedCell(oldSource, options));
      const count = renderEditedCell(oldSource, source, { ...opts, mode: "expanded" }).length - 2;
      return layout.box("input", count, opts, (options) => renderEditedCell(oldSource, source, options));
    }
    return layout.box("input", bodyLineCount(source), {
      ...opts, highlightLines: renderHighlights(source, undefined, theme, state, redraw),
    }, (options) => renderInCell(source, options));
  }, state, redraw);
}
/** delete_cell: the whole cell — gutter included — in red. */
function renderDeleteCompleted(
  details: CellOpDetails,
  expanded: boolean,
  theme: Theme,
  state: NotebookRenderState,
  redraw?: () => void,
): Component {
  return new NotebookComponent((width, layout) => {
    const source = details.cellSource ?? "(source unavailable)";
    return layout.box("input", bodyLineCount(source), {
      ...boxOptions(details, expanded, theme, state), width, cellNumber: details.n,
    }, (options) => renderDeletedCell(source, options));
  }, state, redraw);
}
/** run_to / run_all: one compact per-cell status list. */
function renderRunBatchCompleted(
  details: CellOpDetails,
  expanded: boolean,
  theme: Theme,
  state: NotebookRenderState,
  redraw?: () => void,
): Component {
  return new NotebookComponent((width, layout) => {
    const rows: BodyRow[] = (details.runSteps ?? []).map((step) => {
      const glyph = step.ok ? "✓" : "✗";
      const target = step.execCount !== undefined ? ` → Out[${step.execCount}]` : "";
      const failure = step.ok ? "" : `: ${firstLine(step.error ?? "failed")}`;
      return { text: `${glyph} cell ${step.index}${target}${failure}`, style: step.ok ? "success" : "error" };
    });
    if (!rows.length) rows.push({ text: "(no code cells executed)", style: "muted" });
    return layout.box("run", rows.length, {
      width, mode: currentViewportMode(expanded), theme,
    }, (options) => renderLabeledBox("Run:", rows, options));
  }, state, redraw);
}
/** reset_kernel: one muted line; the notebook file is untouched. */
function renderResetCompleted(result: NotebookToolResult, theme: Theme): Component {
  const text = resultText(result) || "Kernel restarted: fresh namespace.";
  return new Text(theme.fg("muted", text), 0, 0);
}

/** read_cell: the cell as an In box (line-numbered) plus its Out box when executed. */
function renderReadOneCompleted(
  details: CellOpDetails,
  expanded: boolean,
  theme: Theme,
  state: NotebookRenderState,
  redraw?: () => void,
): Component {
  return new NotebookComponent((width, layout) => {
    const cell = details.cells?.[0];
    if (!cell) return [theme.fg("muted", "(no cell)")];
    const opts = { ...boxOptions(details, expanded, theme, state), width, cellNumber: cell.executionCount };
    const lines = layout.box("input", bodyLineCount(cell.source), {
      ...opts, highlightLines: cell.cellType === "code" ? renderHighlights(cell.source, undefined, theme, state, redraw) : undefined,
    }, (options) => renderInCell(cell.source, options));
    if (cell.outputText) {
      lines.push(...layout.box("output", bodyLineCount(cell.outputText), { ...opts, viewStart: 1 },
        (options) => renderOutCell(cell.outputText, options), lines.length));
    }
    return lines;
  }, state, redraw);
}
/** read_cells: compact per-cell list (headers muted, sources plain). */
function renderReadManyCompleted(
  details: CellOpDetails,
  theme: Theme,
): Component {
  const cells = details.cells ?? [];
  if (cells.length === 0) {
    return new Text(theme.fg("muted", "(no cells)"), 0, 0);
  }
  const lines: string[] = [];
  for (const cell of cells) {
    const out = cell.executionCount !== undefined ? ` · Out[${cell.executionCount}]` : "";
    lines.push(theme.fg("muted", `In[${cell.index}] · ${cell.cellType}${out}`));
    for (const sourceLine of cell.source.replace(/\n$/, "").split("\n")) {
      lines.push(`  ${sourceLine}`);
    }
    if (cell.outputText.length > 0) {
      lines.push(theme.fg("muted", "  Out:"));
      for (const outputLine of cell.outputText.replace(/\n$/, "").split("\n")) {
        lines.push(`  ${outputLine}`);
      }
    }
  }
  return new Text(lines.join("\n"), 0, 0);
}

/** Doc-op failure or frame without op details: muted text, red on error. */
function renderFallback(result: NotebookToolResult, theme: Theme): Component {
  const text = resultText(result) || "(no output)";
  return new Text(result.isError ? theme.fg("error", text) : theme.fg("muted", text), 0, 0);
}

function firstLine(text: string): string {
  const line = text.split("\n", 1)[0] ?? "";
  return line.length > 120 ? `${line.slice(0, 119)}…` : line;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * renderResult for every kernel tool. Total: never throws (a throwing renderer
 * is silently swallowed by the host into a generic fallback).
 */
export function renderNotebookResult(
  toolName: string,
  result: NotebookToolResult,
  options: NotebookRenderOptions,
  theme: Theme,
  context?: NotebookRenderContext,
): Component {
  try {
    const details = (result.details ?? {}) as CellOpDetails;
    const state = (context?.state ?? {}) as NotebookRenderState;
    if (["exec_cell", "run_cell", "scratch_run"].includes(toolName)) {
      state.resultOwnsInput = details.userCode !== undefined || state.callCode !== undefined;
    }
    if (options.isPartial) {
      return renderExecutingFrame(toolName, details, theme, state, options.expanded ?? false, context?.invalidate);
    }
    switch (toolName) {
      case "exec_cell":
      case "run_cell":
      case "scratch_run":
        return renderExecCompleted(toolName, result, details, options.expanded ?? false, theme, state, context?.invalidate);
      case "write_cell":
        return renderWriteCompleted(result, details, options.expanded ?? false, theme, state, context?.invalidate);
      case "delete_cell":
        return renderDeleteCompleted(details, options.expanded ?? false, theme, state, context?.invalidate);
      case "run_to":
      case "run_all":
        return renderRunBatchCompleted(details, options.expanded ?? false, theme, state, context?.invalidate);
      case "reset_kernel":
        return renderResetCompleted(result, theme);
      case "read_cell":
        return renderReadOneCompleted(details, options.expanded ?? false, theme, state, context?.invalidate);
      case "read_cells":
        return renderReadManyCompleted(details, theme);
      default:
        return renderFallback(result, theme);
    }
  } catch {
    // Renderer exceptions are swallowed by the host anyway; degrade to plain
    // text here so the failure is visible and width-correct.
    try {
      return new Text(resultText(result) || "(no output)", 0, 0);
    } catch {
      return new Text("(no output)", 0, 0);
    }
  }
}
