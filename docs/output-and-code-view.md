# Output handling and the code view

## What it does

When the model runs a Python cell through `exec_cell`, the extension decides what the model sees, what the user sees, and what survives on disk. The raw cell output is never sent to the model in full: it is composed into host-owned sections (`output:`, `return (Out[n]):`, `kernel:`, `subagents:`), and anything larger than a configured character budget is collapsed into a head/tail preview that points at the `read_cell_output` tool, which pages through the full output persisted in the notebook. On the user's side, a running cell renders as a line-numbered code view with a marker on the executing line (scrollable windowing for long cells, plus a live subagent panel), a finished cell renders with a `[PTC]` summary header and rule-separated sections, and cells requested with `confirm: true` pop up a Shiki-syntax-highlighted approval box before anything runs. Python tracebacks get at most one appended, deterministic `help:` hint.

## How it works

### Sectioned output (model-visible result)

The host — not the cell — composes the result. Section markers (`output`, `return`, `kernel`, `subagents`) sit at column 0 and every line the cell produced is indented two spaces underneath them, so provenance is structural: a cell that prints `kernel:` lands inside the `output:` section and cannot impersonate a real marker (`sectionize`, `parseSectionedOutput` in `src/utils.ts`; `buildFinalOutput` in `src/python-session-manager.ts`).

- `output:` — everything the cell printed to stdout.
- `return (Out[n]):` — the echoed last bare expression, Jupyter `Out[n]` semantics. The header carries the cell number, so it also identifies the cell index for `read_cell_output`.
- `kernel:` — namespace summary (imports/functions/vars) from the runtime.
- `subagents:` — pool progress, only when the cell spawned `pi_subagents` pools.

The renderer parses this same text back into sections with `parseSectionedOutput`; if no column-0 markers are present (a stale runtime producing a legacy blob, or plain error text), the body renders verbatim with a 25-line display cap. Preamble lines before the first marker are dropped from the parsed view (in practice the host always emits marker-first output).

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

### Completed-cell rendering

Finished calls render with a muted `[PTC]` header: nested tool calls vs `local logic`, `~N tokens saved`, duration, figure count, and session id (with `(backgrounded)` when applicable) — `renderCompletedOutput` in `src/index.ts`. Sectioned results get rule-separated blocks drawn to the terminal width, ordered with the `kernel:` namespace summary last; workflow cells additionally get a per-pool/stage rollup (`[workflow] ✓ 4/4 done` plus per-stage lines) and a subagent panel between `return` and `kernel`.

### The executing code view

While a cell streams, partial renders show a line-numbered view of the cell with a `▶` marker on the executing line and ` • calling <tool>()` when a nested host tool is in flight (`buildExecutingCodeLines` in `src/index.ts`). Windowing:

- Cells of 12 lines or fewer (`CODE_VIEW_FULL_THRESHOLD`) are shown in full.
- Longer cells get a 10-line window (`CODE_VIEW_HEIGHT`) with a scroll-margin model (`src/execution/code-view.ts`): the marker keeps at least 3 lines (`CODE_VIEW_MARGIN`) from the window edges, and the content only scrolls when the marker would enter the margin — so loop iterations move the marker while the code stays still, and long jumps scroll just enough.
- Scroll position persists across partial updates: pi passes the same `state` object to every render of one tool call, and the view stores `viewStartLine` in it.

A 120 ms repaint ticker re-emits the last streamed update (merging in the latest subagent snapshot) so the view keeps animating during pure `await`s with no new frames; it is cleared in a `finally` block.

### The approval popup (`confirm: true`)

When the model sets `confirm: true`, `requestCellApproval` shows a boxed preview of the cell code with line numbers, wrapped to terminal width, scrollable over a 24-row viewport (PgUp/PgDn, mouse wheel, Home/End), followed by Approve / Reject / Reject-with-note options (also `y`/`n`/Esc). The code is highlighted with Shiki to ANSI colors (`github-dark` theme by default, `PTC_CODE_THEME` to change); if Shiki can't load, it falls back to plain text — the popup never aborts the flow. A rejection (with or without a note) is returned to the model without running the cell; a broken dialog also fails closed. With no UI available (`ctx.hasUI` false), the cell is rejected automatically.

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
| `PTC_CODE_THEME` | `github-dark` | Shiki theme used by the approval popup. Any Shiki theme name works; if loading fails, highlighting falls back to plain text for that request (and retries next time). |
| `PTC_DEBUG` | off | Writes `[PTC]`-prefixed debug lines (including Shiki fallback reasons) to stdout. |

Colors in the code view, `[PTC]` header, and approval box come from the active pi theme's semantic colors (`muted`, `accent`, `success`, `warning`, `dim`), not from the Shiki theme — only the approval popup's syntax highlighting uses Shiki tokens.

## Standalone setup notes

- **Shiki is bundled, but highlight failure is silent.** `shiki` is a regular dependency of the package, so the approval popup works out of the box. Under the extension's jiti-based TypeScript loader the ESM import is shimmed specially; if highlighting ever fails you get plain text and, with `PTC_DEBUG=1`, a `[PTC] shiki unavailable...` line. No action needed.
- **`PTC_CODE_THEME` must be a valid Shiki theme name** (e.g. `github-dark`, `github-light`, `one-dark-pro`). An invalid name logs a debug message and falls back to plain text; it does not crash the popup.
- **Subagent panel and shimmer are self-contained.** The `subagents:` section, the workflow rollup, the footer status, and the shimmer animation only appear when the cell actually spawned `pi_subagents` pools. The shimmer painter is vendored into pi-pycells (`src/execution/shimmer.ts`) and renders identically without pi-tool-tree; installing pi-tool-tree only adds live agent activity labels and tool-call activity words.
- **Cell numbering includes sourced prefix cells.** If a kernel was provisioned with a `source` notebook, prefix cells (including markdown) count toward numbering — with 7 source cells, the first new cell is 8. `read_cell_output` matches the `execution_count` shown in `Out[n]` and previews, so use those numbers, not the position in the file.
- **The full output lives in the notebook file.** `read_cell_output` reads the `.ipynb` bound to the most recently used kernel. If you moved or deleted the notebook mid-session, paging fails with a `could not read notebook ...` error; keep the file in place until the session ends.
