# PLAN — PTC persistent sessions + dynamic subagent workflows

Cross-repo plan. Work happens on one branch per plugin, tested independently, then
merged. Branches:

| Repo | Branch | Scope |
| --- | --- | --- |
| `~/docs/src/pi-subagents/main` | `main` (new repo) | Python library: spawn/monitor/steer pi subagents via pi-sock + tmux |
| `~/docs/src/pi-sock/main` | `subagent-relay` | pi-tool-tree activity relay + `get_activity` command |
| `~/docs/src/pi-ptc-next/main` | `persistent-sessions` | Persistent Python sessions, `provision_python_session`/`python_exec`/`python_session_to_script`, `/ptc`, subagent runtime UI |
| `~/.config/pi/profiles` | — (config only) | New `subagents` pi profile |

## Design lineage (decisions, in order)

1. **PTC is general; no default background behavior.** `python_exec` takes a
   `background` flag the model chooses itself. A user-facing `/ptc` command can
   dismiss a long-running blocking exec to the background ("User manually
   backgrounded this ptc run").
2. **`agent()` returns an `AgentHandle` immediately.** Awaiting it yields a
   response; handles also allow mid-flight steering and abort via pi-sock.
3. **No workflow auto-saving.** The unified export path is
   `python_session_to_script`.
4. **No subagent-side pause machinery.** "Pause" = abort via pi-sock; "resume" =
   re-send a prompt on the same socket (pi sessions persist on disk, so the agent
   continues where it left off). UI stop/run maps onto handle methods.
5. **Caps via env vars, not nested-state inspection.** `PI_SUBAGENT_DEPTH`
   tracks nesting depth; depth ≥ 1 forbids spawning (`import pi_subagents`
   raises). `PI_PTC_PRIMARY` is reserved (inherited by all children) for a future
   direct-report usage mesh — deferred, not built.
6. **AgentHandle vs AgentSession are separate concepts.** `AgentHandle` =
   currently-executing agent (wraps a pi-sock socket + tmux window). `AgentSession`
   = a pi session on disk (JSONL), used for trajectory inspection and resume.
   Responses (`AgentStrResponse(str)` / `AgentDictResponse(dict)`) are thin value
   objects with `.get_session()`; schemas are a first-class `agent()` parameter.

---

## Plugin 1: `pi-subagents` (new Python package)

Layout: `src/pi_subagents/{__init__.py,envcheck.py,tmuxenv.py,client.py,schema.py,
handle.py,session_file.py,response.py,registry.py,cli.py}` + `pyproject.toml`.
Stdlib-only; installed editable into the PTC venv by `setup.sh` so
`import pi_subagents` works in any interpreter on the machine. In PTC sessions it
is additionally **autoimported** (as `subagents`/`pi_subagents`), except in
subagent profiles (see plugin 3).

### Environment probing (`envcheck.py`, runs at import)

1. `PI_SUBAGENT_DEPTH` set → `raise NotImplementedError(...)` immediately. This
   is the hard kill-switch that bounds the tree at height 2: spawned agents
   cannot import the module at all.
2. `TMUX` unset, or `tmux display-message` fails → print a warning, set
   `_ENV_OK = False`, import normally. Every API call raises
   `NotImplementedError` (descriptive: "not running inside a tmux session").
3. Otherwise capture session name/id/window from tmux for window placement.

### Spawning (`tmuxenv.py` + `handle.py`)

- Unique socket name `subagent-<slug(name)>-<rand4>`; verify
  `~/.pi/pi-sock/<name>.sock` does not exist, retry with a new suffix on collision.
- `tmux new-window -d -P -F '#{window_id}' -t <session>: -n <window_name>
  -e PI_CODING_AGENT_DIR=... -e PI_SOCK_NAME=... -e PI_SUBAGENT_DEPTH=<d+1>
  [-e PI_PTC_PRIMARY=...] -e PTC_USE_DOCKER=false -e PTC_ALLOW_UNSANDBOXED_SUBPROCESS=true
  -c <cwd> <pi> "<prompt>"` (profile from `PI_SUBAGENTS_PROFILE`, default
  `~/.config/pi/profiles/subagents`; model/thinking flags optional).
- Env forwarding: caller's `PI_PTC_PRIMARY` is passed through unchanged; depth is
  always incremented. Caps: `PI_SUBAGENTS_MAX_CONCURRENT` (default 8).

### pi-sock client (`client.py`)

Pure-stdlib JSONL over the unix socket; sync (`socket` + reader thread) and
asyncio (`open_unix_connection`) paths. Commands used: `send`, `get_state`,
`get_message`, `subscribe`, `abort`. Settle detection: subscribe
`agent_settled` (correct "done": retries/compaction drained), with
`get_state().isIdle` polling fallback and a settle timeout. Liveness: socket
disappearance + tmux window check → status `dead`.

### The agent API

```python
# PTC (async) — default shape
handle = subagents.agent("Analyze failing tests in tests/", name="test-digger")
resp  = await handle                       # AgentStrResponse
resp  = await handle                       # str behavior fully preserved
d = await subagents.agent("Classify these tests", schema={...})   # AgentDictResponse
await handle.send_async("focus on auth first", mode="steer")      # steering
await handle.abort_async()                 # "pause" — handle closes
await handle.resume_async()                # explicit un-close + continue
resp = handle.wait(timeout=600)            # sync API for plain scripts

# introspection (all on AgentSession, responses delegate)
s = resp.get_session()
s.tool_calls, s.thinking, s.prose, s.trajectory(), s.turns, s.duration_ms

subagents.list(); subagents.wait_all(handles, timeout=...); subagents.stop_all()
```

- `await handle` after an explicit abort (without resume) raises
  `ValueError: await on closed handle` — never an implicit resume.
- `resume_async()` sends a new prompt on the same socket, un-closes the handle,
  returns a fresh awaitable.
- Schema path: prompt augmented with a JSON-schema instruction, reply validated
  (bundled minimal validator), bounded retries (`PI_SUBAGENTS_SCHEMA_RETRIES`,
  default 3), then returned as `AgentDictResponse` (`.valid`, `.raw`).
- `AgentStrResponse(str)` / `AgentDictResponse(dict)` behave exactly like their
  base types in all other respects.

### Session JSONL inspection (`session_file.py`)

`AgentSession` lazily parses the pi session file (path from pi-sock
`get_state → sessionFile`): `.tool_calls` (`{tool, arguments, durationMs,
isError}`), `.thinking`, `.prose`, `.trajectory()` (ordered event stream),
`.turns`, `.duration_ms`. Parsing is on-demand; the plain-string path stays cheap.

### Registry + state emission (`registry.py`)

Module-level registry; every mutation emits a compact snapshot:

```json
{"agents": [{"id","name","status","startedAt","elapsedMs","socketPath","windowId",
             "toolCalls","thinkingMs","phase","label"}],
 "depth": 0, "pid": 12345}
```

Emitter: if `builtins.PTC_STATE_EMIT` is present (injected by the PTC session
runtime) → call it (rides the PTC RPC pipe as a `subagent_state` frame);
otherwise print a one-line status (`● 2 running · 1 done | test-digger: 3 calls ·
12.4s reading tests`) so standalone tmux scripts still give visible feedback.
Activity fields come from pi-sock `activity_change` events (plugin 2 relay);
without the relay they stay null and only basic status is reported.

### CLI (`python -m pi_subagents list|abort|prune`)

`list` enumerates `~/.pi/pi-sock/subagent-*.sock` with states; `abort <name>`;
`prune` sweeps sockets whose tmux window is gone.

**Tests**: pytest suite — client against a fake socket server, schema validator,
session-file parser on fixtures, env-guard matrix (tmux ok / no tmux / depth set),
handle await semantics incl. `ValueError` after abort, response subclasses.

---

## Plugin 2: `pi-sock` — branch `subagent-relay`

Additive protocol changes to `index.ts` (backward compatible; README updated):

1. **`get_activity` command** — feature-detect
   `globalThis[Symbol.for("pi-tool-tree:api")]`; respond with a trimmed snapshot
   (`phase, label, labelElapsedMs, isThinking, thinkingElapsedMs,
   calls[{toolName,label,elapsedMs}], run{elapsedMs,turns,toolCalls,thinkingMs}`)
   or `{available:false}` when pi-tool-tree is absent.
2. **`activity_change` subscribable event** — one persistent
   `api.subscribe((activity, change) => fire("activity_change", {...}))` at
   `session_start`; `fire()` already gates on current subscribers. Subscribing to
   it pushes an initial snapshot for late-joining clients.

**Tests**: socat smoke matrix — subagent-profile pi (with tool-tree), main
profile, tool-tree-less profile; `pisock` CLI regression.

*`pi-tool-tree` needs no changes — the published API is sufficient.*

---

## Plugin 3: `pi-ptc-next` — branch `persistent-sessions`

### 3.1 Persistent Python runtime (`src/python-runtime/`)

- `rpc.py` unchanged.
- `runtime.py` becomes common + one-shot: helpers/proxies/tracing/capture stay;
  the trailing `_runtime_main` invocation becomes conditional on
  `PTC_MODE` (`"oneshot"` default, `"session"` skips it).
- New `session.py`: persistent exec loop reading JSONL frames from stdin:
  - host → `{"type":"exec","id","code","user_code_line_count"}`;
  - python → `execution_progress`/`stdout` frames (unchanged), then
    `{"type":"exec_done","id","output","images","total_output_chars"}` or
    `{"type":"exec_error","id","message","traceback"}` — errors never kill the
    session; plus `{"type":"subagent_state","snapshot":{...}}` at any time
    (bridge, below) and `{"type":"session_ready"}`.
- One persistent namespace per session. Every chunk compiles as a function body
  (sync `def` or `async def` when top-level await is present) so `return` keeps
  working, and function locals are merged back into the namespace after the call
  (IPython-style), so imports/definitions persist. Reserved names are excluded
  from the merge; merge semantics documented in tool descriptions.
- Prelude injections: `builtins.PTC_STATE_EMIT = (snap) => emit
  {"type":"subagent_state","snapshot":snap}`, plus `PTC_SESSION_ID`,
  `PTC_SUBAGENT_DEPTH`, and `pi_subagents`/`subagents` autoimports
  (`_LazyModuleProxy`) — **excluded when `PI_SUBAGENT_DEPTH` is set**.
- Exec loop strictly serialized per session; multiple sessions run concurrently
  (cap `PTC_MAX_PYTHON_SESSIONS`, default 4).

### 3.2 Host side

- `PythonSessionManager`: `Map<id, {proc, rpc, chunks[], createdAt, lastUsedAt,
  execSeq, recentBackground[]}>`; per-session exec queue; per-session dispose
  (existing process-group teardown), `disposeAll()` on `session_shutdown` and on
  extension reload (old instance tracked via `globalThis`).
- `PersistentRpcProtocol`: `RpcProtocol` generalized — per-exec completion
  promises, new frames (`exec_done`, `exec_error`, `subagent_state`,
  `session_ready`), per-exec watchdog, process-exit fails all pending.
- Timeout: `executionTimeoutMs` applies per exec; backgrounded timeouts arrive as
  a completion message with the error instead of failing a tool call.

### 3.3 Tools

| Tool | Params | Behavior |
| --- | --- | --- |
| `provision_python_session` | `script?` | Spawn persistent interpreter, return id. If `script`: executed first (chunk appended to cumulative buffer); on error return id + traceback so the model can repair in the resulting environment. |
| `python_exec` | `session_id, code, background?, wait_for?` | Unknown id → error listing live ids. Foreground: streaming progress + subagent panel, results inline — **no hidden default backgrounding**. `background: true`: tool ends immediately with `{backgrounded:true, exec_id}`; on completion the host injects a `[ptc-background-complete]` custom message with the output. `wait_for: exec_id`: block until a previously backgrounded exec in the same session completes, returning its output as a normal tool result. |
| `python_session_to_script` | `session_id?, path?, name?` | Assemble cumulative chunks into a durable script (`./.pi/scripts/<name>.py`, header comment with session id/timestamps/cell separators); top-level await anywhere → whole script wrapped in `async def main()` + `asyncio.run(main())`; header notes the persistent-namespace merge semantics. Returns absolute path for `edit`/`bash`/`write`/`read` follow-ups. |

- `code_execution` is retired; auto-routing and recovery prompts updated
  ("provision once, exec repeatedly, export when logic stabilizes").
- Settings additions: `PTC_MAX_PYTHON_SESSIONS`, `PTC_SCRIPTS_DIR`,
  `PTC_SUBAGENTS_PROFILE`, `PTC_SUBAGENTS_MAX_CONCURRENT`.

### 3.4 `/ptc` command

```
/ptc <background|bg|foreground|fg|kill> [session_id]
```

- No `session_id` → most recent session with activity, else error listing sessions.
- `background`/`bg`: dismiss the target's blocking exec; tool result becomes
  `"User manually backgrounded this ptc run"`.
- `foreground`/`fg`: inject a system-side message instructing the agent to call
  `python_exec` with `wait_for` on the pending backgrounded exec.
- `kill`: dispose the session interpreter and `kill()` every AgentSession it spawned.

### 3.5 Depth-aware system prompt

`PI_SUBAGENT_DEPTH` set → `before_agent_start` appends: "You are a pi subagent at
nesting depth N. Subagent spawning is unavailable (`pi_subagents` raises on
import). Use `provision_python_session`/`python_exec` for computation; report
your final answer as your last message." The subagent profile keeps PTC for
computation.

### 3.6 `PI_PTC_PRIMARY` reporting mesh — deferred

Env var set and inherited at spawn time (namespace reserved); no usage
reporting/watching built this round.

### 3.7 Subagent bridge + UI

- Python side: `pi_subagents` detects `builtins.PTC_STATE_EMIT` and emits
  `subagent_state` frames through the RPC pipe; standalone runs print status
  lines instead.
- Host side: frames validated, latest snapshot stored on session state +
  `globalThis`, forwarded via `onUpdate`.
- **Public API** on `globalThis[Symbol.for("pi-ptc:subagent-runtime")]`:
  `getSnapshot()` (sessions + per-agent fields + totals) and `subscribe(fn)` —
  for `pi-opencode-prompt` and other consumers; feature-detect style.
- Default UI: live subagent panel under the code view in `python_exec`'s partial
  render, footer status (`ctx.ui.setStatus`) refreshed per snapshot; suppressible
  via `ptcSubagentFooter: false` for custom-footfer users.

### 3.8 Tests

New: session manager lifecycle (provision/exec/error-keeps-alive/dispose),
persistent protocol frames, cumulative buffer, script assembly (with/without
awaits), background/foreground flows, `/ptc` targeting, depth env (autoimport
exclusion + system prompt), subagent-state plumbing + rendering, global API.
Adapted: process lifecycle, rpc protocol, index tool registration/routing.

---

## Plugin 4: profile + post-merge wiring (config only)

1. `ppi create subagents` — include `pi-sock`, `pi-tool-tree`, `pi-everforest-tui`,
   `pi-deepseek-router`, `pi-ptc-next`; exclude `pi-questionnaire`,
   `pi-permissions`, `pi-buddy-extension`, `pi-cwd-handoff`, `pi-idle-time`,
   `pi-session-move`, `pi-web-access` (unless needed).
2. `setup.sh`: add `uv pip install --editable ~/docs/src/pi-subagents/main`.
3. Post-merge: `pi update` in both profiles; end-to-end test from the main profile
   (auto-route → provision → spawn subagents → live panel → script export →
   aggregate results only in the main session's context).

## Risks

- **Zombie interpreters**: persistent sessions rely on process-group teardown;
  verify reaping (`ps aux | rg python`) after dispose/shutdown.
- **Global socket dir**: `~/.pi/pi-sock/` is shared across profiles → strict
  `subagent-*` naming + collision check; `prune` for sweeps.
- **Session lifetime**: no auto-reap; sessions die at `session_shutdown`/reload.
- **Export semantics**: chunk merge replay has edge cases (`del`, `global`
  rebinding of module names) — documented in the tool description.
