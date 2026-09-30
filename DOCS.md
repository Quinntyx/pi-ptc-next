# pi-pycells — master documentation

`pi-pycells` (package `pi-pycells`) is a **Programmatic Tool Calling (PTC)** extension for [Pi](https://github.com/earendil-works/pi): it gives the model a persistent, Jupyter-like Python kernel (`provision_kernel` + `exec_cell`) that can call the host's pi tools (`read`, `glob`, `grep`, …) as ordinary `async` Python functions, so repo-wide fan-out work happens inside Python cells and only compact final results reach the model's context. It is configured entirely through environment variables, keeps a durable `.ipynb` record of everything it runs, and adds an auto-routing/auto-recovery layer plus an optional multi-agent orchestration runtime (`pi_subagents`).

## Table of contents

- [Getting started / usage flow](#getting-started--usage-flow)
- [Kernels and Python execution](#kernels-and-python-execution) — details: [docs/kernels.md](docs/kernels.md)
- [Calling pi tools from Python (the tool bridge)](#calling-pi-tools-from-python-the-tool-bridge) — details: [docs/tool-bridge.md](docs/tool-bridge.md)
- [Output handling and the code view](#output-handling-and-the-code-view) — details: [docs/output-and-code-view.md](docs/output-and-code-view.md)
- [Auto-routing and auto-recovery](#auto-routing-and-auto-recovery) — details: [docs/auto-routing-and-recovery.md](docs/auto-routing-and-recovery.md)
- [Subagent orchestration (`pi_subagents`)](#subagent-orchestration-pi_subagents) — details: [docs/subagents.md](docs/subagents.md)
- [Custom tools](#custom-tools) — details: [docs/custom-tools.md](docs/custom-tools.md)
- [The notebook library](#the-notebook-library) — details: [docs/notebook-library.md](docs/notebook-library.md)
- [Sandboxing and subprocess policy](#sandboxing-and-subprocess-policy) — details: [docs/sandboxing.md](docs/sandboxing.md)
- [Benchmarks and evals](#benchmarks-and-evals) — details: [docs/benchmarks-and-evals.md](docs/benchmarks-and-evals.md)
- [Configuration](#configuration) — full reference: [docs/configuration.md](docs/configuration.md)
- [Optional dependencies](#optional-dependencies)
- [Standalone setup](#standalone-setup)

## Getting started / usage flow

**1. Install.** No build step and no required environment variables:

```bash
pi install git:github.com/Quinntyx/pi-pycells
pi                                             # start pi; the extension registers its tools on session_start
```

On `session_start` the extension registers seven tools (`provision_kernel`, `exec_cell`, `list_kernels`, `inspect_kernel`, `read_cell_output`, `provision_dependency`, `promote_to_skill_notebook`), builds the tool-call policy from `PTC_*` env vars, and kicks off the background `pi_subagents` provisioner (harmless if it fails).

**2. Describe the task; the model provisions a kernel.** You never call the tools yourself — describe the work and the model does:

```text
> Count the TODO comments in every *.ts file under src/ and give me the top 5 files as compact JSON only.
```

The model responds with:

```
provision_kernel({ notebook: "/tmp/todo-scan.ipynb" })
→ "Provisioned kernel a3f8c1d2e4f5 — notebook /tmp/todo-scan.ipynb."
```

Every kernel is bound to a real `.ipynb` destination; it is the durable artifact and gets a cell appended after every execution. Omit `notebook` for throwaway work — it lands under `/tmp/pi-pycells/notebooks/` and the provision result reports the path. For work worth keeping, pass an explicit path in your repo (or promote the notebook to the library afterwards).

**3. The model works incrementally in cells.** Variables, imports, and defs persist across cells and conversation turns; the last bare expression echoes Jupyter `Out[n]`-style; nested tool calls (`await read(f)`, `await grep(...)`) hit the real pi tool implementations in the host process:

```python
files = await glob('src/**/*.ts')
counts = {}
for f in files:
    text = await read(f)
    counts[f] = text.count('TODO')
top = sorted(counts.items(), key=lambda kv: -kv[1])[:5]
top
```

**4. You stay in control.** While a cell streams you see a line-numbered code view with a `▶` marker on the executing line (and a live subagent panel when pools are running). A cell requested with `confirm: true` pops up a syntax-highlighted approval box (Approve / Reject / Reject-with-note). **Esc** interrupts the running chunk with Ctrl-C semantics — the kernel stays alive with its namespace intact. `/ptc interrupt [session_id]` (alias `/ptc stop`) and `/ptc kill [session_id]` do the same from the TUI.

**5. Outputs are compact but never lost.** The model sees at most `PTC_OUTPUT_PREVIEW_CHARS` (default 12,000 chars) of any cell as a head/tail preview; the full output is persisted in the notebook's cell metadata and paged back via `read_cell_output(cellIdx, offset, limit)` (default 2,000 lines / 50 KB per call).

**6. Reuse what worked.** Finish a good workflow with `promote_to_skill_notebook({ name: "event-analysis" })` to copy the complete notebook (markdown, code, outputs) into the library at `~/.pi/agent/pycells-library`, then start future kernels with `provision_kernel({ notebook: "/tmp/work.ipynb", source: "event-analysis" })` — the sourced setup runs up front and the kernel inherits the namespace.

More: [docs/kernels.md](docs/kernels.md) for the full kernel lifecycle, and [docs/notebook-library.md](docs/notebook-library.md) for sourcing/promotion semantics.

## Kernels and Python execution

A kernel is a persistent Python subprocess bound to a real `.ipynb` notebook file. The host and interpreter talk a line-JSON protocol over stdin/stdout; cells run on an embedded IPython `InteractiveShell` with one persistent namespace, so `return`, top-level `await`, `In[n]`/`Out[n]` echo, IPython magics, and `!`-shell escapes all behave as in Jupyter. Every completed cell — including errored and interrupted ones — is appended to the notebook atomically, with stdout, the echoed value, captured matplotlib figures, and errors as standard nbformat outputs. Cells run one at a time per kernel (parallel calls queue, they don't race); the timeout is an **idle** window (default 270 s via `PTC_EXECUTION_TIMEOUT_MS`, re-armed by every interpreter frame), and expiry sends SIGINT rather than killing the session. `asyncio.run(...)` is rejected client-side. `exec_cell` also accepts `file: <path>.py` for `%run`-style script execution in the kernel namespace. Kernels live until the conversation ends, `/ptc kill`, or session shutdown.

```text
provision_kernel({ notebook: "analysis.ipynb" })
exec_cell({ session_id: "a3f8c1d2e4f5", code: "import json; rows = json.load(open('data/events.json')); len(rows)" })
→ return (Out[1]): 1482
exec_cell({ session_id: "a3f8c1d2e4f5", code: "rows[:2]", confirm: true })   # user approves the popup
```

More: [docs/kernels.md](docs/kernels.md)

## Calling pi tools from Python (the tool bridge)

Inside a cell, pi's tools are plain `async` Python functions generated host-side from each tool's schema. Calls travel as JSON-RPC-style frames to the host, which runs the **real** tool implementation (same paths, truncation, permissions as direct tool use) and normalizes results to Python-friendly shapes: `read` → `str`; `find`/`glob`/`ls` → `list[str]`; `grep` → `{"matches": [...], "matchLimitReached": ...}`; `bash` → `{"stdout", "stderr", "exitCode"}`. A `ptc` helper object adds bounded parallelism: `ptc.gather_limit`, `ptc.read_many`, `ptc.read_tree`, `ptc.find_files`, `ptc.find_files_abs`, `ptc.read_text`, `ptc.json_dump`. All bridged tools — builtins, `bash`, mutating tools, and `ptc.enabled` custom tools — are callable by default; no tool is policy-gated (see Sandboxing). Per-cell metrics report `estimatedAvoidedTokens` — context the model never had to see.

```python
result = await grep("RpcProtocolError", path="src")
for m in result["matches"][:5]:
    print(m["path"], m["line"], m["text"])

trees = await ptc.read_tree("src/contracts/*.ts", max_files=50)   # concurrency defaults to PTC_MAX_PARALLEL_TOOL_CALLS (8)
return {"files": len(trees), "lines": sum(len(t["content"].splitlines()) for t in trees)}
```

Rules: don't call `asyncio.run(...)` or `_rpc_call(...)`; don't spawn children that read stdin or write stdout (they inherit the RPC pipes — use `stdin=subprocess.DEVNULL, capture_output=True`); keep intermediates local and `print()`/`return` only compact summaries.

More: [docs/tool-bridge.md](docs/tool-bridge.md)

## Output handling and the code view

The host composes the model-visible result into structural sections — `output:` (stdout), `return (Out[n]):` (echoed expression), `kernel:` (namespace digest), `subagents:` (pool progress) — with cell lines indented two spaces under column-0 markers, so a cell cannot impersonate a section. Anything over the preview budget collapses into a whole-line ~70/30 head/tail preview with a marker pointing at `read_cell_output(cellIdx=K)`; the untruncated text lives in the notebook's cell `metadata.ptc_full_output` and pages back in 2,000-line/50 KB slices with continuation hints. On failures, at most one deterministic `help:` hint is appended to the traceback (e.g. `ModuleNotFoundError` → `provision_dependency('<distribution>')`). User-side, a running cell renders as a line-numbered code view with a `▶` executing-line marker and 10-line windowing for long cells (repainted on a 120 ms ticker so it animates during pure `await`s); a finished cell renders with a `[PTC]` header (nested tool calls, `~N tokens saved`, duration, figures); `confirm: true` cells get a Shiki-highlighted approval popup (`PTC_CODE_THEME`, default `github-dark`) with Approve / Reject / Reject-with-note.

More: [docs/output-and-code-view.md](docs/output-and-code-view.md)

## Auto-routing and auto-recovery

Before the agent starts, `PTC_AUTO_ROUTE` (default on) classifies the prompt: repo-wide/fan-out phrasing (`**/*.ts`, `every file`), processing verbs (`count`, `rank`, `aggregate`), and context-pressure phrases (`compact json only`) — two signal groups, or fan-out plus one, route the request toward `exec_cell` by narrowing the active tool set and appending one steering paragraph to the system prompt. Mutation-looking prompts (`edit`, `fix`, `create`, …) never route, and naming a PTC tool explicitly ("use exec_cell to …") routes unconditionally. `PTC_AUTO_RECOVER` (default off) is a bounded safety net: when a first failed `exec_cell` matches a known async-mistake class (`missing-await`, `async-wrapper-iterated` — calling `read`/`glob`/… without `await`), exactly one corrective `ptc-recovery` message is injected into the next context (cap `PTC_AUTO_RECOVER_MAX_ATTEMPTS`, default 1). Telemetry on every `exec_cell` result reports `autoRouted`, `routedToCodeExecution`, `recoveryAttemptCount`, and `terminalState` under `details.telemetry`.

```text
> Count the TODO comments in every *.ts file and return compact JSON only.   → routes to exec_cell
> Fix the typo in README.md                                                  → does not route (mutation prompt)
```

More: [docs/auto-routing-and-recovery.md](docs/auto-routing-and-recovery.md)

## Subagent orchestration (`pi_subagents`)

The optional `pi_subagents` Python module (auto-imported into every kernel as `pi_subagents` and `subagents`) lets a cell fan work out to real interactive pi instances, one per tmux window. Tasks are submitted to typed stages of an `AgentPool`, results pop in completion order, sessions can be steered (`h.send`) and reused (`stage.submit(task, session_handle=h)`), and `pool.close()` is the only teardown, echoing a summary report. Progress streams back live as a per-pool panel under the running cell, a `subagents: ● N running · ✓ M done` footer, and a transcript notification. Spawned agents carry pi's `PI_SUBAGENT_DEPTH` marker and can never spawn further subagents. Cyclic (build → review → fix) workflows must carry an integer `rounds` in task metadata and gate on it — otherwise `pop()` returning `None` never ends the loop.

```python
pool = subagents.AgentPool(concurrency=8, name="migration")
build = pool.stage("build", slots=4)
build.submit_all([subagents.Task(f"Migrate module {m}", name=f"build-{m}") for m in ("auth.py", "api.py")])
while (result := await pool.pop(timeout=600)) is not None:
    ...
summary = pool.close()
```

More: [docs/subagents.md](docs/subagents.md)

## Custom tools

Drop a plain `.js` file into the extension's `tools/` directory (inside the installed extension; hot-reloaded within ~300 ms, no restart) to register a model-callable tool. Adding a `ptc` metadata block additionally exposes it to Python cells as a generated `async` helper: `ptc: { enabled: true, readOnly: true }` marks it read-only for auto-routing metadata, `ptc.pythonName` overrides the generated function name, and `ptc.callers: ["code_execution"]` registers it for Python only. Returning `details.ptcValue` (JSON-compatible) passes structured data to Python verbatim.

```js
// tools/get_weather.js
export default {
  name: "get_weather",
  parameters: { type: "object", properties: { location: { type: "string" } }, required: ["location"] },
  ptc: { enabled: true, readOnly: true },
  execute: async (toolCallId, { location }) => ({
    content: [{ type: "text", text: `Weather in ${location}: sunny and 21 C` }],
  }),
};
```

```python
forecast = await get_weather(location="London")   # inside exec_cell
```

More: [docs/custom-tools.md](docs/custom-tools.md)

## The notebook library

`~/.pi/agent/pycells-library` (override with `PTC_LIBRARY_DIR`) holds reusable workflow notebooks. `promote_to_skill_notebook({ name })` copies the complete live notebook — markdown, code, outputs — into the library under a sanitized lowercase-hyphenated name, refusing to overwrite unless `overwrite: true`. `provision_kernel({ ..., source: "name" })` starts a new kernel from a library workflow: a `.ipynb` source is copied verbatim and its code cells executed in order as prefix cells (markdown preserved, not executed); a `.py` source runs as one virtual prefix cell. Sourced setup has already run when your first cell executes — cell numbering includes all prefix cells (a 7-cell source makes your first new cell `Out[8]`). A failing source cell is recorded on that cell and leaves the kernel usable.

More: [docs/notebook-library.md](docs/notebook-library.md)

## Sandboxing and subprocess policy

There is **no** container, VM, or isolation substrate — the extension currently only supports "yolo mode" — and there is no opt-in gate either: if the extension is loaded, kernels run as plain `python -u -c <code>` host subprocesses in your cwd with the full host environment inherited, seeing your real filesystem with your real permissions. Sandboxing is planned (VM-based checkpointing) but not implemented. No tool is policy-gated: the Python process can reach everything natively (`os.system`, `subprocess`, plain file writes), so filtering the model's tools — `bash` included — is futile enforcement. A minimal install gives the *model* full repo tool access and the Python process full host access. On non-Windows platforms kernels spawn as a detached process group, and cleanup SIGTERMs then SIGKILLs the whole group (including grandchildren such as subagent instances) after a 1 s grace. Don't use this in untrusted workspaces.

More: [docs/sandboxing.md](docs/sandboxing.md)

## Benchmarks and evals

A deterministic, model-free benchmark CLI gates the routing/recovery heuristics: seeded JSON cases under `.pi/evals/ptc/cases/` each declare a prompt, the expected first path (`code_execution` or `direct`), and `key=value` acceptance rules (`observed_first_path`, `success`, `recovery_attempted`, `failure_class`, `output_json`). The default executor replays the real routing heuristic — no LLM is called — and the CLI diffs the run against a saved baseline, exiting non-zero on routing/recovery/success regressions for CI use.

```bash
npm run build
node dist/run-benchmarks.js --provider local --model seeded --evals-path .pi/evals/ptc \
  --baseline .pi/evals/ptc/baselines/local__seeded.json
```

The eval cases are not shipped in the npm package (only in the git repo); baselines are yours to promote from result files. Token/duration figures from the default executor are synthetic stand-ins — for real measurements read `details.telemetry`/`details.metrics` on live `exec_cell` results.

More: [docs/benchmarks-and-evals.md](docs/benchmarks-and-evals.md)

## Configuration

Everything is configured through environment variables, read **once** at extension load (`loadSettingsFromEnv`, `src/utils.ts`) — there is no settings file, so changing a variable requires starting a new pi session. Kernels inherit the extension's environment, so the same variables are visible inside cells. Booleans accept `1/true/yes/on`; the main variables:

### Execution and output

| Variable | Default | Effect |
|---|---|---|
| `PTC_EXECUTION_TIMEOUT_MS` | `270000` | Idle window per `exec_cell` (re-armed on every interpreter frame); expiry SIGINTs the chunk, kernel survives. |
| `PTC_OUTPUT_PREVIEW_CHARS` (alias `PTC_MAX_OUTPUT_CHARS`) | `12000` | Model-visible preview before head/tail collapsing; full output stays in the notebook. |
| `PTC_MAX_SPOOL_CHARS` | `10000000` | Emergency per-cell capture ceiling; not a preview limit. |
| `PTC_MAX_PARALLEL_TOOL_CALLS` | `8` | Default concurrency for `ptc.gather_limit()` / `read_many` / `read_tree`. |
| `PTC_PYTHON_EXECUTABLE` | shared venv (`~/.cache/pi-pycells/python-env-3.14`, legacy `python-env` on upgraded installs) | Interpreter for all kernels; used verbatim, overrides the venv. |

### Tool policy

| Variable | Default | Effect |
|---|---|---|
| `PTC_CALLABLE_TOOLS` | *(unset — all eligible)* | Explicit allowlist of tools callable from Python. |
| `PTC_BLOCKED_TOOLS` | *(unset)* | Denylist; always wins over the allowlist. |

### Routing, recovery, sessions, UI

| Variable | Default | Effect |
|---|---|---|
| `PTC_AUTO_ROUTE` | `true` | Route qualifying prompts to `exec_cell` automatically. |
| `PTC_AUTO_RECOVER` | `false` | Enable the bounded async-failure recovery hint. |
| `PTC_AUTO_RECOVER_MAX_ATTEMPTS` | `1` | Recovery cap per request, clamped to 0–4. |
| `PTC_MAX_PYTHON_SESSIONS` | `4` | Parsed but **not enforced** (vestigial). |
| `PTC_DEBUG` | `false` | `[PTC]`-prefixed debug lines on stdout. |
| `PTC_SUBAGENT_FOOTER` | `true` | Live subagent status footer; set `false` for custom footers. |
| `PTC_CODE_THEME` | `github-dark` | Shiki theme for the `confirm: true` approval popup. |

### Paths

| Variable | Default | Effect |
|---|---|---|
| `PTC_LIBRARY_DIR` | `$PI_CODING_AGENT_DIR/pycells-library` (`~/.pi/agent/pycells-library`) | Notebook library for `source` lookup and promotion. |
| `PTC_EVALS_PATH` | `.pi/evals/ptc` | Root of benchmark/eval cases. |

### pi-subagents provisioning

| Variable | Default | Effect |
|---|---|---|
| `PTC_SUBAGENTS_REPO_URL` | `https://github.com/Quinntyx/pi-subagents` | Git source for the managed `pi_subagents` clone (public GitHub mirror by default; canonical repo lives on the author's forge). |
| `PTC_SUBAGENTS_SOURCE` | `~/docs/src/pi-subagents` (if present) | Dev checkout installed editable instead of the managed clone. |
| `PTC_SUBAGENTS_SYNC_INTERVAL_HOURS` | `24` | Minimum interval between syncs. |

Not configurable (hard constants): `read_cell_output` caps (2,000 lines / 50 KB per call, 50 KB per line), the 300 s nested-tool-call timeout, `inspect_kernel`'s 15 s wait, and `provision_dependency`'s 180 s `uv pip install` timeout. `PTC_SCRIPTS_DIR` is parsed but never read (setting it has no effect).

More: [docs/configuration.md](docs/configuration.md) — the full per-variable reference with types, parsers, and file/line references.

## Optional dependencies

| Dependency | Required? | What it provides | What degrades without it |
|---|---|---|---|
| **pi-coding-agent** | Required | The host this extension plugs into. | Nothing works without it. |
| **`uv`** | Required | Provisions the Python environment (default CPython 3.14, fetched automatically if the host lacks it) and powers `provision_dependency` installs. | Extension fails to start kernels — there is no fallback interpreter. |
| **IPython** | Required (session kernels) | Runs each cell with Jupyter semantics: one persistent namespace, `In[n]`/`Out[n]` echo, top-level await, and magics. | Session kernels fail to start with an actionable error; install it into the shared venv with `provision_dependency('ipython')`. |
| **`git`** | Optional | Required only for the managed-clone path of `pi_subagents` provisioning. | Subagents provisioning fails (logged, non-fatal) if there's no dev checkout to use instead. |
| **`pi_subagents` + tmux + `pi-sock`** | Optional (opt-in via `PI_SUBAGENTS_MAX_CONCURRENT`) | The subagent orchestration stack: set `PI_SUBAGENTS_MAX_CONCURRENT` to a positive number and the module installs into the shared venv from the public GitHub mirror at the next session start; tmux (each agent is a tmux window; the module refuses to spawn without tmux), and `pi-sock` (prompt-delivery transport — must be installed in your agent dir, which subagents share by default). Spawned agents run under your own agent dir; `PI_CODING_SUBAGENT_DIR` points them elsewhere. | Everything else works untouched; without the env var nothing is downloaded and `import pi_subagents` in cells fails with a hint. |
| **pi-tool-tree** | Optional | Nicer subagent activity display: live agent activity labels in the panel, and model-supplied activity words on tool calls (via a `globalThis` API, `pi-tool-tree:activity-api`). | The subagent panel, timers, and the vendored shimmer animation all work without it — you only lose the live activity labels/words. No extra setup needed. |
| **shiki** | Bundled | Syntax highlighting for the `confirm: true` approval popup. It is a regular dependency, so highlighting works out of the box; if it ever fails to load the popup falls back to plain text (visible with `PTC_DEBUG=1`) without aborting. | Nothing to install. |

Note that the shared venv at `~/.cache/pi-pycells/python-env` is created by the subagent provisioner but, once it exists, is preferred by **every** kernel over `python3` — even for users who never touch subagents. Set `PTC_PYTHON_EXECUTABLE` if you want to pin your own interpreter.

## Standalone setup

Several defaults encode the author's machine. None break core execution, but know about them:

- **`pi_subagents` source.** `PTC_SUBAGENTS_REPO_URL` defaults to the public GitHub mirror (`https://github.com/Quinntyx/pi-subagents`), so provisioning works out of the box. Point it at your own fork, or set `PTC_SUBAGENTS_SOURCE` to a local checkout (must contain a `pyproject.toml` at its root or under a `main/` subdirectory), if you want a different source.
- **Author-home dev-checkout default.** With `PTC_SUBAGENTS_SOURCE` unset, the provisioner probes `~/docs/src/pi-subagents` and installs it editable when present — on the author's machine it silently wins over the managed clone. Elsewhere it just doesn't exist; set the variable if you keep a checkout somewhere else.
- **tmux is the only hard requirement for subagents.** `pi_subagents` warns at import (and its API raises) when not running under tmux. Spawned agents run under **your own agent dir by default** — same config, extensions (pi-sock), and auth as the orchestrator, so there is nothing to create. For a separate subagent environment, set `PI_CODING_SUBAGENT_DIR` to any directory with a pi config (a pi-profiles-managed profile works: `PI_CODING_SUBAGENT_DIR=~/.config/pi/profiles/subagents`).
- **`~/.cache/pi-pycells` cache root (non-configurable in code).** Holds the shared venv (`python-env/`), the managed `pi-subagents/` clone, the sync log (rotated at 1 MB), and the sync lock file. Once the venv exists, all kernels prefer it over `python3` — delete it, or set `PTC_PYTHON_EXECUTABLE`, to control your interpreter.
- **Sync stamp inside the extension clone.** `.ptc-subagents-sync.json` lives in the extension's own directory; because `pi update` resets package clones, every update forces a fresh sync from whatever the repo variables resolve to at that moment. (The git-tracked stamp currently contains the author's absolute path — a harmless stale stamp that triggers one extra sync.)
- **pi agent-dir conventions.** The notebook library defaults to `~/.pi/agent/pycells-library` (honoring `PI_CODING_AGENT_DIR`), and the default eval root `.pi/evals/ptc` assumes a pi-style project directory. Set `PTC_LIBRARY_DIR` / `PTC_EVALS_PATH` if your layout differs.
- **English-only routing heuristics.** The auto-routing signals and mutation-word list are hardcoded English regexes; prompts in other languages simply don't route. Naming a PTC tool explicitly ("use exec_cell to …") routes unconditionally.
- **Custom `tools/` directory is not configurable.** Custom tools load from `<extensionRoot>/tools` inside the installed extension, so npm-installed files there can be wiped by upgrades — keep sources elsewhere and symlink them in, or maintain a patched local checkout.
- **Benchmark harness is repo-only.** Eval cases, baselines, and the `run-benchmarks.js` flow exist only in the git repo (not the npm `files` allowlist), and there is no `benchmark` npm script — run `npm run build && node dist/run-benchmarks.js …` yourself.
- **The core is otherwise local.** Kernels, the tool bridge, custom tools, the notebook library, and the benchmark CLI involve no private URLs, profiles, or author-specific paths — only the subagent provisioning stack does.

Per-feature "Standalone setup notes" sections with exact file/line references: [docs/auto-routing-and-recovery.md](docs/auto-routing-and-recovery.md), [docs/benchmarks-and-evals.md](docs/benchmarks-and-evals.md), [docs/configuration.md](docs/configuration.md), [docs/custom-tools.md](docs/custom-tools.md), [docs/kernels.md](docs/kernels.md), [docs/notebook-library.md](docs/notebook-library.md), [docs/output-and-code-view.md](docs/output-and-code-view.md), [docs/sandboxing.md](docs/sandboxing.md), [docs/subagents.md](docs/subagents.md), [docs/tool-bridge.md](docs/tool-bridge.md)
