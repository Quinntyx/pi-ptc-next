# Output handling and the code view

## What it does

When the model runs a Python cell through `exec_cell`, the extension decides what the model sees, what the user sees, and what survives on disk. The raw cell output is never sent to the model in full: it is composed into host-owned sections (`output:`, `return (Out[n]):`, `kernel:`, `subagents:`), and anything larger than a configured character budget is collapsed into a head/tail preview that points at the `read_cell_output` tool, which pages through the full output persisted in the notebook. On the user's side, call arguments, running cells, and finished cells share line-numbered `In[N]:` / `Out[N]:` boxes. The pending input preview is replaced by the result, never duplicated. Labels have a one-column transcript inset and a shared three-digit gutter. The host tool-call background covers the entire box, including labels, borders, content, and padding. Cells requested with `confirm: true` show a separate Shiki-highlighted approval popup before execution. Python tracebacks get at most one appended, deterministic `help:` hint.

## How it works

### Sectioned output (model-visible result)

The host — not the cell — composes the result. Section markers (`output`, `return`, `kernel`, `subagents`) sit at column 0 and every line the cell produced is indented two spaces underneath them, so provenance is structural: a cell that prints `kernel:` lands inside the `output:` section and cannot impersonate a real marker (`sectionize`, `parseSectionedOutput` in `src/utils.ts`; `buildFinalOutput` in `src/python-session-manager.ts`).

- `output:` — everything the cell printed to stdout.
- `return (Out[n]):` — the echoed last bare expression, Jupyter `Out[n]` semantics. The header carries the cell number, so it also identifies the cell index for `read_cell_output`.
- `kernel:` — namespace summary (imports/functions/vars) from the runtime.
- `subagents:` — pool progress, only when the cell spawned `pi_subagents` pools.

The cell renderer parses the same sections with `parseSectionedOutput`, displaying printed output and the expression result together in the Out box without repeating host metadata headings. Plain tracebacks or unsectioned error text render verbatim inside that box, subject to the same viewport rules. Preamble lines before the first marker are dropped from the parsed view (the host normally emits marker-first output).

### Head/tail preview collapsing

`collapseOutputPreview` (`src/utils.ts`) caps the model-visible result at `settings.outputPreviewChars` (default 12,000, from `PTC_OUTPUT_PREVIEW_CHARS`). Over the limit, it builds a whole-line preview — roughly 70% head, 30% tail — with a settled marker line:

```
... N lines hidden (M of T chars) — full output: read_cell_output(cellIdx=K) ...
```

The marker's own width eats into the budget, so a fixed-point loop (up to 8 passes) settles the digit widths before the final cut; a configured limit so small that both sides cannot fit is trimmed at the inner edges. The untruncated output is never modified — it is persisted to the notebook and re-read by `read_cell_output`.

### Durable output and `read_cell_output`

Every executed cell is appended to the kernel's `.ipynb`, and the full (uncollapsed) output text is stored in the cell's `metadata.ptc_full_output` (`src/python-runtime/session.py`). `read_cell_output` (`src/index.ts`, `src/python-session-manager.ts`) reads the most recently used notebook-backed kernel, matches the 1-based `cellIdx` against the cell's `execution_count`, and prefers `metadata.ptc_full_output` over the stored stream/`execute_result`/error outputs. Slicing (`sliceCellOutput`) is 1-based like the native read tool:

- Defaults: 2,000 lines / 50 KB per call.
- Continuation hints: `[Showing lines X-Y of Z. Use offset=N to continue.]` — pass that `offset` to keep reading.
- A single line longer than 50 KB is truncated UTF-8-head-safe with a `[truncated]` notice.
- An `offset` past the end is an error, not an empty result.

### Cell boxes: preview, streaming, and completion

`src/execution/notebook-render.ts` uses the pure geometry in `src/execution/cell-view.ts` for every cell phase. Pi retains separate call and result components, so the argument preview yields at paint time as soon as a result owns the input box. Completion updates the pending `In[ ]:` to the runtime's actual execution count; notebook positions are never substituted for execution counts. Writes remain `In[ ]:` until executed, and scratch execution uses unnumbered `In:` / `Out:` labels.

The input and output fences align across one-, two-, and three-digit counts. Labels sit one column in from the transcript edge. The normal pending/success/error tool-call background covers every row across the full box width; ANSI resets in highlighted code or output restore that background. Counts beyond 999 grow the gutter safely rather than overflowing it.

- **Regular, collapsed:** seven body lines and a below-box `... N more lines >...` hint. The terminal owns transcript scrollback.
- **Fullscreen, collapsed:** eight body lines per box. Mouse-wheel events over a box scroll its own window; input and output positions are independent and survive redraws, streamed updates, and resizing. At the window boundary, wheel events fall through to transcript scrolling.
- **Expanded (`ctrl+o`, or click a completed tool):** show the full cell, with no inner scrolling.

Live output follows its newest lines. Scrolling upward in fullscreen pauses tail-following; returning to the bottom resumes it. A capture-limit notice appears above the output when earlier streamed lines are no longer available.

### Syntax highlighting

`src/execution/code-highlight.ts` is shared by argument previews, streaming/finished input boxes, code reads/writes, and the approval popup. It selects GitHub Light or GitHub Dark from the main tool-pane background luma (using the active theme's resolved background color, including terminal defaults), with `PTC_CODE_THEME` as an explicit override. Cached highlights include the theme in their key, so light/dark changes do not reuse stale colors.

Highlighting runs asynchronously and requests a redraw when ready. Geometry always comes from the raw source: the color update never changes row counts, truncation, or fence columns. A failed highlighter leaves readable plain code. The contrast guard retains dark ink on light backgrounds and replaces washed-out colors instead of replacing readable dark colors.

### The approval popup (`confirm: true`)

When the model sets `confirm: true`, `requestCellApproval` shows a boxed preview of the cell code with line numbers, wrapped to terminal width, scrollable over a 24-row viewport (PgUp/PgDn, mouse wheel, Home/End), followed by Approve / Reject / Reject-with-note options (also `y`/`n`/Esc). The code is highlighted with Shiki to ANSI colors (GitHub Light/Dark chosen from the tool-pane background, `PTC_CODE_THEME` to override); if Shiki can't load, it falls back to plain text — the popup never aborts the flow. A rejection (with or without a note) is returned to the model without running the cell; a broken dialog also fails closed. With no UI available (`ctx.hasUI` false), the cell is rejected automatically.

### Python error help hints

On a Python failure, `appendPythonErrorHelp` (`src/utils.ts`) appends at most one deterministic `help:` line to the traceback: `ModuleNotFoundError`/`ImportError` → `provision_dependency('<distribution>')`; `NameError` → define it / `inspect_kernel` (kernel may have restarted); `SyntaxError`, `FileNotFoundError`, `AttributeError` each get a fixed hint. If the traceback already contains a `help:` line, nothing is added.

## Usage

A typical round trip with a large result:

```python
# model calls exec_cell (cell 3 of the kernel):
import pandas as pd
df = pd.read_csv("events.csv")
print(df.describe())
df.groupby("region").sum()   # last bare expression echoes as Out[3]
```

The model receives (abridged):

```
output:
  <describe() output, or the head/tail preview if it exceeds 12,000 chars>
  ... 812 lines hidden (34,551 of 41,203 chars) — full output: read_cell_output(cellIdx=3) ...

return (Out[3]):
  region    amount    count
  ...

kernel:
  imports: pandas; vars: df (DataFrame); cells: 3
```

To page through the full durable output:

```json
{ "tool": "read_cell_output",
  "params": { "cellIdx": 3, "offset": 1, "limit": 2000 } }
```

```
<first 2,000 lines>

[Showing lines 1-2000 of 2812. Use offset=2001 to continue.]
```

For a destructive cell, the model sets `confirm: true` on `exec_cell`; the user sees the highlighted code in the approval box and can approve, reject, or reject with a note that goes back to the model.

## Options / configuration

| Env var | Default | Effect |
| --- | --- | --- |
| `PTC_OUTPUT_PREVIEW_CHARS` | `12000` | Max chars of the model-visible exec result before head/tail collapsing. `PTC_MAX_OUTPUT_CHARS` is accepted as a legacy alias. |
| `PTC_MAX_SPOOL_CHARS` | `10000000` | Emergency per-cell capture ceiling against runaway memory; only output beyond this unusually large guard is discarded. Not a normal preview limit. |
| `PTC_CODE_THEME` | automatic GitHub Light/Dark | Override the shared cell/approval Shiki theme. Any supported Shiki theme name works; failed highlighting falls back to plain code. |
| `PTC_DEBUG` | off | Writes `[PTC]`-prefixed debug lines (including Shiki fallback reasons) to stdout. |

Label, border, diff, and error colors come from the active Pi theme. Code syntax colors come from the shared Shiki highlighter, chosen for the active tool-pane background.

## Standalone setup notes

- **Shiki is bundled, but highlight failure is silent.** `shiki` is a regular dependency of the package, so the approval popup works out of the box. Under the extension's jiti-based TypeScript loader the ESM import is shimmed specially; if highlighting ever fails you get plain text and, with `PTC_DEBUG=1`, a `[PTC] shiki unavailable...` line. No action needed.
- **`PTC_CODE_THEME` must be a valid Shiki theme name** (e.g. `github-dark`, `github-light`, `one-dark-pro`). An invalid name logs a debug message and falls back to plain text; it does not crash the popup.
- **Subagent panel and shimmer are self-contained.** The `subagents:` section, the workflow rollup, the footer status, and the shimmer animation only appear when the cell actually spawned `pi_subagents` pools. The shimmer painter is vendored into pi-pycells (`src/execution/shimmer.ts`) and renders identically without pi-activity; installing pi-activity only adds live agent activity labels and tool-call activity words.
- **Cell numbering includes sourced prefix cells.** If a kernel was provisioned with a `source` notebook, prefix cells (including markdown) count toward numbering — with 7 source cells, the first new cell is 8. `read_cell_output` matches the `execution_count` shown in `Out[n]` and previews, so use those numbers, not the position in the file.
- **The full output lives in the notebook file.** `read_cell_output` reads the `.ipynb` bound to the most recently used kernel. If you moved or deleted the notebook mid-session, paging fails with a `could not read notebook ...` error; keep the file in place until the session ends.
