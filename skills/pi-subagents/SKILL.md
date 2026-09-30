---
name: pi-subagents
description: "Use when a task fits dynamic subagent workflows - fanning work out
  across multiple pi agents (per-file audits, cross-checked research, migrations,
  multi-stage implement-review-fix loops), when the user asks for
  subagents/workflows/parallel agents/pools, or whenever several pi instances
  must be orchestrated. NOT for single-step tasks or simple multi-tool calls."
metadata:
  type: procedure
---

# Contract

## Input Contract

- A task whose work decomposes into agent-sized units (files, features, topics,
  review passes) or a user request naming subagents, pools, or workflows.
- A live Jupyter-like kernel (`provision_kernel`), or the ability to provision
  one. Every kernel requires a notebook path (.ipynb); for throwaway scratch
  work pass a /tmp path — throwaway kernels work exactly like durable ones.
- A tmux environment (checked at import; the API raises plainly when absent).
   Spawned agents run under the orchestrator's own agent dir by default
   (`PI_CODING_SUBAGENT_DIR` overrides).
- Model or effort-level requests, when the user names them, resolved through
  the catalog helpers rather than guessed.

## Output Contract

- One or more `AgentPool` workflows that submit `Task`s, consume results in
  completion order, and terminate (cyclic workflows gated by a round limit).
- Aggregated findings returned to the caller; the kernel's notebook file on
  disk records every durable cell (`exec_cell` / `run_cell`) with its outputs.
  `scratch_run` exploration mutates the kernel but never lands in the notebook.
- Every spawned pi window destroyed via `pool.close()` (or `finish()`), or by
  a `with` statement exiting cleanly, before the cell ends — unless results
  are deliberately kept for follow-ups. End
  workflows with `pool.close()` as the cell's last line — its echoed
  PoolSummary is the workflow report.
- No orphaned tmux windows, no unclosed pools, no silently ignored failures
  (failed results are reported, not dropped).

# Entrypoint

1. Classify the work: one unit -> single `Task` through a one-slot pool;
   many units or stages -> pool with stages sized to the fan-out. State the
   stages and the termination condition (especially any review/fix cycle and
   its round cap) before writing code.
2. `provision_kernel(notebook=...)` once per task — a durable notebook inside
   the project, or a /tmp path for scratch.
3. In ONE `exec_cell` cell: define the tasks, build the pool, submit, and
   consume. Blocking is intended: a live subagent viewer renders under the
   code view while the cell runs. For long-running or destructive workflows
   set `confirm=true` on that cell (see Confirmation and autonomy).
4. Consume with `while (result := await pool.pop(timeout=...)) is not None:`
   and route by `result.stage`; submit follow-ups inside the loop.
5. After the loop, either keep specific settled sessions for follow-ups (submit
   with `session_handle=...`) or close: `pool.close()` kills every window,
   invalidates handles, and echoes the workflow summary (PoolSummary).
   `subagents.finish()` closes all live pools.
6. Keep workflow code in cells, not `.py` files (unless the user asks for a
   script). Use `scratch_run` to probe throwaway snippets — it runs in the
   kernel but is never appended — then make the working version durable with
   `write_cell` + `run_cell`, or with `exec_cell` when one call should both
   run and append it. The notebook on disk is the durable, re-runnable record.
7. Guard the pool-creation cell so re-running the notebook cannot spawn a
   second set of agents: load a recorded result if one exists, otherwise run
   the workflow once and write the result out, and never let the cell end with
   a pool still open. `run_all()` re-executes the cell, so an unguarded
   `AgentPool` starts the whole fan-out over.

Do not split one workflow across parallel `exec_cell` calls: a kernel runs one
cell at a time, so the calls serialize and each sees stale state. One cell per
workflow step; if a cell is interrupted, the pool survives in the namespace and
the next cell resumes with `pool.pop()`.

# Confirmation and autonomy

- The `exec_cell` confirm popup is a self-contained review surface: it shows
  only the cell body — rendered in a scrollable, syntax-highlighted viewport
  (Shiki, PgUp/PgDn to scroll) — and nothing else the model can see
  (file contents, tool output). Everything the user is meant to review must
  live inside the cell itself.
- Never confirm a wrapper call (e.g. `await main()`) whose logic lives in a
  file, and never combine `file=` with `confirm=true` — the user would be
  approving content they cannot see.
- Long-running orchestrated workflows are the canonical `confirm=true` case:
  put the entire declared workflow — all stages, prompts, pools, concurrency,
  and termination conditions — into one cell, get a single up-front approval,
  then let it run autonomously to completion. Do not split a workflow into
  multiple confirmed cells and do not prompt mid-run: the user should be able
  to walk away after the initial approval and return to finished results.
- Otherwise run cells immediately; reserve `confirm=true` for destructive
  work. If the user said "run autonomously" or "don't prompt me", never set
  it.
- This section is the customization point for orchestration approval
  behavior: edit this skill to change how workflows request approval instead
  of modifying ptc tool descriptions.

# Convenience: the `with` statement

For simple workflows (roughly ≤2 linear stages, no cyclic requeuing), a `with`
statement is the cleanest lifecycle:

```python
with subagents.AgentPool(concurrency=4, name="fanout") as pool:
    stage = pool.stage("work", slots=4)
    stage.submit_all(tasks)
    while (result := await pool.pop(timeout=600)) is not None:
        handle(result)
# clean exit here ran pool.close() for you — report available as pool.last_summary
```

Semantics:
- **Clean exit** → the pool closes automatically (windows destroyed, report in
  `pool.last_summary`).
- **Exception inside the block** → the pool is deliberately left fully alive
  (windows, queued results, scheduler intact) so you can inspect state or
  continue the run from a follow-up cell; the exception propagates normally.
  Close explicitly once you're actually done.

Prefer explicit `await`-style `pool.close()` for complex orchestration —
multi-stage fan-outs, review/fix cycles, anything where you keep settled
sessions for follow-ups — because leaving the tmux windows in place is
valuable for inspecting and auditing a run. Simple test fixtures and one-shot
fan-outs should use `with` (it is also why the pi-subagents test suite
converts to `with`: a clean block exit can never leak a window).

# Feeding results forward: never paste raw JSON into the next prompt

When a subagent returns a schema-obeying JSON object, the orchestrating code owns
the translation layer. Extract the fields you need in Python, then compose the
next agent's prompt in **common language** — complete sentences a user could read
in the subagent's tmux window and understand. Never f-string a raw JSON blob
(`result.body`), a whole schema response, or machine-formatted dumps into a
follow-up prompt.

Why:
- Subagent prompts are user-observable (live tmux windows) — raw JSON is unreadable.
- JSON braces, escaping, and keys waste tokens and confuse the next agent.
- The orchestrator is the only place with enough context to summarize, dedupe,
  and route; do that job in code, not in the next agent's head.

```python
# BAD: leaks machine output into a user-visible prompt
review.submit(subagents.Task(f"Review:\n{result.body}"), parent=result)

# GOOD: parse in Python, restate in prose
verdict = result.unwrap()                    # schema-obeying dict
problems = "\n".join(f"- {p['file']}: {p['issue']}" for p in verdict["issues"])
review.submit(subagents.Task(
    f"The build agent finished and reported these problems:\n{problems}\n"
    f"Fix each one in the working tree."), parent=result)
```

Keep the full structured object in Python (notebook variables) for routing and
aggregation; only compact, human-readable text crosses the prompt boundary.

# API

```python
import pi_subagents as subagents   # also autoimported as `subagents`

pool = subagents.AgentPool(concurrency=8, name="migration")
build = pool.stage("build", slots=4)     # slots are soft priority reservations
review = pool.stage("review", slots=4)   # stage names are unique per pool

# A Task is an immutable spec; metadata always carries an integer "rounds"
# (roots default to 0). Prompts have no size limit (delivered over pi-sock).
task = subagents.Task("Migrate module X", name="build-x",
                      model="provider/model", thinking="high",
                      schema={"type": "object", "required": ["ok"],
                              "properties": {"ok": {"type": "boolean"}}},
                      metadata={"file": "x.py", "rounds": 0})

h = build.submit(task)          # returns immediately; status queued
hs = build.submit_all(tasks)    # fan out

# Consume in completion order; None = quiescent (pool stays usable).
while (result := await pool.pop(timeout=3600)) is not None:
    if result.stage is build and result.ok:
        review.submit(subagents.Task(f"Review:\n{result.body}"),
                      parent=result)
    elif result.stage is review:
        verdict = result.unwrap()          # body, or raises the stored error
        rounds = result.task.metadata["rounds"]
        if not verdict["ok"] and rounds < 5:
            build.submit(subagents.Task("Fix it", metadata={"rounds": rounds + 1}),
                         parent=result)
    # failures arrive as results (result.ok False, result.error set);
    # only pop timeouts raise (AgentPoolTimeoutError with .pool/.snapshot).

summary = pool.close()   # the ONLY teardown: invalidates handles, kills every
                         # window, and echoes the PoolSummary report
```

Handle operations: `await h` / `h.wait(timeout)` -> `AgentResult`;
`h.cancel()` (queued or running); `h.send(text)` steers the running turn only;
`h.state()`, `h.activity()`, `h.agent_state()` for inspection. A settled
session continues via `stage.submit(new_task, session_handle=h)` - same tmux
window, new handle and result, old results untouched; omitted model/thinking/
cwd/agentDir inherit the session, conflicts raise `SessionReuseError`, and
`session_name="..."` renames the live session.

Result fields: `task`, `stage`, `handle`, `body` (str or dict response),
`error`, `status` (settled/failed/cancelled), `duration_ms`, `parent`, `ok`,
`unwrap()`, `session` (tool_calls, thinking, prose, trajectory).

# Model and effort selection

- Every `pi_subagents` object is introspectable: call `help(obj)` (e.g. `help(pool)`, `help(task)`, `help(result)`) inside a cell to see all attributes and methods when this skill is silent on a detail. `dir(obj)` lists them tersely.
- Resolve every named model: `subagents.best_model_match("flash")` returns one
  pick (exact slug > agent dir's default provider > first-party > proxied);
  `model_slugs`/`resolve_models`/`list_models` give full rows. Pass a full
  `provider/model` slug when a specific provider's variant matters.
- The catalog expires (`PI_SUBAGENTS_CATALOG_TTL`, 120 s) and re-checks live on
  a miss; `list_models(refresh=True)` forces a re-read.
- Budget per stage: cheap fast models for mechanical units, stronger models
  for review/synthesis; set `thinking` explicitly for hard work.

# Rules

- Top-level `await` is available in `exec_cell`; never `asyncio.run(...)`.
- Gate every cyclic workflow on `metadata["rounds"] >= N` unless the user
  explicitly says unbounded; `pop()` returning None means quiescent, so an
  ungated cycle never terminates.
- Pop timeouts (`AgentPoolTimeoutError`) leave the pool and work intact: inspect
  `pool.snapshot()` / `pool.handles(status={"queued","starting","running"})` and
  continue in the same or a later cell.
- Set explicit `Task.timeout` values for models that can fail at the provider;
  an errored turn may otherwise wait out the default settle timeout (30 min).
- `PI_SUBAGENTS_MAX_CONCURRENT` (unset by default — must be set to a positive number to enable subagents) caps all pools globally; stage
  slots are priorities, not hard limits - idle slots are borrowed.
- Spawned agents cannot spawn agents; keep orchestration in the parent cell.
- Each subagent is a real interactive pi in a tmux window titled
  `pi - (subagent) <name> - <cwd>`; the user can watch and steer them by hand.
- Interrupts (Esc, `/ptc interrupt`) stop the cell, not the pool or the
  kernel; `/ptc kill` drops the interpreter and orphans running windows -
  avoid it mid-workflow.
