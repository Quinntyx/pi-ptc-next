# pi-ptc-next

`pi-ptc-next` adds persistent Python tool-calling sessions to pi. The model provisions a Python session, sends code chunks to it with `python_exec`, Python calls local pi tools through an internal RPC bridge, and only each chunk's final output is returned to the model context. Sessions also expose pi-subagent orchestration via the autoimported `pi_subagents` module.

This is **not** Anthropic's provider-native PTC wire protocol. Instead, it implements the same core local behavior in a way that can work across multiple labs and models such as GPT-5.4, GLM-5, and Claude-class models.

## Fork history and credits

This repository started from the original [`cegersdoerfer/pi-ptc`](https://github.com/cegersdoerfer/pi-ptc) by [@cegersdoerfer](https://github.com/cegersdoerfer) (Chris Egersdoerfer).

This fork exists because I wanted to keep pushing the extension toward a more provider-agnostic and production-ready local PTC implementation for pi instead of a Claude-leaning prototype.

The main work done here includes:

- refactoring the codebase into clearer execution, contract, and tool submodules
- replacing the split loader/watcher flow with an authoritative custom tool manager
- tightening the runtime protocol and execution error boundaries
- making subprocess execution explicit opt-in and improving Docker behavior
- adding direct behavioral tests for the core execution/runtime/tooling paths
- improving package loading, vendoring local reference material for PTC/advanced tool use, and benchmarking real pi usage

If you are looking for the original version or the starting point for this fork, please see the upstream repository above.

## Installation

Install directly from GitHub:

```bash
pi install git:github.com/edxeth/pi-ptc-next
```

This fork is published publicly as **pi-ptc-next** to distinguish it from the original `pi-ptc` repository while preserving clear attribution to Chris Egersdoerfer's upstream work.

### pi_subagents auto-provisioning

The Python half of the subagent workflow (`import pi_subagents` inside `python_exec` sessions) is provisioned automatically — it is **not** part of the npm install:

- On session start the extension ensures `~/.cache/pi-ptc/python-env` exists (creating it with `uv venv` or `python3 -m venv` as needed) and installs `pi_subagents` editable into it.
- Source resolution: a dev checkout at `~/docs/src/pi-subagents` (override `PTC_SUBAGENTS_SOURCE`) is preferred; otherwise a managed clone at `~/.cache/pi-ptc/pi-subagents` is cloned/updated from `PTC_SUBAGENTS_REPO_URL`.
- The sync stamp lives inside this package's clone, so `pi update --extensions` (which resets and cleans package clones) triggers a fresh sync on the next session start — pi_subagents updates independently of pi-ptc-next releases.
- Runs are serialized by a lock file, failures are stamped (no per-session retry storms), and everything is logged to `~/.cache/pi-ptc/subagents-sync.log`.
- Spawned subagents skip provisioning entirely (the autoimport is excluded at depth ≥ 1 anyway).

If you use a private pi-subagents repo, make sure your git credential helper can read it (the provisioner shells out to plain `git`).

## What using it feels like now

Use it normally.

For simple requests, the agent should still use direct tools like `read`, `grep`, and `find`.
For strong PTC-shaped requests, the extension now biases the agent toward `python_exec` proactively.

Common auto-routing signals:

- repo-wide or multi-file analysis
- repeated lookups across many inputs
- counting, grouping, ranking, filtering, or aggregation
- prompts like "compact JSON only" or "keep intermediate results out of chat"

This behavior is enabled by default with `PTC_AUTO_ROUTE=true`.

## Why this exists

Without PTC, multi-step tool use usually looks like this:

1. Model calls a tool
2. Tool result comes back into the conversation
3. Model reasons over that result in-context
4. Repeat for every additional tool call

That is expensive for large intermediate results.

With `python_exec`, the model can do this instead:

1. `provision_python_session` once
2. Write Python chunks that call tools as async functions
3. Filter/aggregate/loop locally — definitions, imports, and variables persist across chunks
4. Return only compact final answers
5. Export the cumulative code as a durable script with `python_session_to_script` when the logic stabilizes

## What changed in this version

This implementation now focuses on provider-agnostic reliability:

- Added a real hard execution timeout for the whole Python run
- Added a `glob()` alias over pi's `find()` behavior for model ergonomics
- Normalized common built-in tool results into Python-friendly values
- Excluded `code_execution` from calling itself recursively
- Added local tool opt-in metadata for custom/extension tools
- Added nested execution metrics such as nested tool count and estimated avoided tokens
- Added bounded concurrency helper utilities in Python
- Added `ptc.read_tree(...)` for deterministic find+read workflows
- Added bounded async-only auto-recovery for common first-attempt async wrapper mistakes
- Added ephemeral request telemetry for routing, first-path, recovery count, and terminal state in successful `code_execution` details
- Added deterministic JSON eval cases and a local benchmark runner for routing/recovery checks
- Added regression coverage for mutation-prompt exclusion, one-shot recovery limits, and per-request state reset

## Available Python functions

By default, Python code inside `python_exec` can call a safe built-in subset:

- `read(path, offset=None, limit=None) -> str`
- `glob(pattern, path='.', limit=1000) -> list[str]`
- `find(pattern, path='.', limit=1000) -> list[str]`
- `grep(...) -> list[dict]`
- `ls(path='.', limit=500) -> list[str]`

Optional tools can be enabled via environment/config policy:

- `bash(...) -> dict`
- `edit(...) -> dict`
- `write(...) -> dict`

Custom and extension tools are **not callable from Python by default**. They must explicitly opt in with `ptc.enabled: true`.

This fork also supports caller routing metadata via `ptc.callers`:

- `callers: ["direct"]` — direct-only tool
- `callers: ["code_execution"]` — Python-only tool
- `callers: ["direct", "code_execution"]` — both

## Model-facing usage rules

The `python_exec` tool is best for:

- 3+ dependent tool calls
- loops, filtering, aggregation, and batching
- large intermediate results that should stay out of chat history
- inspecting many files and returning a compact summary

Avoid it for:

- one simple tool call
- workflows where the user explicitly needs every raw intermediate result in the chat transcript

Important runtime rules:

- Top-level `await` is already available
- Do **not** call `asyncio.run(...)`
- Do **not** call `_rpc_call(...)` directly; use the generated wrappers and `ptc.*` helpers
- Prefer returning compact JSON or summaries
- Intermediate tool results stay local unless you explicitly print or return them

## Interrupting a chunk

`python_exec` never kills a session to stop a chunk. Both aborting the tool call
(Esc in the TUI) and the idle timeout send **SIGINT into the interpreter** — the
same thing Ctrl-C does — so the running chunk raises `KeyboardInterrupt` /
`CancelledError` at the point where it was stuck and the session stays alive with
its namespace intact.

The tool call then fails with the Python stack of the interruption, e.g.:

```
Execution aborted (Ctrl-C); the running chunk was interrupted (the session is still alive).
Stopped at:
  chunk line 4: await subagents.wait_all_async(handles)
Python said: CancelledError: chunk execution was interrupted

Python traceback:
  File "<ptc-cell-1>", line 4, in _ptc_cell
  File ".../asyncio/tasks.py", line 702, in sleep
asyncio.exceptions.CancelledError
```

One nuance for aborts: pi races the tool's abort signal
(`raceWithAbortSignal`), so pressing Esc rejects the tool call with pi's own
`AbortError` *before* the interrupted chunk reports back. In that case the same
report is queued as a `ptc-interrupt` message (`deliverAs: nextTurn`) and reaches
the model on its next turn. Idle **timeouts** reject normally, so their stack is
in the tool error field directly.

Because the namespace survives, everything the chunk had already created is still
there — including `pi_subagents` handles, so an interrupted fan-out can simply be
awaited again in a later chunk:

```python
responses = await subagents.wait_all_async(handles)   # handles survived the abort
```

The idle timeout is reported the same way (`PtcTimeoutError` + "Stopped at: …" +
traceback). Use `/ptc interrupt [session_id]` to stop the running chunk from the
TUI without Esc, or `/ptc kill` to drop the session entirely.

If the interpreter cannot be interrupted (stuck somewhere native), the host gives
it a short grace period and then forces it down.

## Session footguns

- Child processes spawned from a `python_exec` chunk inherit the interpreter's RPC pipes. Any child that reads stdin or writes to stdout will corrupt the protocol and hang the session — always pass `stdin=DEVNULL` and capture stdout/stderr when using `subprocess` inside a session (e.g. `subprocess.run([...], stdin=subprocess.DEVNULL, capture_output=True)`).

## Python helpers

The runtime also exposes a `ptc` helper object:

- `await ptc.gather_limit(coros, limit=8)`
- `await ptc.read_many(paths, max_concurrency=None, offset=None, line_limit=None)`
- `await ptc.read_tree(pattern, path='.', max_files=1000, concurrency=None, offset=None, line_limit=None)`
- `await ptc.find_files(pattern, path='.', max_files=1000)`
- `await ptc.find_files_abs(pattern, path='.', max_files=1000)`
- `await ptc.read_text(path, offset=None, limit=None)`
- `ptc.json_dump(value)`

Example:

```python
entries = await ptc.read_tree(pattern="**/*.ts", path="src", concurrency=6)
return {
    "files": len(entries),
    "sample_lengths": [len(entry["content"]) for entry in entries[:3]],
}
```

## Result normalization

pi tools are normalized before being returned to Python:

- `read` returns a string
- `find`, `glob`, and `ls` return `list[str]`
- `grep` returns `list[dict]`
- `bash`, `edit`, and `write` return dictionaries
- empty `find`/`ls`/`grep` results become empty lists rather than English sentinel strings

This makes the runtime easier for non-Anthropic models to use reliably.

## Local tool policy

This extension uses a local provider-agnostic equivalent of `allowed_callers`.

### Built-ins

Safe read-only built-ins are callable by default.

### Mutating tools

`bash`, `edit`, and `write` are blocked unless explicitly enabled.

### Custom and extension tools

These must opt in with:

```js
ptc: {
  enabled: true,
  readOnly: true,
  callers: ["code_execution"], // optional: direct | code_execution | both
}
```

Recommended routing patterns:

- `callers: ["direct"]` — user-facing tool that the model should call directly
- `callers: ["code_execution"]` — helper tool intended only for Python/PTC workflows
- `callers: ["direct", "code_execution"]` — shared tool usable from either path

If a custom tool is marked code-execution-only, `pi-ptc-next` will register it but will not auto-activate it as a direct tool in the session.

## Environment variables

### Execution

- `PTC_USE_DOCKER=true` — run Python inside Docker instead of a local subprocess
- `PTC_ALLOW_UNSANDBOXED_SUBPROCESS=true` — explicitly opt into local subprocess mode when Docker is not used
- `PTC_EXECUTION_TIMEOUT_MS=270000` — hard timeout for the full Python execution
- `PTC_MAX_OUTPUT_CHARS=100000` — truncate final output after this many characters
- `PTC_MAX_PARALLEL_TOOL_CALLS=8` — default concurrency for `ptc.gather_limit()`

### Tool policy

- `PTC_ALLOW_MUTATIONS=true` — allow mutating tools from Python
- `PTC_ALLOW_BASH=true` — allow `bash` from Python
- `PTC_AUTO_ROUTE=true` — auto-route repo-wide analysis prompts toward `python_exec` (default: true)
- `PTC_AUTO_RECOVER=true` — enable one bounded async-only recovery hint after a qualifying first-attempt `python_exec` failure (default: false)
- `PTC_MAX_PYTHON_SESSIONS` — concurrent persistent interpreters (default: 4)
- `PTC_SCRIPTS_DIR` — default export directory for `python_session_to_script` (default: `./.pi/scripts`)
- `PTC_SUBAGENTS_PROFILE` — pi profile directory `pi_subagents` launches subagent instances with (default: `~/.config/pi/profiles/subagents`)
- `PTC_SUBAGENTS_REPO_URL` — where the provisioner clones pi-subagents from (default: `https://git.quinntyx.dev/quinntyx/pi-subagents`)
- `PTC_SUBAGENTS_SOURCE` — dev checkout of pi-subagents to install editable instead of the managed clone (default: `~/docs/src/pi-subagents` when present)
- `PTC_SUBAGENTS_SYNC_INTERVAL_HOURS` — min interval between pi_subagents syncs (default: 24)
- `PTC_SUBAGENT_FOOTER=false` — hide the subagent status footer element (for custom footers consuming the `pi-ptc:subagent-runtime` API)
- `PTC_AUTO_RECOVER_MAX_ATTEMPTS=1` — bounded recovery cap; values above `1` are clamped back to `1`
- `PTC_TRUSTED_READ_ONLY_TOOLS=query_db,fetch_metadata` — allowlisted custom tools treated as read-only when mutations are disabled
- `PTC_CALLABLE_TOOLS=read,glob,find,grep,ls` — explicit allowlist override
- `PTC_BLOCKED_TOOLS=bash,write` — explicit denylist override
- `PTC_EVALS_PATH=.pi/evals/ptc` — override the JSON eval/benchmark root used by the benchmark runner

## How it works

```text
User request
  ↓
Model calls code_execution
  ↓
pi-ptc builds Python wrappers for callable tools
  ↓
Python runtime executes user code
  ↓
Python calls tools over local JSON RPC
  ↓
Node executes real pi tools
  ↓
Results are normalized into Python-friendly values
  ↓
Python returns one compact final output
```

## Architecture

- `src/index.ts` — registers `code_execution` and model guidance
- `src/code-executor.ts` — execution orchestration and global timeout
- `src/tool-registry.ts` — tool discovery, policy, and caller metadata
- `src/tool-adapters.ts` — normalization of pi tool results
- `src/rpc-protocol.ts` — Node-side RPC bridge and nested metrics
- `src/python-runtime/runtime.py` — Python runtime and helpers
- `src/python-runtime/rpc.py` — Python-side RPC client
- `src/custom-tool-manager.ts` — authoritative custom tool loading, registration, and hot reload
- `src/execution/` — execution session, sandbox, runtime assets, and error boundaries
- `src/tools/` — Python helper contracts, wrapper generation, and tool policy integration

## Execution modes

### Subprocess mode

Explicit opt-in mode.

Enable with:

```bash
export PTC_ALLOW_UNSANDBOXED_SUBPROCESS=true
```

Behavior:

- runs `python3 -u -c ...` in the current working directory
- simplest setup
- suitable for trusted local use
- only enabled when Docker mode is disabled
- if neither `PTC_USE_DOCKER=true` nor `PTC_ALLOW_UNSANDBOXED_SUBPROCESS=true` is set, PTC refuses to execute Python

### Docker mode

Enable with:

```bash
export PTC_USE_DOCKER=true
```

Behavior:

- uses `python:3.12-slim`
- disables network access
- mounts the workspace read-only
- applies container memory/CPU limits
- reuses the container for multiple executions during the session

## Execution limits

- Hard timeout: `PTC_EXECUTION_TIMEOUT_MS` (default `270000` ms)
- Max final output: `PTC_MAX_OUTPUT_CHARS` (default `100000` chars)
- Per nested tool call timeout: 300 seconds in the Python RPC client
- Cancellation: abort signals are supported

## Custom tools

Drop `.js` files into `tools/`.

Example:

```js
export default {
  name: "query_db",
  description: "Run a read-only database query",
  parameters: {
    type: "object",
    properties: {
      sql: { type: "string" },
    },
    required: ["sql"],
  },
  ptc: {
    enabled: true,
    readOnly: true,
  },
  async execute(toolCallId, params, signal, onUpdate, ctx) {
    return {
      content: [{ type: "text", text: "Query completed" }],
      details: {
        ptcValue: {
          rows: [],
          rowCount: 0,
        },
      },
    };
  },
};
```

If `details.ptcValue` is present, that JSON-compatible value is returned directly to Python.

## Hot reload

Custom `.js` tools in `tools/` are watched and hot-reloaded while the session is running.

## Routing notes

This fork now implements a local/provider-agnostic equivalent of Anthropic's `allowed_callers` guidance.

Important practical points:

- `code_execution` is still just a tool choice from the model's perspective; nothing native in pi forces a model to use it.
- To improve reliability, the extension now adds two layers of steering:
  - stronger `code_execution` tool descriptions/examples
  - prompt-time auto-routing for requests that look like clear PTC fits
- Auto-routing is deliberately conservative and avoids prompts that look like editing or implementation tasks.

### Bounded async-only recovery

Optional recovery is intentionally narrow.

- Enable it with `PTC_AUTO_RECOVER=true`.
- Recovery only applies to `code_execution` failures that clearly come from using async helpers like `read`, `glob`, `find`, `grep`, or `ls` without `await`.
- The extension appends one deterministic corrective hint on the next turn and allows at most one automatic recovery attempt per user request.
- Mutation prompts are ineligible, and the initial implementation does not broaden literal path semantics or auto-recover zero-match path cases.
- Recovery metadata is additive only: successful `code_execution` results include `details.telemetry` and `details.recovery`, but no persistent telemetry sink is written outside benchmark result files.

For the deeper technical explanation and research notes, see [`docs/PTC-RESEARCH.md`](docs/PTC-RESEARCH.md).

## Deterministic JSON evals and benchmarks

Seeded eval cases live under `.pi/evals/ptc/cases` and use stable JSON files:

```json
{
  "id": "recovery-missing-await",
  "prompt": "Use Python to read package.json and return compact JSON only.",
  "expected_first_path": "code_execution",
  "acceptance": {
    "type": "behavioral",
    "rules": [
      "observed_first_path=code_execution",
      "recovery_attempted=true",
      "failure_class=missing-await",
      "success=true"
    ]
  }
}
```

Current seeded buckets cover:

- positive repo-wide PTC routing
- negative direct single-file routing
- mutation-prompt negative controls
- async recovery cases for `missing-await` and `async-wrapper-iterated`

Build first, then run the benchmark CLI directly from `dist`:

```bash
npm run build
node dist/run-benchmarks.js \
  --provider local \
  --model seeded \
  --evals-path .pi/evals/ptc \
  --cases recovery-missing-await
```

Useful flags:

- `--results-path <file>` to write a specific JSON result file
- `--baseline <file>` to compare against a saved baseline without changing source planning docs
- `--timestamp <iso>` for deterministic output paths in CI or local comparisons

Each result record includes at least `case_id`, `observed_first_path`, `success`, `recovery_attempted`, `failure_class`, `total_tokens`, and `duration_ms`.

Successful `code_execution` runs also expose additive request metadata in tool result details:

```json
{
  "telemetry": {
    "autoRouted": false,
    "firstToolPath": "code_execution",
    "codeExecutionAttempts": 2,
    "recoveryAttemptCount": 1,
    "terminalState": "success"
  },
  "recovery": {
    "eligible": true,
    "attempted": true,
    "failureClass": "missing-await"
  }
}
```

## Further reading

- Technical findings and implementation notes: [`docs/PTC-RESEARCH.md`](docs/PTC-RESEARCH.md)
- Anthropic advanced tool use snapshot: [`docs/advanced-tool-use.md`](docs/advanced-tool-use.md)
- Anthropic PTC docs snapshot: [`docs/programmatic-tool-calling.md`](docs/programmatic-tool-calling.md)

## Metrics

Completed `code_execution` runs now record local nested execution stats, including:

- nested tool call count
- nested tool names
- nested result count
- nested result character volume
- estimated avoided tokens
- total duration

These metrics are stored in tool result details for benchmarking and debugging.

### Measured token savings

On the benchmark task of analyzing the first 8 `test/**/*.test.ts` files and returning compact JSON only, `pi-ptc` materially reduced token consumption by keeping intermediate file contents inside Python instead of sending them back through ordinary tool results.

Observed averages in this environment:

- GPT-5.4: `20,294.5` tokens with `pi-ptc` vs `88,158` without it (`76.98%` reduction)
- GLM-5: `16,973` tokens with `pi-ptc` vs `33,100` without it (`48.72%` reduction)

The exact totals vary by model behavior and tool strategy, but both model families successfully used `code_execution`, which demonstrates the provider-agnostic design in practice.

## Development

```bash
npm run build
npm test
```

## Troubleshooting

### `asyncio.run() cannot be called from a running event loop`

Remove `asyncio.run(...)` from model-generated Python. Top-level `await` is already available.

### Tool not callable from Python

Check one of these:

- the tool is blocked by policy
- it is mutating and `PTC_ALLOW_MUTATIONS` is disabled
- it is a custom/extension tool without `ptc.enabled: true`

### Why did Python get a list instead of text?

That is intentional for tools like `find`, `glob`, `ls`, and `grep`. The runtime normalizes those into structured values to improve cross-model reliability.

## License

MIT
