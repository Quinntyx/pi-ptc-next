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

## Input contract

- Work that decomposes into agent-sized units or stages, or a request naming
  subagents, pools, or workflows.
- A live notebook-backed kernel, or permission to provision one. Keep reusable
  workflow notebooks in the project's `.pi/workflows/` directory.
- A tmux environment; the library checks it at import.
- Named model or effort requests, resolved through the catalog helpers.

## Output contract

- Tasks dispatched through pools and stages, consumed in completion order.
- A stated termination condition; cycles have an explicit round cap.
- Findings and workflow results recorded in durable notebook cells.
- A dedicated teardown cell after inspection. `pool.close()` returns the
  `PoolSummary`; `subagents.finish()` closes all live pools and returns a count.
- No orphaned windows, silently dropped failures, or unfinished work described
  as success.

# Entrypoint

1. Classify the work: one unit uses a one-slot pool; many units use stages
   sized to the fan-out. State the stages and termination condition before
   writing code, including the round cap for review/fix cycles.
2. Provision one durable notebook-backed kernel for the task. Use a notebook
   in `.pi/workflows/`, not a throwaway notebook, for reusable workflows.
3. **Use three or more recorded cells, never scratch execution:**

   - **Cell 1 — constants:** imports, prompts, input lists, paths, model
     requests, schemas, and limits. No `Task` objects or orchestration here.
   - **Cell 2+ — workflow:** construct tasks from those constants, create pools
     and stages, submit work, consume results, and route continuations. Task
     construction belongs here: prompt composition, item iteration, `cwd`,
     schemas, and task parameters must be visible in the reviewable logic.
     The opening workflow cell declares the complete agent workflow. Later
     recorded cells may process results or send follow-ups and steering.
     Leave the pool open; do not call `pool.close()` here.
   - **Final cell — teardown:** call **`pool.close()` without `await`**, after
     inspecting the results. This is a synchronous method that returns the
     summary. Until teardown, windows remain available for inspection and
     steering. `subagents.finish()` also belongs in a dedicated cleanup cell.

   Create the opening workflow cell with `write_cell`. Submit that saved cell
   with `request_cell_review(session_id=..., n=...)`, then execute it using
   `run_cell` after approval. Do not use `exec_cell` or `scratch_run` to start
   an unreviewed workflow. Constants remain visible in the preceding cell;
   review must not hide the implementation in a wrapper such as `await main()`.
   See review/autonomy below for explicit no-prompt requests.
4. Consume with `while (result := await pool.pop(timeout=...)) is not None:`.
   Route by `result.stage` and submit follow-ups inside the loop.
5. When the loop ends, inspect results before executing teardown. If a cell
   raises, leave pools and windows alive; diagnose or continue in another cell.
6. Scratch probes are allowed, but a saved workflow must not depend on variables
   or functions created only in scratch execution or deleted cells.
7. Guard effects when rerunning: reuse a live pool rather than creating another
   one, and replay a recorded complete result when appropriate. Cache identity
   must match the workflow inputs. Do not cache partial or failed work as done.
   `run_all` reruns every code cell; never invoke it blindly on a live workflow.
   Separate teardown still applies: the workflow cell leaves its pool open.

Do not split a workflow across concurrent cell-execution calls. One kernel
runs one cell at a time; keep orchestration together, then inspect, continue,
and tear down in ordered cells.

# Review and autonomy

- `request_cell_review` is a separate tool. It previews inline code, a file's
  complete contents, or a saved notebook code cell. It never executes code.
- Review the saved opening workflow cell before a substantial workflow and
  review destructive operations before running them. Use `n` and `session_id`
  to show exactly the cell that will be run; keep prompts and constants in
  the preceding recorded cell and actual task construction in the workflow.
- Approval covers the intended operation, not an exact code hash. After
  approval, execute separately and repair ordinary bugs within that scope
  without prompting again. New targets, destructive effects, permissions, or
  materially greater cost require a new review.
- Rejection means do not execute. Apply any returned feedback and resubmit.
  A missing UI or broken review dialog is a rejection, not silent approval.
- Do not prompt mid-workflow for unchanged scope: one up-front review should
  let the user walk away while the approved workflow runs.
- If the user explicitly says "run autonomously" or "don't prompt me", do not
  request a review. Still write the workflow cell before running it.
- Review requirements are model policy, not a sandbox or a mandatory execution
  guard. Execution tools have no review/confirmation flag.

# Context managers: trivial fixtures only

`with AgentPool(...)` closes on clean exit inside the same cell. Reserve it
for genuinely trivial one-shot agents or test fixtures with no retained
sessions, steering, or meaningful workflow logic. Real workflows use the
constants → workflow → teardown structure.

An exception inside a pool context leaves its work alive and propagates
normally. Do not use the context manager to conceal workflow lifecycle or
combine substantial orchestration and cleanup in one cell.

# Failure semantics

Failures raise; there is no `fail_fast` argument and no `result.ok` check.

- `await handle` / `handle.wait()` raises the underlying task exception.
- `await pool.pop()` raises `AgentPoolFailureError` for a failed completion.
  Its `.result` identifies the failed task and handle; `__cause__` preserves
  the underlying exception. This is diagnostic information, not a success
  value that the workflow must remember to check.
- Process death raises `PiSockSessionEnded`. Aborted or provider-error turns
  fail instead of being treated as successful empty replies. Choose explicit
  `Task.timeout` values: unavailable providers can otherwise wait out the
  default settle timeout.
- `AgentPoolTimeoutError` stops the waiting cell, not the pool. Inspect its
  snapshot and handles, then continue from a later cell.
- For a schema task, the library parses and validates the reply automatically.
  Successful `result.body` values are Python dictionaries, not JSON strings;
  indexing them requires no `.unwrap()` or manual JSON parsing.
- An invalid JSON reply or schema mismatch triggers a follow-up containing the
  actual validation error. The library allows up to **three repair follow-ups**
  after the initial response. Exhaustion raises `SchemaValidationError`;
  repair timeout raises `PiSubagentsTimeoutError`. Invalid/raw JSON is never
  returned as a successful schema-task body. Through `pool.pop`, these errors
  are the cause of `AgentPoolFailureError`.
- Explicitly cancelled tasks have `status="cancelled"` and no successful body;
  report cancellation separately rather than processing it as a dictionary.

**Do not put a blanket `try/except` around an entire pool workflow.** An
exception should stop the cell where it occurred; notebook state and other
agents survive for inspection and continuation. Catch specific expected
exceptions only around the relevant individual agent or completion, such as
an intentional probe. Unexpected errors must propagate. Never turn a caught
exception into a fabricated successful report, and never close the pool from
an error handler or a workflow-wide `finally` block.

# Feeding results forward

Schema-task bodies are already validated dictionaries. Read their fields and
turn findings into human instructions before submitting the next task.

Do not stringify the complete response or attach it as a machine-output blob:

```python
# BAD: makes the next agent interpret a dictionary dump.
next_prompt = FOLLOWUP_PROMPT + str(result.body)
```

Instead, restate what happened and what the next agent should do. The exact
fields depend on the schema you declared in the constants cell:

```python
# GOOD: validated fields become readable instructions.
report = result.body
next_prompt = FOLLOWUP_PROMPT + "\nFindings from the previous stage:\n" + report["summary"]
next_task = subagents.Task(
    prompt=next_prompt, cwd=str(WORK_DIR), schema=REPORT_SCHEMA,
    metadata={"rounds": result.task.metadata["rounds"] + 1},
    resume_from=result,
)
```

Keep identifiers and measurements when needed, but send prose, bullet points,
and concrete next actions rather than raw JSON, records, or tool payloads.

# API

The following three fenced blocks represent **three separate notebook cells**.
Use `write_cell` to author them. Imports, prompts, and input data belong in the
first cell; task construction remains visible in the second.

```python
# Block 1 — constants, prompts, and input data
import hashlib
import json
from pathlib import Path
import pi_subagents as subagents

WORK_DIR = Path.cwd().resolve()
RESULTS_DIR = WORK_DIR / ".pi/workflows/results"
INPUTS = []  # Populate before reviewing the workflow.
PROMPT = "Perform the requested work for this input: "
REPORT_SCHEMA = {
    "type": "object",
    "required": ["summary"],
    "properties": {"summary": {"type": "string"}},
    "additionalProperties": False,
}
CONCURRENCY = 2
TASK_TIMEOUT = 1800
POP_TIMEOUT = TASK_TIMEOUT + 120
```

The second cell contains the reviewable orchestration, including **construction
of every task**, its working directory, and result routing. Submit this saved
cell to `request_cell_review` before `run_cell`. No execution flag is needed.
The cache prevents replaying completed work; the live-pool guard prevents
starting duplicate agents when continuing an interrupted cell.

```python
# Block 2 — task construction, dispatch, and data flow
workflow_key = hashlib.sha256(json.dumps({
    "inputs": INPUTS, "prompt": PROMPT, "schema": REPORT_SCHEMA,
    "cwd": str(WORK_DIR), "timeout": TASK_TIMEOUT,
}, sort_keys=True).encode()).hexdigest()
result_path = RESULTS_DIR / f"{workflow_key}.json"

if result_path.exists():
    reports = json.loads(result_path.read_text())
else:
    if globals().get("pool") is None or pool.closed:
        tasks = [
            subagents.Task(
                prompt=PROMPT + str(item), cwd=str(WORK_DIR),
                name=f"unit-{index}", schema=REPORT_SCHEMA,
                timeout=TASK_TIMEOUT, metadata={"rounds": 0},
            )
            for index, item in enumerate(INPUTS)
        ]
        reports = []
        active_workflow_key = workflow_key
        pool = subagents.AgentPool(concurrency=CONCURRENCY)
        work = pool.stage("work", slots=CONCURRENCY)
        handles = work.submit_all(tasks)
    elif active_workflow_key != workflow_key:
        raise RuntimeError("Inputs changed; inspect the existing pool first")

    while (result := await pool.pop(timeout=POP_TIMEOUT)) is not None:
        if result.status == "cancelled":
            raise RuntimeError("Work was cancelled; inspect before continuing")
        reports.append(result.body)  # Already a validated Python dict.
    if len(reports) != len(INPUTS):
        raise RuntimeError("Incomplete work; inspect before caching a result")
    RESULTS_DIR.mkdir(parents=True, exist_ok=True)
    temporary = result_path.with_suffix(".tmp")
    temporary.write_text(json.dumps(reports, indent=2) + "\n")
    temporary.replace(result_path)
reports
```

After inspecting the reports, execute the third cell. Keep it separate so an
exception in the workflow cannot fall through into killing active agents.
Both methods below are synchronous; do not await them.

```python
# Block 3 — teardown after inspection
summary = pool.close() if globals().get("pool") is not None else None
pool = None
summary  # PoolSummary, or None when replaying cached work in a fresh kernel.
```

`Task` is an immutable specification; its metadata contains integer `rounds`
(root tasks default to zero). A stage can submit an existing handle or result
through `resume_from` to retain that agent's session. Use `result.handle` for
inspection, steering, or targeted continuation. `pool.pop()` returning `None`
means quiescent, not closed; `pool.snapshot()` and `pool.handles(...)` show
retained state. Activity snapshots come from `handle.activity`; live reads use
`handle.get_activity()` / `await handle.get_activity_async()`. These expose the
stable pi-activity API; do not assume a particular label-assignment policy.

# Model and effort selection

- Unless the user names a model, agents inherit the subagents profile's default
  from `settings.json`. Let the library resolve it; do not pick one manually.
- Inspect unknown details with `help(obj)` or `dir(obj)`, for example on a pool,
  task, handle, or result. Do not invent arguments from older examples.
- Resolve named models through `subagents.best_model_match(...)`,
  `model_slugs`, `resolve_models`, or `list_models`. Use a full `provider/model`
  slug when the provider variant matters.
- Catalog entries expire after `PI_SUBAGENTS_CATALOG_TTL` (default 120 seconds).
  A miss rechecks the catalog; `list_models(refresh=True)` forces a refresh.
- Control stage cost through concurrency and effort. Specify `thinking` when
  appropriate; override model choice only when the user requests it.

# Rules

## Task construction and working directories

- Keep prompts and constants in their own recorded cell. Build `Task` objects,
  compose prompts, and route results in the reviewable workflow cell.
- Set `Task.cwd` explicitly. Telling an agent to change directories in its
  prompt is not a substitute for launching it in the correct working directory.
- Declare schemas for structured outputs; use dictionary fields directly.
- Set meaningful task and pop timeouts rather than relying on an unavailable
  provider eventually settling.

## Cycles and continuations

- Gate every cycle on `metadata["rounds"] >= LIMIT`, unless the user explicitly
  requests an unbounded workflow. Carry rounds forward in continuation tasks.
- Translate preceding results into readable follow-up instructions.
- Subagents cannot spawn more agents; orchestration stays in the parent.

## Recovery and cleanup

- An exception stops a cell, not its pool. Inspect and continue from a later
  cell instead of catching every error or resetting the kernel.
- Run `pool.close()` or `subagents.finish()` in a dedicated teardown cell only
  after inspection. Do not use workflow-wide `finally` cleanup.
- Reuse live pools on reruns, and only cache complete results for matching
  inputs. Do not blindly `run_all` or restart an active workflow.
- Cell interrupts leave agents alive. Killing/resetting the interpreter loses
  its pool handles and can orphan windows; avoid it while work is active.

## Concurrency and environment

- Set `PI_SUBAGENTS_MAX_CONCURRENT` to a positive number to enable subagents;
  it caps all pools globally. Stage slots are priorities; idle capacity can
  be borrowed rather than acting as hard per-stage limits.
- Each agent runs in an interactive tmux window that the user can inspect
  and steer. Preserve that access until deliberate teardown.
- The agent profile must load pi-sock and pi-activity for transport and
  activities. A standalone profile needs its own installations; it does not
  inherit the orchestrator's extension configuration.

## Notebook and API discipline

- Use recorded cells for workflows; `scratch_run` is only for probes.
- Top-level `await` is available. Never use `asyncio.run(...)` in the kernel.
- Review is a separate tool, not an argument to an execution tool.
- Activity access is stable; label naming and assignment policies may evolve.
- Use the public Python library directly, not internal RPC or socket plumbing.
