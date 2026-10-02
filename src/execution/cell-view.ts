/**
 * Notebook-style cell renderer — the pure foundation module.
 *
 * Renders `In[N]:` / `Out[N]:` cells as square boxes fenced with box-drawing
 * characters. The `In[N]:` / `Out[N]:` prefix floats in the LEFT GUTTER,
 * outside the fence; line numbers sit inside the box (behavior copied
 * minimally from pi-tool-tree's line-number rendering — number field padded to
 * the widest visible number so the fence never shifts — without its async
 * shiki path or split-diff machinery).
 *
 * Hard constraints honored here:
 * - **Synchronous only.** There is no async highlighting in this module. Callers
 *   that have a shiki highlighter pass pre-highlighted lines via
 *   `highlightLines` (one string per code line, same visible text). Without
 *   them the renderer falls back to plain text. Because geometry (line count,
 *   gutter width, fence columns) is derived exclusively from the raw text,
 *   both paths produce byte-identical geometry — only colors differ.
 * - **No host state or I/O.** Theme/color and terminal-width helpers are the
 *   only dependencies; a missing theme degrades to fully unstyled text.
 *
 * Long lines are HARD-TRUNCATED (never wrapped) to the available interior
 * width with a trailing `…` marker. Wrapping was rejected: it multiplies row
 * counts, would have to be duplicated exactly across the highlighted and plain
 * paths, and is the suspected root cause of pi-tool-tree's scrolling jitter.
 * Tabs are expanded to 4 spaces before any measurement.
 */

import type { Theme, ThemeBg } from "@earendil-works/pi-coding-agent";
import {
	backgroundAnsi,
	mixColors,
	parseColor,
	truncateToWidth as tuiTruncateToWidth,
	visibleWidth as tuiVisibleWidth,
} from "@earendil-works/pi-tui";

/** Body lines shown in the collapsed, fullscreen (scrollable) In-box window. */
export const FULLSCREEN_VIEWPORT_LINES = 8;
/** Body lines shown collapsed in normal (non-fullscreen) mode, plus a `... N more lines >...` hint. */
export const NORMAL_VIEWPORT_LINES = 7;

/**
 * How much of the cell body to draw. The mapping from pi's actual fullscreen /
 * ctrl+o state arrives at the integration layer; this module models the three
 * modes explicitly.
 */
export type ViewportMode = "fullscreen" | "normal" | "expanded";

export interface CellRenderOptions {
  /**
   * Cell number N for `In[N]:` / `Out[N]:`.
   * - a number → the execution count (Jupyter's `In[N]:`).
   * - `null` → the cell exists but has not (yet) been executed: Jupyter's
   *   empty `In[ ]:` gutter. Use for write/edit renders.
   * - omitted → the unnumbered variant (`In:`), used for `scratch_run`.
   */
  cellNumber?: number | null;
  /**
   * Pad the cell number to this many digits so separately rendered cells
   * (e.g. a `run_all` sequence) keep their fences in one column even when
   * digit counts differ. Defaults to three digits (grows safely past 999).
   */
  cellNumberWidth?: number;
  /** Background for the entire cell box, matching the host tool-call state. */
  labelBackground?: ThemeBg;
  /**
   * Total render width: gutter + fence + content must fit inside it.
   * The interior is truncated (never wrapped) to this width.
   */
  width: number;
  /** Viewport mode (see {@link ViewportMode}). */
  mode: ViewportMode;
  /**
   * 1-based first visible body line for the fullscreen scroll window.
   * Only meaningful in `fullscreen` mode when the body exceeds
   * FULLSCREEN_VIEWPORT_LINES lines; ignored otherwise.
   */
  viewStart?: number;
  /**
   * Pre-highlighted body content, one entry per body line, with the SAME
   * visible text as the plain lines. Synchronous shiki output goes here.
   * If the array length does not match, the plain text is rendered instead
   * (never a mixed/shorter render).
   */
  highlightLines?: string[];
  /** Active pi theme; undefined renders fully unstyled text. */
  theme?: Theme;
  /**
   * Uniform style for Out-box rows (renderOutCell only). `error` turns the
   * whole output red for failed executions.
   */
  outputStyle?: BodyStyle;
}

/** A single logical row of a cell body, before viewport slicing. */
export interface BodyRow {
  /** Visible text (may carry ANSI, e.g. a pre-highlighted code line). */
  text: string;
  /** Color/attribute treatment for the row. */
  style?: BodyStyle;
  /** Line number printed in the box's number field; null/undefined for none. */
  num?: number | null;
}

export type BodyStyle = "plain" | "muted" | "added" | "removed" | "error" | "warning" | "success";

interface StyleAttrs {
  fg?: "muted" | "toolDiffAdded" | "toolDiffRemoved" | "error" | "warning" | "success";
  strike?: boolean;
}

const STYLE_ATTRS: Record<BodyStyle, StyleAttrs> = {
  plain: {},
  muted: { fg: "muted" },
  added: { fg: "toolDiffAdded" },
  removed: { fg: "toolDiffRemoved", strike: true },
  error: { fg: "error" },
  warning: { fg: "warning" },
  success: { fg: "success" },
};

// ---------------------------------------------------------------------------
// Text measurement helpers (ANSI-aware, dependency-free)
// ---------------------------------------------------------------------------

/**
 * Visible width of a line, in terminal cells. Delegated to pi-tui, whose
 * implementation is grapheme-aware (Intl.Segmenter, East-Asian-width table,
 * ANSI/OSC stripping, memoized) — counting code points mis-sizes emoji and
 * ZWJ sequences, which shifts the right fence out of alignment.
 */
export function visibleWidth(text: string): number {
  return tuiVisibleWidth(text);
}

/** Expand tabs to 4 spaces so widths are stable regardless of terminal tab stops. */
function expandTabs(text: string): string {
  return text.replace(/\t/g, "    ");
}

/**
 * Hard-truncate `text` to `maxWidth` visible cells, preserving ANSI escapes
 * encountered before the cut, and mark the cut with a trailing `…`.
 * This is the ONLY long-line strategy in the module (no wrapping).
 */
function truncateVisible(text: string, maxWidth: number): string {
	if (maxWidth <= 0) return "";
	// pi-tui's truncation is grapheme-aware (an emoji tail truncates to the
	// ellipsis without splitting the cluster) and ANSI-escape preserving.
	return tuiTruncateToWidth(text, maxWidth, "\u2026");
}

/** Split cell text into body lines, dropping the single trailing empty line. */
function splitBodyLines(text: string): string[] {
  const lines = expandTabs(text).split("\n");
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

function digits(n: number): number {
  return Math.max(1, String(Math.max(0, Math.trunc(n))).length);
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

// ---------------------------------------------------------------------------
// Styling
// ---------------------------------------------------------------------------

function applyStyle(text: string, style: BodyStyle | undefined, theme: Theme | undefined): string {
  if (!theme) return text;
  const attrs = STYLE_ATTRS[style ?? "plain"];
  if (!attrs.fg && !attrs.strike) return text;
  let inner = text;
  if (attrs.strike) inner = `\x1b[9m${inner}\x1b[29m`;
  let styled = theme.fg(attrs.fg ?? "text", inner);
  // Diff rows get a subtle background wash, like a GitHub diff: the theme's
  // own diff color mixed ~18% over the theme's intended background (light
  // themes wash toward white, dark toward black), so it stays quiet. Theme
  // stubs without the color API degrade to fg-only styling.
  if (style === "added" || style === "removed") {
    try {
      const token = style === "added" ? "toolDiffAdded" : "toolDiffRemoved";
      const diffColor = theme.colors?.[token];
      if (diffColor) {
        const base = parseColor(theme.appearance === "dark" ? "#1a1a1a" : "#fbfbf8");
        const wash = mixColors(diffColor, base, 0.82);
        styled = backgroundAnsi(wash, theme.getColorMode?.() ?? "truecolor") + styled + "\x1b[49m";
      }
    } catch {
      // fg-only fallback
    }
  }
  return styled;
}

// ---------------------------------------------------------------------------
// Diff (minimal unified line diff — NOT pi-tool-tree's split diff)
// ---------------------------------------------------------------------------

export type DiffRowKind = "context" | "del" | "add";

/** One row of a minimal unified line diff. `num` is the old (del) or new (context/add) line number. */
export interface DiffRow {
  kind: DiffRowKind;
  text: string;
  num: number;
}

/**
 * Minimal LCS-based line diff. Removed lines first (old numbering), then added
 * lines (new numbering) at each hunk boundary — matching pi's diff
 * conventions where removals are shown above their replacements.
 * Inputs larger than the DP guard render as a full replace (all old lines
 * removed, all new lines added) rather than allocating an O(n·m) matrix.
 */
export function diffLines(oldText: string, newText: string): DiffRow[] {
  const a = splitBodyLines(oldText);
  const b = splitBodyLines(newText);
  const n = a.length;
  const m = b.length;

  if (n * m > 4_000_000) {
    return [
      ...a.map((text, i) => ({ kind: "del" as const, text, num: i + 1 })),
      ...b.map((text, i) => ({ kind: "add" as const, text, num: i + 1 })),
    ];
  }

  // dp[i][j] = LCS length of a[i..] and b[j..]
  const dp: Uint32Array[] = new Array(n + 1);
  for (let i = 0; i <= n; i++) dp[i] = new Uint32Array(m + 1);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }

  const rows: DiffRow[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      rows.push({ kind: "context", text: a[i]!, num: j + 1 });
      i++;
      j++;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      rows.push({ kind: "del", text: a[i]!, num: i + 1 });
      i++;
    } else {
      rows.push({ kind: "add", text: b[j]!, num: j + 1 });
      j++;
    }
  }
  while (i < n) {
    rows.push({ kind: "del", text: a[i]!, num: i + 1 });
    i++;
  }
  while (j < m) {
    rows.push({ kind: "add", text: b[j]!, num: j + 1 });
    j++;
  }
  return rows;
}

function diffRowsToBodyRows(rows: DiffRow[]): BodyRow[] {
  return rows.map((row) => ({
    text: row.text,
    style: row.kind === "del" ? "removed" : row.kind === "add" ? "added" : "plain",
    num: row.num,
  }));
}

// ---------------------------------------------------------------------------
// Box renderer
// ---------------------------------------------------------------------------

interface BoxSpec {
  /** Gutter label for this box, e.g. `In[12]:`, `Out[3]:`, `In:`. */
  label: string;
  /**
   * Gutter width shared by every box in the same render (visible cells of the
   * longest label), so In and Out fences align vertically.
   */
  labelWidth: number;
  /** One-column transcript inset for In/Out cells; generic boxes stay unchanged. */
  leftPadding?: number;
  /** Host tool background, applied across the entire box (including its gutter). */
  labelBackground?: ThemeBg;
  /** Width of the line-number field (digits), 0 for no line numbers. */
  lineNumberWidth: number;
  /** Body rows, already viewport-sliced. */
  rows: BodyRow[];
  /** Hidden body lines; > 0 in normal mode appends the `... N more lines >...` hint. */
  hidden: number;
  width: number;
  theme?: Theme;
  /** Whole-cell red (delete op): gutter, fence and content all error-styled. */
  wholeCellError?: boolean;
  /** Content-only red (clear op): fence and gutter stay normal. */
  contentError?: boolean;
  /** Show the `... N more lines >...` hint below the box (collapsed normal mode only). */
  showMoreHint?: boolean;
}

const FENCE_TOP_LEFT = "┌";
const FENCE_TOP_RIGHT = "┐";
const FENCE_BOTTOM_LEFT = "└";
const FENCE_BOTTOM_RIGHT = "┘";
const FENCE_LEFT = "│";
const FENCE_RIGHT = "│";
const HORIZONTAL = "─";

/** Restore the enclosing box background after content resets, without overwriting diff washes. */
function restoreBackground(text: string, background: string): string {
  return text.replace(/\x1b\[([0-9;]*)m/g, (escape, parameters: string) => {
    const codes = parameters === "" ? [0] : parameters.split(";").map(Number);
    let reset = false;
    for (let i = 0; i < codes.length; i++) {
      if (codes[i] === 0 || codes[i] === 49) reset = true;
      else if ((codes[i]! >= 40 && codes[i]! <= 47) || (codes[i]! >= 100 && codes[i]! <= 107)) reset = false;
      else if (codes[i] === 38 || codes[i] === 48 || codes[i] === 58) {
        if (codes[i] === 48) reset = false;
        // RGB/indexed color arguments can contain 0/49; they are not SGR resets.
        if (codes[i + 1] === 2) i += 4;
        else if (codes[i + 1] === 5) i += 2;
      }
    }
    return reset ? escape + background : escape;
  });
}

function renderBox(spec: BoxSpec): string[] {
  const { label, labelWidth, lineNumberWidth, rows, hidden, width, theme } = spec;

  const gutterChars = Math.max(visibleWidth(label), labelWidth);
  const leftPadding = spec.leftPadding ?? 0;
  const prefixWidth = leftPadding + gutterChars + 1; // gutter + separating space before the fence
  const interior = Math.max(1, width - prefixWidth - 2);
  const numberField = lineNumberWidth > 0 ? lineNumberWidth + 1 : 0;
  // The rail column (+ its separating space) sits between the line-number
  // field and the content, in both In and Out boxes.
  const railWidth = numberField > 0 ? 2 : 0;
  const contentWidth = Math.max(1, interior - numberField - railWidth);

  const gutterText = (text: string, style: BodyStyle = "muted"): string =>
    spec.wholeCellError ? applyStyle(text, "error", theme) : applyStyle(text, style, theme);

  const gutterFor = (isLabelRow: boolean): string => {
    const text = isLabelRow ? label.padEnd(gutterChars, " ") : " ".repeat(gutterChars);
    return " ".repeat(leftPadding) + gutterText(text) + " ";
  };

  const fenceBody = (left: string, right: string): string =>
    gutterText(left + HORIZONTAL.repeat(interior) + right);

  const lines: string[] = [];
  // The label does not sit on the fence row: it is pushed down one line so it
  // aligns with the box's upper-left corner — the first character of the first
  // content row.
  lines.push(gutterFor(false) + fenceBody(FENCE_TOP_LEFT, FENCE_TOP_RIGHT));

  rows.forEach((row, rowIndex) => {
    const numText =
      numberField > 0 ? String(row.num ?? "").padStart(lineNumberWidth) + " " : "";
    const content = truncateVisible(row.text, contentWidth);
    let style = row.style ?? "plain";
    if (spec.contentError || spec.wholeCellError) style = "error";
    // Pad the content out to the full interior width so the right fence sits
    // in the same column on every row (visible-width aware: content may be
    // pre-highlighted and carry ANSI escapes).
    const padding = " ".repeat(Math.max(0, contentWidth - visibleWidth(content)));
    const numStyle = style === "plain" ? "muted" : style;
    // The label rides the first content row; later rows keep a blank gutter.
    const labelGutter = rowIndex === 0 ? gutterFor(true) : gutterFor(false);
    // Vertical rail between the line-number field and the content.
    const rail = numberField > 0 ? applyStyle("│", "muted", theme) + " " : "";
    lines.push(
      labelGutter +
        gutterText(FENCE_LEFT) +
        gutterText(numText, numStyle) +
        rail +
        applyStyle(content, style, theme) +
        padding +
        gutterText(FENCE_RIGHT),
    );
  });

  if (rows.length === 0) {
    // An empty body still gets its label row so the gutter is never lost.
    lines.push(gutterFor(true) + gutterText(FENCE_LEFT) + gutterText(FENCE_RIGHT));
  }

  lines.push(gutterFor(false) + fenceBody(FENCE_BOTTOM_LEFT, FENCE_BOTTOM_RIGHT));

  if (hidden > 0 && spec.showMoreHint) {
    lines.push(
      " ".repeat(prefixWidth) +
        applyStyle(`... ${hidden} more lines >...`, "muted", theme),
    );
  }

  if (!spec.labelBackground || !theme?.bg) return lines;
  const background = theme.getBgAnsi?.(spec.labelBackground);
  return lines.map((line) => {
    const padded = line + " ".repeat(Math.max(0, width - visibleWidth(line)));
    const content = background ? restoreBackground(padded, background) : padded;
    return theme.bg(spec.labelBackground!, content);
  });
}

// ---------------------------------------------------------------------------
// Viewport
// ---------------------------------------------------------------------------

interface ViewportResult {
  rows: BodyRow[];
  hidden: number;
}

/** Slice body rows per the viewport rules in the feature spec. */
export function applyViewport(
  rows: BodyRow[],
  mode: ViewportMode,
  viewStart?: number,
): ViewportResult {
  if (mode === "expanded") return { rows, hidden: 0 };
  const cap = mode === "fullscreen" ? FULLSCREEN_VIEWPORT_LINES : NORMAL_VIEWPORT_LINES;
  if (rows.length <= cap) return { rows, hidden: 0 };
  if (mode === "fullscreen") {
    const start = clamp(viewStart ?? 1, 1, rows.length - cap + 1);
    return { rows: rows.slice(start - 1, start - 1 + cap), hidden: rows.length - cap };
  }
  return { rows: rows.slice(0, cap), hidden: rows.length - cap };
}

// ---------------------------------------------------------------------------
// Shared option plumbing
// ---------------------------------------------------------------------------

function gutterLabels(opts: CellRenderOptions, kind: "in" | "out"): { label: string; labelWidth: number } {
  const numbered = opts.cellNumber !== undefined;
  const numberPart =
    opts.cellNumber === null ? "[ ]" : numbered ? `[${opts.cellNumber}]` : "";
  const label = (kind === "in" ? "In" : "Out") + numberPart + ":";
  // The gutter width must fit the widest label that ANY cell rendered with the
  // same cellNumberWidth setting can produce, so In and Out fences align
  // vertically (`Out[N]:` is one cell wider than `In[N]:`) and separately
  // rendered cells keep one fence column as cell numbers gain digits.
  const cellDigits = Math.max(
    opts.cellNumberWidth ?? 3,
    numbered && opts.cellNumber !== null ? digits(opts.cellNumber!) : 1,
  );
  const widest = visibleWidth(`Out[${"9".repeat(cellDigits)}]:`);
  return { label, labelWidth: Math.max(visibleWidth(label), widest) };
}

function lineNumberWidthFor(totalLines: number): number {
  // Computed from the FULL line count (not the visible window) so scrolling
  // from 1-digit into 2-digit line numbers never shifts the fence.
  return digits(totalLines);
}

function codeBodyRows(code: string, opts: CellRenderOptions): BodyRow[] {
  const lines = splitBodyLines(code);
  const highlighted =
    opts.highlightLines && opts.highlightLines.length === lines.length ? opts.highlightLines : undefined;
  return lines.map((line, index) => ({
    text: highlighted ? expandTabs(highlighted[index]!) : line,
    style: "plain",
    num: index + 1,
  }));
}

function buildBox(
  rows: BodyRow[],
  opts: CellRenderOptions,
  kind: "in" | "out",
  extras?: { lineNumberWidth?: number; wholeCellError?: boolean; contentError?: boolean; showLineNumbers?: boolean },
): string[] {
  const { label, labelWidth } = gutterLabels(opts, kind);
  const viewport = applyViewport(rows, opts.mode, opts.viewStart);
  return renderBox({
    label,
    labelWidth,
    leftPadding: 1,
    labelBackground: opts.labelBackground ?? "toolSuccessBg",
    lineNumberWidth: extras?.showLineNumbers === false ? 0 : (extras?.lineNumberWidth ?? lineNumberWidthFor(rows.length)),
    rows: viewport.rows,
    hidden: viewport.hidden,
    width: opts.width,
    theme: opts.theme,
    wholeCellError: extras?.wholeCellError,
    contentError: extras?.contentError,
    // The scrollable fullscreen box moves through the body via `viewStart`
    // instead of the hint; only the non-fullscreen collapsed view gets one.
    showMoreHint: opts.mode === "normal",
  });
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Render the `In[N]:` code box (fresh write, exec input, or standalone).
 * With no `cellNumber` the unnumbered `In:` variant is produced (scratch_run).
 */
export function renderInCell(code: string, opts: CellRenderOptions): string[] {
  return buildBox(codeBodyRows(code, opts), opts, "in");
}

/**
 * Render the `Out[N]:` output box. Output lines are numbered, with the same
 * viewport rules
 * apply so a chatty cell cannot blow up the collapsed view.
 */
export function renderOutCell(output: string, opts: CellRenderOptions): string[] {
  const rows = splitBodyLines(output).map((line, i) => ({
    text: line,
    num: i + 1,
    style: (opts.outputStyle ?? "plain") as BodyStyle,
  }));
  return buildBox(rows, opts, "out");
}

/**
 * Render an executed cell: the `In[N]:` block followed by the `Out[N]:` block,
 * sharing one gutter width so the fences line up.
 */
export function renderExecutedCell(code: string, output: string, opts: CellRenderOptions): string[] {
  return [...renderInCell(code, opts), ...renderOutCell(output, opts)];
}

/**
 * Render an edited cell: the `In[N]:` box with the content rendered as an
 * inline (unified) diff — removed lines red + strikethrough, added lines
 * green, context plain (pi's diff conventions). Viewport rules apply to the
 * diff rows.
 */
export function renderEditedCell(oldCode: string, newCode: string, opts: CellRenderOptions): string[] {
  const rows = diffRowsToBodyRows(diffLines(oldCode, newCode));
  // Number field sized from BOTH sides' totals so the fence is stable no
  // matter which diff rows end up visible.
  const total = Math.max(splitBodyLines(oldCode).length, splitBodyLines(newCode).length);
  return buildBox(rows, opts, "in", { lineNumberWidth: lineNumberWidthFor(total) });
}

/**
 * Render a deleted cell: the ENTIRE cell — including the `In[N]:` gutter —
 * is error-red.
 */
export function renderDeletedCell(code: string, opts: CellRenderOptions): string[] {
  return buildBox(codeBodyRows(code, opts), opts, "in", { wholeCellError: true });
}

/**
 * Render a cell whose contents were cleared: only the internal content is
 * error-red; the gutter and fence stay normal.
 */
export function renderClearedCell(code: string, opts: CellRenderOptions): string[] {
  return buildBox(codeBodyRows(code, opts), opts, "in", { contentError: true });
}

/**
 * Render a generically labeled box (no `In[N]:`/`Out[N]:` semantics) for ops
 * that are not a single cell — e.g. the run_to/run_all per-cell status list
 * (`Run:` box). No line numbers unless `showLineNumbers` is set. Viewport
 * rules and the collapsed `... N more lines >...` hint apply as usual.
 */
export function renderLabeledBox(
  label: string,
  rows: BodyRow[],
  opts: {
    width: number;
    mode: ViewportMode;
    theme?: Theme;
    viewStart?: number;
    showLineNumbers?: boolean;
  },
): string[] {
  const viewport = applyViewport(rows, opts.mode, opts.viewStart);
  return renderBox({
    label,
    labelWidth: visibleWidth(label),
    lineNumberWidth: opts.showLineNumbers ? lineNumberWidthFor(rows.length) : 0,
    rows: viewport.rows,
    hidden: viewport.hidden,
    width: opts.width,
    theme: opts.theme,
    showMoreHint: opts.mode === "normal",
  });
}

/**
 * Styled `... N more lines >...` hint for integrators composing their own
 * collapsed layouts (already appended automatically by the box renderer in
 * collapsed normal mode).
 */
export function moreLinesHint(hidden: number, theme?: Theme): string {
  return applyStyle(`... ${hidden} more lines >...`, "muted", theme);
}
