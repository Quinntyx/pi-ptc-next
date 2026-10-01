---
name: notebook-workflow
description: "Use when producing, exploring in, or handing over a Jupyter notebook
  with pi-pycells - choosing between scratch_run / exec_cell / write_cell /
  run_cell / run_to / run_all / reset_kernel, deciding cell granularity, authoring
  markdown narrative, or polishing a notebook so it runs clean top-to-bottom from a
  fresh kernel. NOT for single-cell throwaway checks or non-notebook Python work."
metadata:
  type: procedure
---

# Contract

## Input Contract

- A pi-pycells kernel from `provision_kernel`, bound to a real `.ipynb`.
- A durable work item (analysis, benchmark, reusable workflow) or scratch
  exploration the user may later want to keep.
- An explicit notebook path inside the project for work worth keeping. An
  omitted/`/tmp` notebook is throwaway — the provision result reports its path.

## Output Contract

- A notebook that runs top-to-bottom from a fresh kernel, with current outputs,
  a config cell at the top, guarded effect cells, and markdown that explains *why*.
- Scratch the user did not ask to keep stays out of the notebook (use `scratch_run`).
- No secrets in cells, outputs, or metadata.

# Which operation

**The desync model — read this first.** The live kernel namespace and the
notebook file are independent. Cell positions are 1-based notebook indices;
`Out[n]` is execution order, which can diverge from position. Running cell *n*
does **not** require cells 1..*n*-1 to have run. After you edit an earlier cell,
every later cell's stored output is stale relative to its source, and the kernel
may hold values from code that is no longer in the notebook. `run_to` /
`run_all` / `reset_kernel` exist to resync; `inspect_kernel` shows what the
namespace actually holds. Never assume the kernel matches the notebook.

| Operation | Use it when | Notebook effect | Kernel effect |
| --- | --- | --- | --- |
| `provision_kernel` | You need a kernel (once per task). | Creates/opens the `.ipynb`. | Fresh namespace. |
| `scratch_run(code)` | Explore: try an import, check a shape, iterate on a value. | **Nothing is appended.** | Mutates the namespace. |
| `write_cell(at, source, type=...)` | Author content: add or replace a cell (`type="markdown"` for prose). | Inserts/replaces at position `at`; a replaced cell's outputs are cleared as stale; saved immediately. | None. |
| `run_cell(n)` | Execute the cell you just wrote or edited, at its position. **The main execution path** — write one cell, run one cell. | Updates that cell's outputs. | Mutates the namespace. |
| `run_to(n)` | Jump to a cell: rebuild 1..*n* after `reset_kernel()`, or resync to a specific point when otherwise needed. **Not the routine driver for freshly written cells.** | Refreshes outputs for 1..*n*. | Rebuilds namespace from those cells. |
| `run_all()` | Resync the whole notebook (the run-before-handover op). | Refreshes all outputs. | Rebuilds the full namespace. |
| `reset_kernel()` | You need a clean namespace. | Untouched. | Restarts the interpreter. |
| `exec_cell(code)` | You have proven code and want it **both executed and appended** as a new cell. | Appends a new code cell with outputs. | Mutates the namespace. |
| `delete_cell(n)` | Remove a cell. | Deletes it. | None. |
| `read_cells` / `read_cell` | Curate: read cell sources and current outputs. | None. | None. |
| `inspect_kernel` | See what the namespace actually holds (names, types, funcs). | None. | None. |

`write_cell` both inserts a new cell and replaces the one at `at` — it is the
only in-place source editor, and it never executes anything.

**Canonical flows**

- *Fresh scripted work:* `scratch_run` to explore → `write_cell` the proven
  version → `run_cell` it. This is the default authoring loop.
- **Write one cell, run one cell.** The main execution path is
  `write_cell(n)` → `run_cell(n)`, repeated per cell — or `exec_cell` when
  proven code should run and append in one move. Do not write many cells and
  then drive them with `run_to`/`run_all`: executing cell-by-cell keeps every
  step's output next to its cell and surfaces failures where they happen.
- *`run_to(n)` is a jump, not a driver:* use it to reach a particular cell
  after `reset_kernel()` (rerun 1..*n* to rebuild state) or when resync is
  otherwise needed — never as the routine way to execute freshly written
  cells.
- *Resync after edits:* `reset_kernel()` (optional) → `run_all()` → check the
  outputs. Before handover, always do this.
- *Never* narrate a scratch session into the notebook cell by cell; that is
  what `scratch_run` is for.

# Cell granularity

- **One cell = one meaningful step / logical unit of work.** Not one idea per
  cell (too small), not a whole pipeline in one cell. *(community guidance:
  PLOS Ten Simple Rules; STScI style guide)*
- **Treat ~100 lines (one screen) as a hard ceiling.** If a cell is longer, split
  it at a real boundary. *(community guidance: PLOS)*
- **Do not park long function/class definitions in one giant cell.** Give
  definitions their own short cell(s), then a short cell that calls and
  demonstrates them. *(nbdev)*
- **Do not emit a cell per one-liner.** Merge short fragments that serve one step
  into a single coherent cell. *(PLOS; Pimentel et al.)*
- **Imports go in one dedicated cell near the top**, before anything that uses
  them.
- **Config and parameters go in a top cell.** Keep every path/tuning knob there
  (and tag the cell `parameters` when the notebook is meant to be parameterized),
  so a re-run only needs that cell edited. *(papermill)*
- **Prefer dedicated definition cells plus short execution cells** that call
  them, over copied top-level mutation. Wrap anything you would copy twice in a
  function. *(Pimentel; PLOS Rule 4)*
- **A cell's last expression should be the value you want displayed**; the host
  echoes it `Out[n]`-style. When a cell doubles as a test, end it with
  `assert`/equality rather than a `print`. *(nbdev)*
- **Heavy IO and long-running pipelines do not belong in durable cells** — they
  make the notebook unrepeatable. Explore them with `scratch_run`, and in the
  notebook either read a saved artifact or move the pipeline into a module the
  cell calls. *(Good Research Code Handbook)*
- **No hidden state.** Do not rely on out-of-order execution or deleted cells.
  Before handover the notebook must run 1..N clean from a fresh kernel.
  *(Pimentel et al.: out-of-order and skipped-execution notebooks are the norm
  and are a top reproducibility failure.)*

# Markdown narrative

Markdown is authored when the notebook is being polished or delivered, **not**
narrated cell-by-cell during scratch work. During exploration, `scratch_run` and
your chat commentary are enough. When you make a notebook durable, write the
narrative.

- **Prose carries WHY; code comments carry mechanics; outputs carry evidence.**
  Put rationale, assumptions, parameter choices, and gotchas in markdown; put
  line-level implementation notes in comments; never copy a result into markdown
  when the cell output already shows it.
- **Open with an H1 title and a 2–5 sentence motivation**: the question, why it
  matters, who the notebook is for, and what the reader gets — before the first
  import.
- **One `#` H1, then `##`/`###` that form a table of contents.** Never skip a
  heading level.
- **Put a markdown cell immediately above each code cell (or coherent group)**
  that names the step.
- **After a cell produces a result, add a markdown cell that interprets it** —
  state the takeaway in prose, don't restate the number.
- **State caveats and limitations, and end with a conclusions / next-steps
  markdown cell.**
- **Calibrate to a future reader of the repo, not to yourself right now** — err
  toward explaining *why*, but don't narrate the obvious.
- **Use the right device:** tables for comparisons and parameters, lists for
  procedures, `$…$`/`equation` for math, escaped `\$` for literal dollars, links
  for data/methods/sources.

# Handover quality bar

A notebook is done when a stranger can open it, restart the kernel, and run it
top-to-bottom with no errors and outputs that match. Concretely:

1. **Runs top-to-bottom from a fresh kernel.** Do `reset_kernel()` then
   `run_all()` and confirm every cell succeeds and its outputs are current. Fix
   or delete anything that fails; do not ship stale outputs.
2. **Config is at the top and self-contained.** One config/parameters cell holds
   paths and knobs; nothing depends on values set in a discarded scratch cell.
3. **Paths are stable and relative to the notebook/project**, not absolute
   `/tmp` paths or paths to files that won't exist for the reader.
4. **Effect cells are guarded.** A cell that writes files, calls an API, or
   launches work must be safe to re-run.
5. **No secrets and no machine-specific values** in code, outputs, or metadata.
6. **Markdown checklist** (above) is satisfied: title/motivation, TOC headers,
   a label above each code cell, interpretation after each result, caveats and
   conclusions.

## The effect-guard idiom

`run_all()` re-executes every cell, so an unguarded effect cell repeats its
effect on every resync. State this plainly if it is unavoidable; otherwise guard
it — load a recorded result if it exists, otherwise compute once and record it:

```python
from pathlib import Path
import json

cache = Path("results/scan.json")
if cache.exists():
    data = json.loads(cache.read_text())
    print(f"loaded {len(data)} rows from {cache}")
else:
    data = await scan_repo()          # the expensive / side-effecting step
    cache.parent.mkdir(parents=True, exist_ok=True)
    cache.write_text(json.dumps(data))
len(data)
```

For pool workflows the guard matters more: re-running a notebook must not spawn
a second set of tmux agents. Guard pool creation behind an existing result file
or a session check, and close pools before the cell ends (see the `pi-subagents`
skill).

# Curating and delivering

- Read before you rewrite: `read_cells` / `read_cell` to see sources and current
  outputs, `inspect_kernel` to see what the namespace really holds.
- Fix the notebook, not just the kernel: patching a value with `scratch_run` and
  leaving the cell wrong is hidden state.
- When delivering, report the notebook path and one line on what it does.
  Promote only genuinely reusable workflows with
  `promote_to_skill_notebook({ name })` — not one-off scratch.
