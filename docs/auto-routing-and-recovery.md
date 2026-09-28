# Auto-routing and auto-recovery

## What it does

Auto-routing watches each user prompt before the agent starts and, when the request looks like repo-wide or multi-file analysis (counting, grouping, ranking, filtering, aggregation, or "compact JSON only" style requests), temporarily swaps the active tool set toward `exec_cell`/`provision_kernel` and appends a one-line instruction to the system prompt telling the model to do the work in Python cells instead of looping with direct tools. Auto-recovery is a companion safety net: when a first `exec_cell` failure is a recognizable missing-`await` mistake on one of the known async helpers, the extension deterministically appends one corrective hint message to the model's context so the next cell attempt fixes it, without ever editing the model's code out of band. Both mechanisms are bounded, request-scoped, and observable through telemetry attached to `exec_cell` tool results.

## How it works

### Auto-routing

- Hook: `before_agent_start` (`src/index.ts`, `handleBeforeAgentStart` → `applyAutoRouting`). A fresh recovery/telemetry state is created for every request.
- The prompt is classified by `shouldAutoRoutePromptToCodeExecution` in `src/utils.ts`:
  - Explicit tool requests ("use exec_cell", "run provision_kernel", …) route immediately — this check runs **before** the mutation filter.
  - Otherwise, mutation-looking prompts (words like `edit`, `write`, `fix`, `create`, `delete`, `rename`, `refactor`, `patch`, `implement`, `add`, `remove`, `update`, `change`) never route.
  - Remaining prompts route when at least two of these signal groups match, or fan-out + one of the others: **fan-out** (`**/*.ext`, `glob`, `repo`, `codebase`, `all/every/many/multiple files`, `for each`, `for every`, `each file`, `first N files`), **processing** (`count`, `group`, `aggregate`, `rank`, `sort`, `top N`, `summarize`, `compare`, `statistics`, `histogram`, `filter`, `dedup`, `tabulate`, …), **context pressure** (`compact json`, `json only`, `summary only`, `keep intermediates`, `out of chat`, `without flooding`).
- If routing fires (and the `exec_cell` tool is registered), the active tool set is filtered to remove the direct host tools that are callable from Python (per `ToolRegistry.getAutoRoutableToolNames`), then `exec_cell`, `provision_kernel`, and `read_cell_output` are ensured present. The previous active-tool list is remembered and restored on `agent_end`.
- The returned system prompt gets one appended paragraph: "This request is a strong fit for exec_cell…". Nothing in pi forces the model to use `exec_cell` — the steering is the narrowed tool set plus this prompt and the tool descriptions.
- Routing is on by default (`PTC_AUTO_ROUTE=true`).

### Auto-recovery

- Off by default (`PTC_AUTO_RECOVER=false`).
- Only `exec_cell` failures that surface as `PtcPythonError` are examined. `classifyCodeExecutionFailure` (`src/recovery-classifier.ts`) matches the exception text against two deterministic failure classes, cross-checked against the traceback/code evidence:
  - `missing-await` — diagnostics mention "coroutine" or "was never awaited", and a code/traceback line contains an un-awaited call to a known async helper (`read`, `glob`, `find`, `grep`, `ls`, `ptc.read_many`, `ptc.read_tree`, `ptc.find_files`, `ptc.find_files_abs`, `ptc.read_text`). Attribute access (`f.find(x)`) and bare `await` mentions are excluded.
  - `async-wrapper-iterated` — diagnostics like `'coroutine' object is not iterable/subscriptable` or `cannot unpack non-iterable coroutine object`, with the helper result used inside `sorted(...)`/`list(...)`/`for ... in ...`, subscripted, unpacked, or wrapped in `sum`/`min`/`max`/`len`/`join`/etc.
- Recovery is only armed when: the request was not a mutation prompt (`recoveryAllowed`), a failure class matched, and `recoveryAttemptCount < maxAttempts` (default 1, so at most one automatic attempt per request). Arming sets a pending recovery prompt; the next `context` event appends it as one visible `ptc-recovery` message ("PTC recovery: You called an async helper without await…"). The pending prompt is consumed once — a second qualifying failure in the same request gets no second message (with default settings).
- The recovery message never rewrites generated code, never fires twice per request under defaults, skips mutation prompts, does not broaden literal-path semantics (zero-match path failures are not auto-recovered), and aborts (Ctrl-C) and host timeouts are never stamped as terminal failures.
- Telemetry is attached to every `exec_cell` tool result, successful or failed, under `details.telemetry` (`autoRouted`, `firstToolPath`, `routedToCodeExecution`, `codeExecutionAttempts`, `recoveryAttemptCount`, `terminalState`) and `details.recovery` (`eligible`, `attempted`, `failureClass`). It is ephemeral — there is no persistent sink beyond whatever benchmark/result files you save yourself.

## Usage

Ask a PTC-shaped question normally:

```text
> Count the TODO comments in every *.ts file under src/ and give me the top 5 files as compact JSON only.
```

Because the prompt matches fan-out (`every *.ts`) + processing (`count`, `top 5`) + context pressure (`compact json only`), the extension narrows the tool set and appends the routing note. The model then works in a kernel:

```json
[
  {"name": "provision_kernel", "arguments": {"notebook": "/tmp/todo-scan.ipynb"}}
]
```

```json
[
  {
    "name": "exec_cell",
    "arguments": {
      "session_id": "k1",
      "code": "files = await glob('src/**/*.ts')\ncounts = {}\nfor f in files:\n    text = await read(f)\n    counts[f] = text.count('TODO')\ntop = sorted(counts.items(), key=lambda kv: -kv[1])[:5]\ntop"
    }
  }
]
```

If the model forgets an `await` (`files = glob('src/**/*.ts')` then `sorted(files)`), the cell fails with `'coroutine' object is not iterable`, and — with `PTC_AUTO_RECOVER=true` — the model's next context contains exactly one injected message:

```text
PTC recovery: You used an async helper result before awaiting it. Helpers like read,
glob, find, grep, and ls are async wrappers. Await the helper call before iterating,
sorting, slicing, indexing, or unpacking the result.
```

The failed call's tool result also carries `details.recovery: {eligible: true, attempted: true, failureClass: "async-wrapper-iterated"}` and `details.telemetry` with `recoveryAttemptCount: 1`.

Simple requests ("what does exec_cell's confirm flag do?") match none of the signal groups and route nothing — the agent keeps using direct tools.

## Options / Configuration

All configuration is via environment variables; there is no settings file for this feature.

| Variable | Default | Effect |
|---|---|---|
| `PTC_AUTO_ROUTE` | `true` | Enable prompt-based routing toward `exec_cell`. `false`/`0`/`no`/`off` disables it. |
| `PTC_AUTO_RECOVER` | `false` | Enable the bounded async-failure recovery hint. |
| `PTC_AUTO_RECOVER_MAX_ATTEMPTS` | `1` | Recovery cap per request; parsed as an integer clamped to the 0–4 range (`src/utils.ts`). `0` is a kill switch even when `PTC_AUTO_RECOVER=true`. Note: the README claims values above 1 are clamped back to 1, but the source clamps to 4 — treat values >1 as supported-but-undocumented. |
| `PTC_DEBUG` | `false` | Prints `[PTC]` debug lines including "Auto-routed prompt to exec_cell" (with the prompt and before/after tool lists) and the restore event. |
| `PTC_CALLABLE_TOOLS` | — | Explicit allowlist of host tools callable from Python; affects which direct tools routing removes and which helpers exist in the kernel. |
| `PTC_BLOCKED_TOOLS` | — | Denylist override; blocked tools are neither callable nor routing-removable. |

## Standalone setup notes

Things that are hardcoded or tuned to the author's machine, and what to do about them:

- **English-only regex heuristics.** Routing signals and the mutation-word list (`src/utils.ts`) are hardcoded English patterns. Prompts in other languages, or unusual phrasings, simply don't route — nothing breaks. Workaround: name the tools explicitly ("use exec_cell to …"), which routes unconditionally (the explicit-verb check runs before the mutation filter).
- **Hardcoded async-helper list in the classifier.** `KNOWN_ASYNC_HELPERS` in `src/recovery-classifier.ts` covers only `read`, `glob`, `find`, `grep`, `ls` and the `ptc.*` helpers. Custom tools registered via `tools/` are not known to the classifier, so missing-`await` failures on them are never auto-recovered. Workaround: await custom-tool helpers explicitly, or rely on the cell error output alone.
- **Env-only configuration.** `loadSettingsFromEnv` reads `process.env` at extension load time; there is no per-project settings file and no reload on change. Set the variables in your shell, your pi profile/env config, or per-invocation.
- **No recovery/routing state persists.** Nothing about routing or recovery is written to disk; telemetry lives only in the tool-result `details` of your transcript/benchmark captures. Don't expect a metrics endpoint.
- **Author-specific paths outside this feature (but adjacent, since routed workflows often fan out subagents from cells):** the pi_subagents provisioner defaults to a public GitHub mirror (`PTC_SUBAGENTS_REPO_URL=https://github.com/Quinntyx/pi-subagents`), a dev-checkout path (`PTC_SUBAGENTS_SOURCE=~/docs/src/pi-subagents` when present), an agent-dir override (`PI_CODING_SUBAGENT_DIR`, default: the orchestrator's own agent dir), and creates a venv at `~/.cache/pi-pycells/python-env` (via `uv` if available, else `python3 -m venv`). On a machine without access to that private forge, provisioning fails with a logged warning and `import pi_subagents` is unavailable — set `PTC_SUBAGENTS_REPO_URL` to a clone you can reach, or point `PTC_SUBAGENTS_SOURCE` at your own checkout. Core routing/recovery does not depend on any of this.
- **Routing requires `exec_cell` to be registered.** `applyAutoRouting` no-ops if no `exec_cell` tool exists (e.g. `session_start` never ran or the extension failed to load), so a silent routing failure usually means the extension itself didn't finish initializing — check `PTC_DEBUG` output first.
