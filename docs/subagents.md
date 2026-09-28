# Subagent orchestration (`pi_subagents`)

## What it does

The subagent feature lets the model fan work out to multiple real pi instances — each one an interactive pi session running in its own tmux window — and orchestrate them from Python cells: submit tasks to typed stages, consume results in completion order, steer or reuse running agents, and chain multi-stage build/review/fix loops. The orchestration API (`pi_subagents`) is a Python module that is provisioned automatically on session start and auto-imported into every PTC kernel, while the TypeScript side of the extension renders a live panel of what every spawned agent is doing and summarizes finished runs into the transcript.

## How it works

**Provisioning.** `pi_subagents` is *not* part of the npm install. At extension startup (unless `PI_SUBAGENT_DEPTH` is set), `ensureSubagentsEnv` runs fire-and-forget (`src/index.ts:1640-1644`, `src/subagents-env.ts`):

1. Ensures a venv at `~/.cache/pi-pycells/python-env-3.14` exists (`uv venv --python 3.14`; uv is required, no fallback). Kernels always run on this venv's interpreter, even for users who never touch subagents.
   **Provisioning only runs when `PI_SUBAGENTS_MAX_CONCURRENT` is set** — subagents are opt-in; without it nothing is downloaded and cells importing `pi_subagents` get a hint explaining how to enable them.

Syncs are throttled by a stamp file, `<extensionRoot>/.ptc-subagents-sync.json`, that lives *inside this package's clone* — so `pi update` (which resets package clones) forces a fresh sync on the next session start. Between updates the interval defaults to 24 hours (`PTC_SUBAGENTS_SYNC_INTERVAL_HOURS`). A failed stamp with the runtime still missing retries immediately. Syncs are serialized by a pid-tagged lock file (dead holders' locks are broken; legacy timestamp locks use a 5-minute age heuristic), and all output goes to `~/.cache/pi-pycells/subagents-sync.log` (rotated at 1 MB).

**Import and depth.** The kernel prelude auto-imports the module as both `pi_subagents` and `subagents` (`src/execution/session-prelude.ts:37-52`). When `PI_SUBAGENT_DEPTH` is set (pi's convention for spawned subagents), the autoimport is skipped; the import itself raises `NotImplementedError` at depth ≥ 1, and the extension adds a system-prompt note telling the agent that spawning is unavailable but `exec_cell` still works (`src/index.ts:1534-1544`). Spawned agents can never spawn agents.

**Runtime.** Each `subagents.Task` becomes a real interactive pi process in a tmux window titled `pi - (subagent) <name> - <cwd>`, prompted over a per-agent unix socket. Spawned agents run under the orchestrator's agent dir by default, or `PI_CODING_SUBAGENT_DIR` when set (see Configuration). Progress flows back as `subagent_state` frames over the kernel's RPC pipe (`src/python-runtime/session.py:32-36`), fans out through the session manager to:

- A **live panel** under the running cell, grouped by pool/stage (`src/execution/subagent-panel.ts`): ○ starting, ● running, ✓ settled, ✗ failed, with elapsed time, tool-call counts, context usage, and the current tool call. Queued rows are capped at 2 (`… N more queued`); group elapsed time freezes at the furthest completed endpoint when nothing is executing.
- A **status footer** — `subagents: ● N running · ✓ M done` — filtered to agents relevant to the current exec (`src/index.ts:1459-1488`).
- A **per-cell `subagents:` summary** in the exec-done report, built defensively so a broken registry can never break cell reporting (`src/python-runtime/session.py:407-443`).
- A **transcript notification** (customType `subagent-notification`) persisting the finished fan, since collapsed tool results would otherwise erase it (`src/index.ts:1240-1250`).
- A **global API** on `globalThis[Symbol.for('pi-ptc:subagent-runtime')]` with `getSnapshot()` / `subscribe(fn)` for external UI consumers (`src/index.ts:1413-1457`).

## Usage

Orchestration lives in `exec_cell` cells. A whole workflow is normally one cell (top-level `await` is available; never `asyncio.run`):

```python
import pi_subagents as subagents   # also autoimported as `subagents`

pool = subagents.AgentPool(concurrency=8, name="migration")
build  = pool.stage("build",  slots=4)   # slots are soft priority reservations;
review = pool.stage("review", slots=4)   # idle slots are borrowed; names unique per pool

# Tasks are immutable specs; metadata always carries an integer "rounds" (roots = 0).
hs = build.submit_all([
    subagents.Task(f"Migrate module {m}", name=f"build-{m}",
                   model="provider/model", thinking="high",
                   schema={"type": "object", "required": ["ok"],
                           "properties": {"ok": {"type": "boolean"}}},
                   metadata={"file": m, "rounds": 0})
    for m in ("auth.py", "api.py")
])

# Consume in completion order; None = quiescent (pool stays usable for follow-ups).
while (result := await pool.pop(timeout=600)) is not None:
    if result.stage is build and result.ok:
        verdict_src = result.unwrap()          # schema-obeying dict
        problems = "\n".join(f"- {p['file']}: {p['issue']}" for p in verdict_src["issues"])
        review.submit(subagents.Task(
            f"The build agent finished and reported these problems:\n{problems}\n"
            f"Review each fix in the working tree."), parent=result)
    elif result.stage is review:
        verdict = result.unwrap()              # body, or raises the stored error
        rounds = result.task.metadata["rounds"]
        if not verdict["ok"] and rounds < 5:   # REQUIRED: gate cyclic workflows,
            build.submit(subagents.Task("Fix it", metadata={"rounds": rounds + 1}),
                         parent=result)        # or pop()=None never ends the loop

summary = pool.close()   # the ONLY teardown: kills every window, invalidates
                         # handles, echoes the PoolSummary report
```

Key semantics:

- **Results** carry `task`, `stage`, `handle`, `body`, `error`, `status` (`settled`/`failed`/`cancelled`), `duration_ms`, `parent`, `ok`, `unwrap()`, and `session` (`tool_calls`, `thinking`, `prose`, `trajectory()`). Failures arrive as results with `ok=False`; only pop timeouts raise (`AgentPoolTimeoutError` with `.pool`/`.snapshot()`, leaving the pool intact).
- **Handles**: `await h` / `h.wait(timeout)`, `h.cancel()`, `h.send(text)` (steers the running turn only), and `h.state()` / `h.activity()` / `h.agent_state()` for inspection.
- **Session reuse**: continue a settled session with `stage.submit(new_task, session_handle=h)` — same tmux window, new handle. Omitted `model`/`thinking`/`cwd`/`profile` are inherited from the prior session; explicit conflicts raise `SessionReuseError`; `session_name="..."` renames the live session.
- **Lifecycle sugar**: `with subagents.AgentPool(...) as pool:` auto-closes on clean exit (report at `pool.last_summary`) but deliberately leaves the pool alive on exception so you can inspect and resume in a follow-up cell.
- **Model selection**: `subagents.best_model_match("flash")` resolves one pick (exact slug > profile default provider > first-party > proxied); `model_slugs` / `resolve_models` / `list_models` give full rows. The catalog expires after `PI_SUBAGENTS_CATALOG_TTL` (default 120 s); `list_models(refresh=True)` forces a re-read.
- **Prompt hygiene**: never f-string raw JSON (`result.body`) into a follow-up prompt — subagent prompts are user-observable in tmux windows. Parse in Python and restate in prose (as above).
- **Timeouts**: set explicit `Task.timeout` for models that can fail at the provider; an errored turn may otherwise sit out the default 30-minute settle timeout.

For long or destructive workflows, put the entire declared workflow in one cell and set `confirm=true` so the user approves the full plan up front, then it runs autonomously. Interrupts (Esc, `/ptc interrupt`) stop the cell — not the pool; resume with `pool.pop()` in the next cell. Avoid `/ptc kill` mid-workflow: it drops the interpreter and orphans running windows.

## Options / Configuration

### Environment variables (this extension)

| Variable | Default | Purpose |
| --- | --- | --- |
| `PTC_SUBAGENT_FOOTER` | `true` | Set `false` to hide the `subagents:` status footer (for custom footers consuming the `pi-ptc:subagent-runtime` API) |
| `PTC_SUBAGENTS_SOURCE` | `~/docs/src/pi-subagents` | Dev checkout to install `pi_subagents` from, preferred over the managed clone |
| `PTC_SUBAGENTS_REPO_URL` | `https://github.com/Quinntyx/pi-subagents` | Git source for the managed clone |
| `PTC_SUBAGENTS_SYNC_INTERVAL_HOURS` | `24` | Minimum interval between pi_subagents syncs |
| `PI_SUBAGENT_DEPTH` | unset | Set by pi on spawned subagents; suppresses the autoimport and provisioning — subagents cannot spawn subagents |

### Runtime knobs (read by the `pi_subagents` Python module)

| Variable | Default | Purpose |
| --- | --- | --- |
| `PI_SUBAGENTS_MAX_CONCURRENT` | *(unset — subagents disabled)* | Set to a positive number to enable subagents; also the global cap across all pools (stage `slots` are priorities, not hard limits). pi-pycells provisions the `pi_subagents` module when this is set. |
| `PI_SUBAGENTS_CATALOG_TTL` | `120` s | Model-catalog cache lifetime before a live re-check |
| `PI_CODING_SUBAGENT_DIR` | *(unset — subagents share the orchestrator's agent dir)* | Agent dir spawned subagent instances run under (env `PI_CODING_SUBAGENT_DIR`; the Task `profile` kwarg can override per task) |

### Settings

- `subagentFooter` (`src/contracts/settings.ts:23`) — the settings-file form of `PTC_SUBAGENT_FOOTER` (default `true`).

## Standalone setup notes

This feature was built on the author's machine and several defaults only work there. Workarounds:

- **Source URL.** `PTC_SUBAGENTS_REPO_URL` defaults to the public GitHub mirror (`https://github.com/Quinntyx/pi-subagents`) and works anonymously. Point it at your own fork if you maintain one: `export PTC_SUBAGENTS_REPO_URL=https://github.com/<you>/pi-subagents`. The provisioner shells out to plain `git`, so the URL must be reachable by your credential helper.
- **Author-specific dev-checkout path.** `PTC_SUBAGENTS_SOURCE` defaults to `~/docs/src/pi-subagents` (joined from your homedir, `src/subagents-env.ts:50`). If you don't have that directory nothing breaks — resolution falls through to the managed clone — but set `PTC_SUBAGENTS_SOURCE` if you keep a checkout elsewhere.
- **tmux is the only hard requirement.** `pi_subagents` warns at import when not running under tmux (its API then raises `NotImplementedError`). Spawned agents run under the orchestrator's own agent dir by default, so your existing extensions (pi-sock for prompt delivery — required for spawning — and optionally pi-tool-tree) and auth carry over with zero setup. For a separate subagent environment set `PI_CODING_SUBAGENT_DIR` to any directory with a pi config.
- **`pi_subagents` is not on PyPI / npm.** It is fetched from git at sync time. Without network access to a valid repo, provisioning fails (stamped, and logged to `~/.cache/pi-pycells/subagents-sync.log`); a previous working checkout or dev source keeps working. You can also supply any checkout via `PTC_SUBAGENTS_SOURCE` — it must contain a `pyproject.toml` at its root or under a `main/` subdirectory.
- **Machine cache layout.** The venv (`python-env/`), managed clone (`pi-subagents/`), sync log, and lock file all live under `~/.cache/pi-pycells/` (non-configurable in code). The venv is used for *all* PTC kernels, even if you never use subagents; delete it if you want kernels on a different interpreter.
- **`uv` and `git` assumed.** `uv` is preferred for venv creation and editable installs (falls back to `python3 -m venv` / `pip`); `git` is required for the managed-clone path.
- **Sync-stamp quirk.** The repo currently tracks `.ptc-subagents-sync.json` containing the author's absolute `editablePath` — harmless at runtime (it's just a stale stamp that triggers one extra sync), but expect a diff on first run.
- **pi-depth convention.** "Subagents can't spawn subagents" relies on pi's `PI_SUBAGENT_DEPTH` env convention. In hosts that don't set it, the depth-note system prompt simply never applies; the pool API is unaffected.
