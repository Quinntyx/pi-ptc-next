# Kernels and notebooks

## What it does

The kernels feature gives the model a persistent, Jupyter-like Python interpreter — a *kernel* — that survives across cells and conversation turns. Instead of re-running a whole script per step, the model calls `provision_kernel` once to start a kernel bound to a real `.ipynb` notebook file, then runs work incrementally with `exec_cell`: imports, variables, functions, and classes stay in the namespace between cells, the last bare expression of each cell echoes Jupyter `Out[n]`-style, and every executed cell (including errored and interrupted ones) is appended live to the notebook on disk, so the notebook is always a durable, re-openable record of the session. Supporting tools cover discovery (`list_kernels`, `inspect_kernel`), paging through large persisted outputs (`read_cell_output`), installing packages into the kernel's environment (`provision_dependency`), seeding a kernel from a saved workflow, and promoting a finished notebook back into a reusable library workflow (`promote_to_skill_notebook`).

## How it works

- **Tools registered.** Seven tools are registered on `session_start` (`src/index.ts:1490-1513`): `provision_kernel`, `exec_cell`, `list_kernels`, `read_cell_output`, `promote_to_skill_notebook`, `inspect_kernel`, and `provision_dependency`.
- **One process per kernel.** `provision_kernel` spawns a Python subprocess running the persistent session runtime (`src/python-session-manager.ts:1041-1105`). Host and interpreter talk a line-JSON protocol over the child's stdin/stdout: the host sends `exec`, `inspect`, and `export_script` frames; the interpreter answers with `session_ready`, `exec_done`, `exec_error`, `kernel_inspected`, `script_exported`, plus interleaved `execution_progress`, `stdout`, and `subagent_state` frames (`src/python-runtime/session.py:1-30`).
- **Cells compile as function bodies.** Each cell is parsed to an AST and compiled as a `def` (or `async def` when it uses top-level await), wrapped in `try/finally` that stores the cell's locals into a shared namespace afterwards — so `return` works, `await` works at top level, and imports/defs persist across cells (`src/python-runtime/session.py:36-190`). Names reserved by the runtime (`_ptc_*`, `PTC_*`, `__*`) cannot be clobbered by user code.
- **Echo.** A trailing bare expression is auto-echoed `Out[n]`-style, `str()`-first so libraries can opt into readable display via `__str__` (`src/python-runtime/session.py:154-166`).
- **Notebook persistence.** Every completed cell is appended to the bound `.ipynb` — stdout as a `stream` output, the echo as `execute_result`, captured figures as `display_data` PNGs, errors as `error` outputs — and the file is rewritten atomically. The full output is also cached in the cell's `metadata.ptc_full_output` so `read_cell_output` can page through it. Errored and interrupted cells are recorded too; magic-rejected and approval-rejected cells never reach the notebook (`src/python-runtime/session.py:427-495`).
- **Cell numbering.** Cells are numbered 1-based like Jupyter `Out[n]`. If a kernel is seeded from a source notebook, the prefix numbering counts *every* sourced cell including markdown: 7 source cells means the first new `exec_cell` is cell 8 (`src/python-session-manager.ts:1231-1236`).
- **Sourcing.** `provision_kernel({ notebook, source })` copies a library `.ipynb` to the destination (markdown preserved, code cells executed in order with fresh outputs) or treats a `.py` file as one virtual prefix cell. Bare names resolve from the notebook library directory. A sourcing failure is recorded on the failed cell (`sourceError: { cellIdx, message, traceback? }`) and leaves the kernel usable (`src/python-session-manager.ts:1107-1180, 1238-1265`).
- **Serialization and queueing.** Cells run one at a time per kernel via a promise queue; a second parallel `exec_cell` call streams a "Queued: another exec_cell cell is still running in this kernel" update instead of racing (`src/python-session-manager.ts:1267-1300`). Stale frames from superseded execs are dropped by exec-id comparison.
- **Idle timeout, not runtime timeout.** The idle window defaults to 270 s (`PTC_EXECUTION_TIMEOUT_MS`) and is re-armed by *every* interpreter frame — progress, stdout, nested tool calls, subagent updates — so it measures silence, not total runtime. Expiry sends SIGINT into the interpreter rather than killing the session (`src/python-session-manager.ts:470-497`). Nested host-tool calls made from a cell have their own 300 s default timeout in the Python RPC client (`src/python-runtime/rpc.py:76-80`).
- **Interrupts are Ctrl-C semantics.** Esc-abort and idle timeout both SIGINT the interpreter; the running chunk raises `KeyboardInterrupt`/`CancelledError`, the kernel stays interactive with its namespace intact, and the report includes a `Stopped at:` line plus the Python traceback. If the interpreter cannot be interrupted (stuck in a native call), a 5 s grace period (`INTERRUPT_GRACE_MS`) ends in SIGKILL. Note that Esc makes pi reject the tool call with its own `AbortError` first — the interrupt report then reaches the model via a queued message, while idle timeouts reject normally with the stack in the tool error (`src/python-session-manager.ts:94, 499-541`).
- **Output sections.** The host composes the model-visible result into structural sections — `output:` (printed text), `return (Out[n]):` (the echoed value), `kernel:` (namespace digest), `subagents:` (pool progress) — with cell-produced lines indented two spaces under column-0 markers, so provenance is positional and a cell that prints `kernel:` cannot impersonate a section (`src/python-session-manager.ts:424-460`; `src/utils.ts` `sectionize`).
- **No IPython magics.** Cells whose code fails to parse are scanned for line-leading `%`/`!` and rejected pre-execution with a `MagicError` listing native equivalents (`provision_dependency`, `exec_cell(file=...)`, the bash tool). The scan only runs on parse failure, so `%`/`!` inside strings executes normally (`src/python-runtime/session.py:192-231`). Client-side validation also rejects cells containing `asyncio.run(` or `_rpc_call(` before they are sent (`src/utils.ts:349-361`).
- **`file` mode.** `exec_cell` takes exactly one of `code` or `file`; `file` executes a `.py` inside the kernel with IPython `%run` semantics (definitions land in the namespace, tracebacks map to the real file path, and the cell is recorded at its notebook position) (`src/index.ts:1146-1160`).
- **Lifecycle.** Kernels live until the conversation ends, `/ptc kill`, or `session_shutdown` (which disposes all sessions and their children). `PTC_MAX_PYTHON_SESSIONS` is parsed but enforcement is disabled — provision never rejects (`src/python-session-manager.ts:1041-1043`).

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

exec_cell({
  session_id: "a3f8c1d2e4f5",
  code: "top3 = by_kind.most_common(3)\ntop3",
  confirm: true
})
→ return (Out[2]): [('build', 41), ('test', 27), ('deploy', 9)]
```

Later cells (or later conversation turns) build on the same namespace — `rows`, `by_kind`, and `top3` are still there, no re-import needed. For a long-running workflow the user can:

- press **Esc** to interrupt a stuck cell (the kernel stays alive);
- run **`/ptc interrupt [session_id]`** (or `/ptc stop`) to stop the running chunk from the TUI, or **`/ptc kill [session_id]`** to dispose the kernel entirely (`src/index.ts:1358-1410`);
- open `analysis.ipynb` in Jupyter at any time — it is a standard nbformat 4 notebook, updated after every cell.

Finished workflows can be saved for reuse with `promote_to_skill_notebook({ name: "event-analysis" })`, which copies the complete notebook (markdown, code, outputs, metadata) into the library under a normalized lowercase-hyphenated name; an existing library notebook is only replaced when `overwrite: true` (`src/python-session-manager.ts:1399-1450`).

## Options / Configuration

All settings are environment-based (`loadSettingsFromEnv`, `src/utils.ts:64-95`); there is no settings file.

| Env var | Default | Effect on kernels |
| --- | --- | --- |
| `PTC_EXECUTION_TIMEOUT_MS` | `270000` (270 s) | Idle window per `exec_cell`; re-armed on every interpreter frame. Expiry SIGINTs the chunk (kernel survives). |
| `PTC_OUTPUT_PREVIEW_CHARS` (alias `PTC_MAX_OUTPUT_CHARS`) | `12000` | Model-facing head/tail preview size before the model should page via `read_cell_output`. |
| `PTC_MAX_SPOOL_CHARS` | `10000000` | Emergency per-cell capture ceiling in the interpreter; output below this is always persisted in full to the notebook. |
| `PTC_MAX_PARALLEL_TOOL_CALLS` | `8` | Default parallelism of the in-kernel `ptc.gather_limit` helper for nested tool calls. |
| `PTC_LIBRARY_DIR` | `~/.pi/agent/ptc-library` (or `$PI_CODING_AGENT_DIR/ptc-library`) | Library directory for `source` bare-name resolution and `promote_to_skill_notebook` (`src/python-session-manager.ts:992-1005`). |
| `PTC_MAX_PYTHON_SESSIONS` | `4` | Parsed but **not enforced** — provisioning never rejects; vestigial. |
| `PTC_CODE_THEME` | `github-dark` | Shiki theme for the `confirm: true` cell-approval popup. |
| `PTC_PYTHON_EXECUTABLE` | venv at `~/.cache/pi-ptc/python-env`, else `python3` | Interpreter used for kernels and for `provision_dependency` installs (`src/sandbox-manager.ts:35-42`). |
| `PTC_DEBUG` | `false` | Debug logging to stdout. |

Two timeouts are not configurable: nested host-tool calls from a cell time out after 300 s (`src/python-runtime/rpc.py:76`), and `inspect_kernel` waits at most 15 s for the namespace digest (`src/index.ts:470-517`). `provision_dependency` runs `uv pip install --python <kernel python> <package>` with a 180 s timeout and reports installed/updated vs. already satisfied; already-running kernels keep their loaded versions until restarted.

## Standalone setup notes

Things that are hardcoded or assume the author's machine setup, and how to work around each:

- **The Python venv location.** Kernels prefer `~/.cache/pi-ptc/python-env/bin/python` (created on demand by the pi_subagents provisioner, `uv` if available else `python3 -m venv`). To use your own interpreter instead, set `PTC_PYTHON_EXECUTABLE` — it wins over the venv. Python **3.10+ is required**; older interpreters fail fast with a clear startup error (PEP 604 unions and 3.12 AST features are load-bearing) (`src/python-runtime/rpc.py:13-22`).
- **pi_subagents provisioning clones a public GitHub mirror by default.** The managed clone comes from `https://github.com/Quinntyx/pi-subagents` (`DEFAULT_REPO_URL`, `src/subagents-env.ts`). Without network access, the background sync logs a failure but kernels still work — only `import pi_subagents` (subagent pools) is unavailable. Workarounds: point `PTC_SUBAGENTS_REPO_URL` at your own fork/clone, or set `PTC_SUBAGENTS_SOURCE` to a local checkout, which is installed editable and skips cloning entirely.
- **The dev-checkout default path is author-specific.** Without `PTC_SUBAGENTS_SOURCE`, the provisioner checks `~/docs/src/pi-subagents` (`DEV_SOURCE_DEFAULT`, `src/subagents-env.ts:32`) — harmless if absent, but it means the author's machine silently prefers a checkout you won't have. Set `PTC_SUBAGENTS_SOURCE` explicitly if you keep one elsewhere. Sync frequency is throttled to once per `PTC_SUBAGENTS_SYNC_INTERVAL_HOURS` (default 24).
- **Subagent agent-dir selection.** Selection is env-driven end to end: kernels inherit `PI_CODING_SUBAGENT_DIR` / `PI_CODING_AGENT_DIR` from the host process, and `pi_subagents` resolves the dir for spawned subagents (default: the orchestrator's own agent dir). No PTC-side forwarding exists.
- **Library directory.** Bare-name `source` resolution and notebook promotion read from `~/.pi/agent/ptc-library` (honoring `PI_CODING_AGENT_DIR` if set). There is no settings-file field for this: `PtcSettings.libraryDir` exists in the contract but is never populated by the loader, so `PTC_LIBRARY_DIR` is the only way to relocate it.
- **`uv` must be on PATH for package installs.** `provision_dependency` shells out to the `uv` binary; without it you get an ENOENT error suggesting you install `uv`. There is no pip fallback. Pre-install heavy distributions into the venv yourself as an alternative.
- **Notebook path is mandatory.** Unlike a scratch REPL, every kernel needs a destination `.ipynb` (`.ipynb` is appended if omitted). For throwaway work, pass a `/tmp` path as the tool description suggests; for real work, the notebook under your repo is the durable artifact.
- **Child processes can corrupt the protocol.** Processes spawned from a cell inherit the interpreter's RPC pipes; anything that reads stdin or writes un-captured stdout can hang the kernel. Spawn children with `stdin=DEVNULL` and capture their output (a documented property of the JSONL-over-stdio transport, see `docs/tool-bridge.md`).
