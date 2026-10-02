# Kernels and notebooks

## What it does

The kernels feature gives the model a persistent, Jupyter-like Python interpreter — a *kernel* — that survives across cells and conversation turns. Instead of re-running a whole script per step, the model calls `provision_kernel` once to start a kernel bound to a real `.ipynb` notebook file, then runs work incrementally with `exec_cell`: imports, variables, functions, and classes stay in the namespace between cells, the last bare expression of each cell echoes Jupyter `Out[n]`-style, and every executed cell (including errored and interrupted ones) is recorded live in the notebook on disk, so the notebook is always a durable, re-openable record of the session.

The notebook is also a first-class editable document. The model can create and edit cells without executing them (`write_cell`, `delete_cell`), read the current cells and their stored outputs (`read_cells`, `read_cell`), run specific cells or the whole notebook (`run_cell`, `run_to`, `run_all`), run throwaway code that mutates the namespace but records nothing (`scratch_run`), and restart the interpreter from a clean namespace while leaving the notebook file intact (`reset_kernel`). Markdown cells are first-class alongside code cells.

Supporting tools cover discovery (`list_kernels`, `inspect_kernel`), paging through large persisted outputs (`read_cell_output`), installing packages into the kernel's environment (`provision_dependency`), seeding a kernel from a saved workflow, and promoting a finished notebook back into a reusable library workflow (`promote_to_skill_notebook`).

## How it works

### One process per kernel, JSONL protocol

- **Tools registered.** `session_start` registers `provision_kernel`, `exec_cell`, `list_kernels`, `read_cell_output`, `promote_to_skill_notebook`, `inspect_kernel`, `provision_dependency`, and the document/kernel tools `scratch_run`, `write_cell`, `delete_cell`, `read_cells`, `read_cell`, `run_cell`, `run_to`, `run_all`, and `reset_kernel` (`src/index.ts`, `handleSessionStart`).
- **Transport.** `provision_kernel` spawns a Python subprocess running the persistent session runtime (`src/python-session-manager.ts`, `provision`). Host and interpreter talk a line-delimited JSON protocol over the child's stdin/stdout. The host sends `exec`, `inspect`, `doc`, and `export_script` frames; the interpreter answers with `session_ready`, `exec_done`, `exec_error`, `kernel_inspected`, `doc_done`, `doc_error`, and `script_exported`, plus interleaved `execution_progress`, `stdout`, and `subagent_state` frames. The frame vocabulary is documented at the top of `src/python-runtime/session.py`.

### Cell semantics (embedded IPython)

- **One shared namespace, real IPython.** Cells run on one embedded IPython `InteractiveShell` whose user namespace *is* the session's globals, so there is a single persistent namespace with native top-level `await`, `In[n]`/`Out[n]` history, and real magics (`src/python-runtime/session.py`, `_ptc_run_shell_cell`). There is no per-cell `def`/function wrapper, no locals merge, and no trailing-expression rewrite.
- **Magics and shell escapes work.** `%time`, `%pip`, `%%capture`, `!ls`, and friends are executed by IPython rather than rejected. (Client-side validation still rejects a cell that calls `asyncio.run(...)` — top-level `await` already works — or `_rpc_call(...)` directly; use the generated helpers instead. See `src/utils.ts`, `validateUserCode`.)
- **Echo.** A trailing bare expression is echoed by IPython's displayhook and travels as the frame's `echo` field; its `Out[n]` matches the notebook's `execution_count`. The notebook records it as an `execute_result` output.
- **Top-level `return`.** Kept for compatibility via a small AST transformer: `return <value>` becomes a private `_PtcReturn` signal that stops the cell early without copying the namespace. Its value is reported in the `return (Out[n])` section and cached in `metadata.ptc_full_output`, but it is *not* written as an `execute_result` output (only auto-echoed bare expressions are).
- **Rich output.** Output is captured with IPython's `capture_output` (`display=True`): `print` lines stream to the host while rich `display(...)` mime bundles — including `image/png` — are collected and written to the notebook as nbformat `display_data` outputs.

### Notebook artifacts and document ops

- **Persistence.** Every completed cell — normal, errored, or interrupted — is written to the bound `.ipynb` and the file is rewritten atomically. `stdout` becomes `stream` outputs, the echo an `execute_result`, `display(...)` bundles `display_data`, and errors `error` outputs. The full cell output is also cached in the cell's `metadata.ptc_full_output` so `read_cell_output` can page through it (`src/python-runtime/session.py`).
- **`write_cell(at, source, type)`** upserts a `code` or `markdown` cell at a 1-based position. When it replaces an existing cell, that cell's outputs are cleared. It never executes code and persists the file immediately, so the notebook can be authored ahead of running it.
- **`delete_cell(n)`** removes a cell; later positions shift down one.
- **`read_cells(offset?, limit?)` / `read_cell(n)`** return cells — type, current `execution_count`, source, and an output preview — by notebook position. Use them to inspect what is there before running it. Cell numbers here are *positions*, which can differ from execution numbers once cells have been re-run or inserted.
- **External edits are preserved.** Before writing or executing, the runtime re-reads the notebook when its modification time/size changed on disk, so cells edited in Jupyter or an editor while the session runs are merged rather than clobbered (`session.py`, `_ptc_notebook_reload`).
- **Numbering.** Cells are numbered 1-based, Jupyter `Out[n]`-style, by **execution order** (not position). A scratch run or a `run_cell` advances the execution counter, so execution numbers can diverge from positions. `reset_kernel` restarts the counter at 1. When a kernel is seeded from a source notebook, the prefix numbering counts *every* sourced cell including markdown: 7 source cells means the first new `exec_cell` continues at cell 8 (`src/python-session-manager.ts`).

### Execution tools

- **`exec_cell`** runs one new cell and appends it to the notebook. It takes exactly one of `code` or `file`; `file` executes a `.py` inside the kernel with IPython `%run` semantics (definitions land in the namespace, tracebacks map to the real file path). Use `request_cell_review` separately when the operation needs user review.
- **`scratch_run`** executes code that mutates the namespace but records **no** cell: nothing is appended to the notebook (the file is not even created if it did not exist). Use it for exploration and setup that should not become part of the artifact.
- **`run_cell(n)`** executes the code cell at position `n` and replaces that cell's stored outputs in place (execution-order numbering).
- **`run_to(n)`** executes code cells `1..n` in notebook order; **`run_all`** executes every code cell in order. Both stop at the first error, update each cell's outputs, and report a per-cell status list. Markdown cells are skipped.
- **`reset_kernel`** restarts the interpreter under the same session id: the namespace is empty and execution numbering restarts at 1, while the notebook file on disk is untouched.

### Concurrency, timeouts, and interrupts

- **Serialization.** Cells run one at a time per kernel via a promise queue (jsonl frames are processed sequentially by the interpreter). A second parallel `exec_cell` streams a "Queued: another exec_cell cell is still running in this kernel" update instead of racing. Document ops, scoped runs, and `reset_kernel` are serialized through the same queue (`src/python-session-manager.ts`, `enqueue`/`execForeground`). Stale frames from superseded execs are dropped by exec-id comparison.
- **Idle timeout, not runtime timeout.** The default idle window is 270 s (`PTC_EXECUTION_TIMEOUT_MS`) and is re-armed by *every* interpreter frame — progress, stdout, nested tool calls, subagent updates — so it measures silence, not total runtime. Expiry sends SIGINT into the interpreter rather than killing the session.
- **Interrupts are Ctrl-C semantics.** Esc-abort and idle timeout both SIGINT the interpreter; the running cell raises `KeyboardInterrupt`/`CancelledError`, the kernel stays interactive with its namespace intact, and the report includes a `Stopped at:` line plus the Python traceback. If the interpreter cannot be interrupted (stuck in a native call), a 5 s grace period (`INTERRUPT_GRACE_MS`) ends in SIGKILL. Esc makes pi reject the tool call with its own `AbortError` first — the interrupt report then reaches the model via a queued message, while idle timeouts reject normally with the stack in the tool error (`src/python-session-manager.ts`).
- **Output sections.** The host composes the model-visible result into structural sections — `output:` (printed text), `return (Out[n]):` (the return value and/or echoed value), `kernel:` (namespace digest), `subagents:` (pool progress), and `tools:` (nested-tool summary) — with cell-produced lines indented two spaces under column-0 markers, so provenance is positional and a cell that prints `kernel:` cannot impersonate a section (`src/python-session-manager.ts`, `buildFinalOutput`; `src/utils.ts`, `sectionize`).
- **Lifecycle.** Kernels live until the conversation ends, `/ptc kill`, or `session_shutdown` (which disposes all sessions and their children). `PTC_MAX_PYTHON_SESSIONS` is parsed but enforcement is disabled — provision never rejects.

## Usage

The model does this itself — your part is describing the task. A typical sequence as the model sees it:

```
provision_kernel({ notebook: "analysis.ipynb" })
→ "Provisioned kernel a3f8c1d2e4f5 — notebook /path/to/analysis.ipynb."

exec_cell({
  session_id: "a3f8c1d2e4f5",
  code: `
import json
from collections import Counter

rows = json.load(open("data/events.json"))
by_kind = Counter(r["kind"] for r in rows)
by_kind
`
})
→ output:
    (nothing printed)
  return (Out[1]):
    Counter({'build': 41, 'test': 27, 'deploy': 9})
  kernel:
    cell 1 · 2 imports · 1 defs · Counter (Counter)
```

Authoring and re-running without a separate script:

```
write_cell({ session_id, at: 1, type: "markdown", source: "# Event analysis" })
write_cell({ session_id, at: 2, source: "top3 = by_kind.most_common(3)\ntop3" })

read_cells({ session_id })            # inspect positions/sources/outputs
run_cell({ session_id, n: 2 })        # execute just cell 2, replace its outputs
run_all({ session_id })               # run every code cell in order
```

Later cells (or later conversation turns) build on the same namespace — `rows`, `by_kind`, and `top3` are still there, no re-import needed. For a long-running workflow the user can:

- press **Esc** to interrupt a stuck cell (the kernel stays alive);
- run **`/ptc interrupt [session_id]`** (or `/ptc stop`) to stop the running chunk from the TUI, or **`/ptc kill [session_id]`** to dispose the kernel entirely;
- open `analysis.ipynb` in Jupyter at any time — it is a standard nbformat 4 notebook, updated after every executed cell.

Finished workflows can be saved for reuse with `promote_to_skill_notebook({ name: "event-analysis" })`, which copies the complete notebook (markdown, code, outputs, metadata) into the library under a normalized lowercase-hyphenated name; an existing library notebook is only replaced when `overwrite: true` (`src/python-session-manager.ts`, `promoteToSkillNotebook`).

## Options / Configuration

All settings are environment-based (`loadSettingsFromEnv`, `src/utils.ts`); there is no settings file.

| Env var | Default | Effect on kernels |
| --- | --- | --- |
| `PTC_EXECUTION_TIMEOUT_MS` | `270000` (270 s) | Idle window per cell/op; re-armed on every interpreter frame. Expiry SIGINTs the chunk (kernel survives). |
| `PTC_OUTPUT_PREVIEW_CHARS` (alias `PTC_MAX_OUTPUT_CHARS`) | `12000` | Model-facing head/tail preview size before the model should page via `read_cell_output`. |
| `PTC_MAX_SPOOL_CHARS` | `10000000` | Emergency per-cell capture ceiling in the interpreter; output below this is always persisted in full to the notebook. |
| `PTC_MAX_PARALLEL_TOOL_CALLS` | `8` | Default parallelism of the in-kernel `ptc.gather_limit` helper for nested tool calls. |
| `PTC_LIBRARY_DIR` | `~/.pi/agent/pycells-library` (or `$PI_CODING_AGENT_DIR/pycells-library`) | Library directory for `source` bare-name resolution and `promote_to_skill_notebook` (`src/python-session-manager.ts`). |
| `PTC_MAX_PYTHON_SESSIONS` | `4` | Parsed but **not enforced** — provisioning never rejects; vestigial. |
| `PTC_CODE_THEME` | `github-dark` | Shiki theme override for cell boxes and standalone cell review. |
| `PTC_PYTHON_EXECUTABLE` | venv at `~/.cache/pi-pycells/python-env`, else `python3` | Interpreter used for kernels and for `provision_dependency` installs (`src/sandbox-manager.ts`). |
| `PTC_DEBUG` | `false` | Debug logging to stdout. |

Two timeouts are not configurable: nested host-tool calls from a cell time out after 300 s (`src/python-runtime/rpc.py`), and `inspect_kernel` waits at most 15 s for the namespace digest (`src/index.ts`). `provision_dependency` runs `uv pip install --python <kernel python> <package>` with a 180 s timeout and reports installed/updated vs. already satisfied; already-running kernels keep their loaded versions until restarted.

## Testing note

The real interpreter round-trip tests are opted in with `PTC_TEST_REAL_RUNTIME=true` (not `1`). The optional `nbformat.validate` cross-check additionally requires `PTC_TEST_NBFORMAT=true` (it fetches `nbformat` through `uv`).

## Standalone setup notes

Things that are hardcoded or assume the author's machine setup, and how to work around each:

- **The Python venv location.** Kernels prefer `~/.cache/pi-pycells/python-env/bin/python` (created on demand by the pi_subagents provisioner, `uv` if available else `python3 -m venv`). To use your own interpreter instead, set `PTC_PYTHON_EXECUTABLE` — it wins over the venv. Python **3.10+ is required**; older interpreters fail fast with a clear startup error (PEP 604 unions and 3.12 AST features are load-bearing) (`src/python-runtime/rpc.py`).
- **pi_subagents provisioning clones a public GitHub mirror by default.** The managed clone comes from `https://github.com/Quinntyx/pi-subagents` (`DEFAULT_REPO_URL`, `src/subagents-env.ts`). Without network access, the background sync logs a failure but kernels still work — only `import pi_subagents` (subagent pools) is unavailable. Workarounds: point `PTC_SUBAGENTS_REPO_URL` at your own fork/clone, or set `PTC_SUBAGENTS_SOURCE` to a local checkout, which is installed editable and skips cloning entirely.
- **The dev-checkout default path is author-specific.** Without `PTC_SUBAGENTS_SOURCE`, the provisioner checks `~/docs/src/pi-subagents` (`DEV_SOURCE_DEFAULT`, `src/subagents-env.ts`) — harmless if absent, but it means the author's machine silently prefers a checkout you won't have. Set `PTC_SUBAGENTS_SOURCE` explicitly if you keep one elsewhere. Sync frequency is throttled to once per `PTC_SUBAGENTS_SYNC_INTERVAL_HOURS` (default 24).
- **Subagent agent-dir selection.** Selection is env-driven end to end: kernels inherit `PI_CODING_SUBAGENT_DIR` / `PI_CODING_AGENT_DIR` from the host process, and `pi_subagents` resolves the dir for spawned subagents (default: the orchestrator's own agent dir). No PTC-side forwarding exists.
- **Library directory.** Bare-name `source` resolution and notebook promotion read from `~/.pi/agent/pycells-library` (honoring `PI_CODING_AGENT_DIR` if set). There is no settings-file field for this: `PtcSettings.libraryDir` exists in the contract but is never populated by the loader, so `PTC_LIBRARY_DIR` is the only way to relocate it.
- **`uv` must be on PATH for package installs.** `provision_dependency` shells out to the `uv` binary; without it you get an ENOENT error suggesting you install `uv`. There is no pip fallback. Pre-install heavy distributions into the venv yourself as an alternative.
- **Notebook path defaults to /tmp.** Every kernel is bound to a destination `.ipynb` (`.ipynb` appended if omitted). Omitted, it is created under `/tmp/pi-pycells/notebooks/` — right for throwaway kernels, which are the common case. Pass an explicit path (in the repo) when the notebook is the durable artifact you want to keep or promote.
- **Child processes can corrupt the protocol.** Processes spawned from a cell inherit the interpreter's RPC pipes; anything that reads stdin or writes un-captured stdout can hang the kernel. Spawn children with `stdin=DEVNULL` and capture their output (a documented property of the JSONL-over-stdio transport, see `docs/tool-bridge.md`).
