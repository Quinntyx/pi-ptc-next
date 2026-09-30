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
 * - **Plain text only.** The highlighting path (`highlightLines`) exists in
 *   cell-view but is intentionally unused here: the available shiki integration
 *   is async, and async highlighting is exactly the pi-tool-tree jitter bug.
 *   Wiring a *synchronous* highlighter later only changes colors, never
 *   geometry (cell-view derives all geometry from the raw text).
 */

import { Text, type Component } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  FULLSCREEN_VIEWPORT_LINES,
  renderClearedCell,
  renderDeletedCell,
  renderEditedCell,
  renderExecutedCell,
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
}

/** Structural view of pi's ToolRenderResultOptions. */
export interface NotebookRenderOptions {
  expanded?: boolean;
  isPartial?: boolean;
}

/** Structural view of the fourth renderResult argument (context.state). */
export interface NotebookRenderContext {
  state?: NotebookRenderState;
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
class NotebookComponent implements Component {
  constructor(private readonly build: (width: number) => string[]) {}

  render(width: number): string[] {
    return this.build(width);
  }

  invalidate(): void {}
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
class ExecPartialComponent implements Component {
  constructor(
    private readonly headerLines: string[],
    private readonly liveText: string,
    private readonly liveHidden: number,
    private readonly theme: Theme
  ) {}

  render(width: number): string[] {
    const lines = [...this.headerLines];
    if (this.liveText.length === 0 && this.liveHidden === 0) {
      return lines;
    }
    lines.push("");
    if (this.liveHidden > 0) {
      lines.push(this.theme.fg("muted", `... ${this.liveHidden} earlier output lines`));
    }
    const mode = currentViewportMode(false);
    // While streaming, the newest output is at the bottom: tail-pin the
    // fullscreen scroll window instead of starting at line 1.
    const totalLines = this.liveText.length > 0 ? this.liveText.split("\n").length : 0;
    const viewStart =
      mode === "fullscreen" && totalLines > FULLSCREEN_VIEWPORT_LINES
        ? totalLines - FULLSCREEN_VIEWPORT_LINES + 1
        : undefined;
    lines.push(...renderOutCell(this.liveText, { width, mode, viewStart, theme: this.theme }));
    return lines;
  }

  invalidate(): void {}
}

/** Streaming (isPartial) frame: executing code view + live output box. */
function renderExecutingFrame(
  details: CellOpDetails,
  theme: Theme,
  state: NotebookRenderState,
): Component {
  const codeLines = details.userCode ?? [];
  const headerLines =
    codeLines.length > 0
      ? buildExecutingCodeLines(
          codeLines,
          details.currentLine && details.currentLine > 0 ? details.currentLine : 1,
          details.totalLines || codeLines.length,
          details.activeTool,
          theme,
          state,
        )
      : [theme.fg("muted", "Executing Python code…")];
  return new ExecPartialComponent(
    headerLines,
    (details.liveOutput ?? []).join("\n"),
    details.liveOutputHidden ?? 0,
    theme,
  );
}

// ---------------------------------------------------------------------------
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
): Component {
  return new NotebookComponent((width) => {
    const opts = boxOptions(details, expanded, theme, state);
    // scratch_run is a console op, not a notebook cell: unnumbered In:/Out:.
    const cellNumber =
      toolName === "scratch_run"
        ? undefined
        : (details.cellIdx ?? (toolName === "run_cell" ? details.runCellIndex : undefined));
    const code = (details.userCode ?? []).join("\n");
    const text = resultText(result) || "(No output)";
    const outputStyle = result.isError ? ("error" as const) : text === "(No output)" ? ("muted" as const) : undefined;
    return renderExecutedCell(code, text, { ...opts, width, cellNumber, outputStyle });
  });
}

/** write_cell: insert → In box; replace → inline diff; replace-with-empty → cleared red. */
function renderWriteCompleted(
  result: NotebookToolResult,
  details: CellOpDetails,
  expanded: boolean,
  theme: Theme,
  state: NotebookRenderState,
): Component {
  const source = details.cellSource;
  if (source === undefined) {
    // No source threaded (failure or stale frame): plain muted text.
    return renderFallback(result, theme);
  }
  return new NotebookComponent((width) => {
    const opts = boxOptions(details, expanded, theme, state);
    const oldSource = details.oldCellSource;
    if (details.replaced) {
      if (source.trim() === "" && oldSource !== undefined) {
        // Cleared contents: only the cell's internal content goes red.
        return renderClearedCell(oldSource, { ...opts, width, cellNumber: details.at });
      }
      if (oldSource !== undefined) {
        return renderEditedCell(oldSource, source, { ...opts, width, cellNumber: details.at });
      }
      // Old source unavailable (stale frame): render like a fresh write.
      return renderInCell(source, { ...opts, width, cellNumber: details.at });
    }
    return renderInCell(source, { ...opts, width, cellNumber: details.at });
  });
}

/** delete_cell: the whole cell — gutter included — in red. */
function renderDeleteCompleted(
  details: CellOpDetails,
  expanded: boolean,
  theme: Theme,
  state: NotebookRenderState,
): Component {
  return new NotebookComponent((width) => {
    const opts = boxOptions(details, expanded, theme, state);
    const source = details.cellSource ?? "(source unavailable)";
    return renderDeletedCell(source, { ...opts, width, cellNumber: details.n });
  });
}

/** run_to / run_all: one compact per-cell status list. */
function renderRunBatchCompleted(
  details: CellOpDetails,
  expanded: boolean,
  theme: Theme,
): Component {
  return new NotebookComponent((width) => {
    const steps = details.runSteps ?? [];
    const rows: BodyRow[] = steps.map((step) => {
      const glyph = step.ok ? "✓" : "✗";
      const target = step.execCount !== undefined ? ` → Out[${step.execCount}]` : "";
      const failure = step.ok ? "" : `: ${firstLine(step.error ?? "failed")}`;
      return {
        text: `${glyph} cell ${step.index}${target}${failure}`,
        style: step.ok ? ("success" as const) : ("error" as const),
      };
    });
    if (rows.length === 0) {
      rows.push({ text: "(no code cells executed)", style: "muted" });
    }
    return renderLabeledBox("Run:", rows, {
      width,
      mode: currentViewportMode(expanded),
      theme,
    });
  });
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
): Component {
  return new NotebookComponent((width) => {
    const opts = boxOptions(details, expanded, theme, state);
    const cell = details.cells?.[0];
    if (!cell) {
      return [theme.fg("muted", "(no cell)")];
    }
    // Truthful numbering: the cell's recorded execution count, or the
    // unnumbered variant when it has never run.
    const cellNumber = cell.executionCount;
    const lines = renderInCell(cell.source, { ...opts, width, cellNumber });
    if (cell.outputText.length > 0) {
      lines.push(...renderOutCell(cell.outputText, { ...opts, width, cellNumber }));
    }
    return lines;
  });
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
    if (options.isPartial) {
      return renderExecutingFrame(details, theme, state);
    }
    switch (toolName) {
      case "exec_cell":
      case "run_cell":
      case "scratch_run":
        return renderExecCompleted(toolName, result, details, options.expanded ?? false, theme, state);
      case "write_cell":
        return renderWriteCompleted(result, details, options.expanded ?? false, theme, state);
      case "delete_cell":
        return renderDeleteCompleted(details, options.expanded ?? false, theme, state);
      case "run_to":
      case "run_all":
        return renderRunBatchCompleted(details, options.expanded ?? false, theme);
      case "reset_kernel":
        return renderResetCompleted(result, theme);
      case "read_cell":
        return renderReadOneCompleted(details, options.expanded ?? false, theme, state);
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
