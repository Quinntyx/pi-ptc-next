# Calling pi tools from Python (the tool bridge)

## What it does

Inside an `exec_cell` Python cell you can call the host's pi tools — `read`,
`glob`, `find`, `grep`, `ls`, and optionally `bash`/`edit`/`write` plus any
opted-in custom tools — as ordinary `async` Python functions. The cell loops
over hundreds of files, greps, filters, and aggregates entirely inside Python,
and only the compact final result ever reaches the model's context. Every
nested call is executed by the real pi tool implementation in the host process,
so path handling, truncation behavior, and permissions are identical to direct
tool use.

## How it works

1. **Wrappers are generated host-side.** When a kernel is provisioned,
   `ToolRegistry.getCallableTools()` filters the host tool set against the
   policy settings (see *Configuration* below), and `generateToolWrappers()`
   (`src/tools/tool-wrapper.ts`) emits one typed `async def` per callable tool.
   The wrappers are injected into the kernel prelude, so `read(...)`,
   `grep(...)`, etc. are plain Python functions — not magic.
2. **RPC transport.** Python and Node exchange line-delimited JSON over the
   kernel's stdin/stdout (`src/python-runtime/rpc.py`, `src/rpc-protocol.ts`).
   Python sends `{"type":"tool_call","id":"call_N","tool":...,"params":...}`;
   the host validates the params against the tool's TypeBox schema, runs the
   real tool with `caller: code_execution` metadata, normalizes the result
   (`src/tool-adapters.ts`), and answers with a `tool_result` frame carrying
   either `value` or an `error` payload (`message` + `stack`), which raises
   `ToolCallError` in Python.
3. **Result normalization.** Results are converted to Python-friendly shapes:
   `read` → `str`; `find`/`glob`/`ls` → `list[str]` (pi's trailing bracketed
   truncation notices are stripped; empty results are `[]`, not sentinel
   strings); `grep` → a dict
   `{"matches": [{"path", "line", "text", "kind"}, ...], "matchLimitReached": int | None}`;
   `bash` → `{"stdout", "stderr", "exitCode"}`; `edit` → `{"ok", "summary", "diff"}`;
   `write` → `{"ok", "summary"}`. Unknown tools return their text content as a
   string. A tool whose details contain `ptcValue` passes that value through
   verbatim, which is how custom tools can return rich objects.
4. **Robustness.** Call futures are registered *before* the request is written,
   so a fast host response is never dropped. A single malformed stdin line is
   skipped with a stderr log; only 100 consecutive bad frames trip the wire.
   Host EOF or a broken pipe fails all pending calls with `RpcProtocolError`
   and signals the session loop to shut down. On Windows (ProactorEventLoop) a
   daemon thread pumps stdin into the same reader loop.
5. **Timeouts.** Each Python→host call has a 300 s default timeout
   (`Tool call '<tool>' timed out`); the whole cell has a separate hard timeout
   (`PTC_EXECUTION_TIMEOUT_MS`, default 270 000 ms), so in practice the cell
   timeout fires first.
6. **Metrics.** The host tracks `nestedToolCalls`, `nestedToolNames`,
   `nestedResultChars`, `nestedResultCount`, and `nestedErrors` per cell and
   reports `estimatedAvoidedTokens = ceil(nestedResultChars / 4)` in the
   execution details.

The `exec_cell` / `inspect_kernel` / other PTC-owned tools are deliberately
excluded from the callable set so Python cannot recurse into the execution
tooling itself.

## Usage

By default the read-only builtins are callable. A realistic cell:

```python
# Inside exec_cell — top-level await is already available.
files = await glob("src/**/*.ts")

# grep returns a dict, not a bare list:
result = await grep("RpcProtocolError", path="src")
for m in result["matches"][:5]:
    print(m["path"], m["line"], m["text"])

# Bounded fan-out over file reads (concurrency defaults to
# PTC_MAX_PARALLEL_TOOL_CALLS, normally 8):
trees = await ptc.read_tree("src/contracts/*.ts", path=".", max_files=50)
total = sum(len(t["content"].splitlines()) for t in trees)
return {"files": len(trees), "lines": total}
```

The `ptc` helper object (`src/python-runtime/runtime.py`) provides:

| Helper | Purpose |
|---|---|
| `await ptc.gather_limit(coros, limit=None)` | `asyncio.gather` under a semaphore; default limit is `PTC_MAX_PARALLEL_TOOL_CALLS` |
| `await ptc.read_many(paths, max_concurrency=None, *, offset=None, line_limit=None)` | parallel `read()` |
| `await ptc.read_tree(pattern, path='.', max_files=1000, concurrency=None, offset=None, line_limit=None)` | find + read, returns `[{"path", "content"}, ...]` |
| `await ptc.find_files(pattern, path='.', max_files=1000)` | relative paths |
| `await ptc.find_files_abs(pattern, path='.', max_files=1000)` | host-absolute paths |
| `await ptc.read_text(path, offset=None, limit=None)` | alias of `read()` |
| `ptc.json_dump(value)` | sorted, indent-2, non-ASCII-preserving JSON string |

`np`, `pd`, and `plt` are lazy module proxies; `plt` forces the `Agg`
matplotlib backend and any open figures are captured automatically into the
cell result as image artifacts.

Rules to remember:

- Don't call `asyncio.run(...)` (the kernel already runs an event loop) and
  don't call `_rpc_call(...)` directly — use the generated wrappers.
- Don't spawn child processes that read stdin or write to stdout; they inherit
  the RPC pipes and can corrupt the protocol. Use
  `subprocess.run([...], stdin=subprocess.DEVNULL, capture_output=True)`.
- Keep intermediates local; `print()`/`return` only compact summaries.

## Options / Configuration

All of these are environment variables read at tool-call selection time:

| Variable | Default | Effect |
|---|---|---|
| `PTC_CALLABLE_TOOLS` | unset | Comma-separated allowlist of callable tools (e.g. `read,glob,find,grep,ls`). When set, *only* these tools are callable. |
| `PTC_BLOCKED_TOOLS` | unset | Comma-separated denylist; wins over everything else. |
| `PTC_MAX_PARALLEL_TOOL_CALLS` | `8` | Default concurrency for `ptc.gather_limit()` / `ptc.read_many()` / `ptc.read_tree()`. |
| `PTC_EXECUTION_TIMEOUT_MS` | `270000` | Hard cell timeout; bounds the total time nested calls may take. |
| `PTC_DEBUG` | `false` | Debug logging. |

Notes on defaults:

- `true`/`1`/`yes`/`on` (case-insensitive) enable boolean flags; anything else
  keeps the default.
- Custom and extension tools are **not** callable from Python by default. They
  must declare `ptc.enabled: true`. Mutating tools are not gated (yolo mode —
  the Python process can edit files natively, so filtering is futile). A tool
  can restrict itself to `ptc.callers: ["direct"]` to stay invisible to Python.
- `glob()` is a first-class alias of pi's `find()` with identical parameters
  and defaults (`limit` defaults to 1000; `ls`'s `limit` defaults to 500).
- The model-facing `exec_cell` description is regenerated from the current
  callable set, listing the exact Python signatures available in the kernel.

## Standalone setup notes

Things that depend on the author's machine setup, and how to work around each:

- **Python interpreter resolution.** The kernel picks the interpreter in this
  order: `PTC_PYTHON_EXECUTABLE`, then the PTC venv at
  `~/.cache/pi-ptc/python-env/bin/python` (`Scripts\python.exe` on Windows) if
  it exists, then `python3`. The runtime requires **Python ≥ 3.10** and fails
  fast at startup otherwise. If your `python3` is older, set
  `PTC_PYTHON_EXECUTABLE=/path/to/python3.11`.
- **The `~/.cache/pi-ptc` venv** is created by the pi-subagents integration,
  not the tool bridge; on a fresh machine it simply won't exist and the
  fallback applies. Nothing in the tool bridge needs packages from that venv.
- **Reserved helper names.** The names `ptc`, `_rpc_call`, `read`, `find`,
  `glob`, `grep`, `ls`, `bash`, `edit`, `write` are reserved in the kernel
  namespace; a custom tool cannot claim them (only a tool literally named that
  may use its own name). Name custom Python helpers accordingly.
- **Workspace root mapping.** Paths passed to tools are resolved against the
  host's cwd, not the kernel's runtime root; `ptc.find_files_abs` maps
  runtime-root paths back to host-absolute paths. If you run the kernel in a
  sandbox with a different root, pass paths relative to the session cwd to
  stay portable.
- **Concurrency default.** `ptc.gather_limit`'s documented default of 8 is
  actually `PTC_MAX_PARALLEL_TOOL_CALLS`, which the author may have tuned;
  set it explicitly in your environment rather than relying on the value in
  examples.
- **Private infrastructure is not involved.** The tool bridge itself is fully
  local (pipes between the host process and the Python subprocess). The
  pi-subagents feature has author-specific defaults (private git URL,
  `~/docs/src/pi-subagents` checkout, `~/.config/pi/profiles/subagents`
  profile), but those affect subagent provisioning, not tool calls from
  Python.
