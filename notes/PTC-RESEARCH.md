# PTC research, findings, and reliability hardening notes

This document captures what was learned while aligning `pi-ptc-next` more closely with Anthropic's Programmatic Tool Calling (PTC) model behavior, and what was ultimately implemented in this fork.

It is intentionally practical: how native PTC works, where `pi-ptc-next` differs, what reliability hardening now exists, and what still matters when authoring prompts, tools, evals, and benchmarks.

## TL;DR

`pi-ptc-next` now has the core pieces needed for production-safer local PTC behavior:

- conservative prompt-time routing toward `code_execution` for clear read-only analysis tasks
- bounded async-only auto-recovery for common first-attempt async wrapper mistakes
- ephemeral request telemetry in `toolResult.details`, not a persistent sink
- deterministic JSON eval cases under `.pi/evals/ptc`
- a local benchmark runner that emits JSON result records and compares baselines
- regression coverage for routing, recovery, mutation exclusion, and per-request state reset

It is still **not** Anthropic's native wire protocol.
It remains a provider-agnostic local implementation with deliberately narrow, user-visible recovery behavior.

## Primary sources used

Vendored in this repo:

- `docs/advanced-tool-use.md`
- `docs/programmatic-tool-calling.md`

Additional external references used during research:

- Anthropic: Code execution with MCP
  - https://www.anthropic.com/engineering/code-execution-with-mcp
- Anthropic: Writing effective tools for agents
  - https://www.anthropic.com/engineering/writing-tools-for-agents
- Anthropic Tool Choice cookbook
  - https://platform.claude.com/cookbook/tool-use-tool-choice
- Anthropic Implement Tool Use docs
  - https://platform.claude.com/docs/en/agents-and-tools/tool-use/implement-tool-use
- Anthropic Code Execution Tool docs
  - https://docs.anthropic.com/en/docs/agents-and-tools/tool-use/code-execution-tool

## What native Anthropic PTC does

At a high level, Anthropic's native PTC flow is:

1. The API exposes a `code_execution_*` tool.
2. Other tools opt into programmatic calling with `allowed_callers: ["code_execution_..."]`.
3. Claude decides whether a task should be handled through direct tool use or through code execution.
4. If Claude chooses PTC, it writes Python that calls tools as async functions.
5. Tool results go back to the running code environment, not into the model's context window.
6. Claude receives only the final code output.

This is why PTC helps on:

- 3+ dependent tool calls
- loops and batching
- filtering, grouping, aggregation, ranking
- large intermediate results
- repeated lookups across many inputs

## Important Anthropic routing findings

### 1. PTC is not just a sandbox feature

The runtime matters, but tool selection matters just as much.

Anthropic's docs and articles consistently point to three levers that influence whether the model picks the right execution path:

- detailed tool descriptions
- clear tool boundaries / namespacing
- examples and system-prompt guidance

### 2. `allowed_callers` is a major routing primitive

Anthropic explicitly recommends choosing either:

- `direct`
- `code_execution`

for a given tool rather than enabling both everywhere.

Why: if a tool is simultaneously available in both paths without clear guidance, the model has a less obvious routing decision. In practice that tends to bias models toward the simpler direct-call path.

### 3. `tool_choice` does not solve this

Anthropic's PTC docs explicitly note that you cannot force programmatic calling of a specific inner tool via `tool_choice`.

So the answer is not "force tool choice harder".
The answer is better routing, clearer boundaries, and stronger guidance.

### 4. Tool descriptions matter a lot

Anthropic's implementation docs are blunt here: very detailed descriptions are one of the biggest factors in tool performance.

For PTC specifically, that means `code_execution` needs explicit examples of when it should be preferred over `read`/`grep`/`find`, and direct tools need boundaries that do not blur heavy multi-step analysis into every prompt.

## How `pi-ptc-next` differs from native Anthropic PTC

`pi-ptc-next` is **not** Anthropic's wire protocol.

It is a provider-agnostic local implementation with similar behavior:

- the model sees a normal pi tool called `code_execution`
- the tool runs local Python
- Python calls pi tools over a local JSON-RPC bridge
- results are normalized into Python-friendly values
- only the final answer returns to the main model context

That means two things:

### What it already did well

- real local orchestration through Python
- provider-agnostic behavior across models
- token savings from hiding intermediate results
- reusable Python helpers and normalization

### What it could not inherit automatically

It did **not** get Anthropic's native routing and recovery semantics for free.
Those had to be built explicitly in the extension lifecycle.

## What is implemented now

### 1. Local `allowed_callers` equivalent

Added `ptc.callers` metadata for custom and extension tools:

```js
ptc: {
  enabled: true,
  readOnly: true,
  callers: ["code_execution"]
}
```

Supported values:

- `['direct']`
- `['code_execution']`
- `['direct', 'code_execution']`

Effect:

- code-only tools remain callable from Python
- code-only tools are no longer auto-activated as normal direct tools
- the extension now has a local routing vocabulary similar to Anthropic's `allowed_callers`

### 2. Conservative prompt-time auto-routing

A conservative router runs in `before_agent_start`.

When a prompt strongly looks like a read-only PTC task, the extension temporarily biases the active tool set toward `code_execution`.

Current positive signals include prompts about:

- repo-wide analysis
- multi-file scans
- repeated operations across many items
- counting / grouping / ranking / filtering / aggregation
- compact JSON / summary-only output
- keeping intermediate results out of chat

Current negative signals include prompts that look like mutations, e.g.:

- fix
- edit
- modify
- write
- implement
- patch
- rename

On `agent_end`, the previous active-tool state is restored.

### 3. Bounded async-only auto-recovery

A single bounded recovery layer now exists for common first-attempt async wrapper authoring mistakes inside `code_execution`.

The first implementation is intentionally narrow.

#### Eligible failure classes

- `missing-await`
- `async-wrapper-iterated`

These cover high-confidence cases such as:

- un-awaited helper calls like `content = read(path)`
- iterating, sorting, slicing, indexing, or unpacking a coroutine-returning helper result before `await`
- representative coroutine misuse errors such as `'coroutine' object is not iterable` and `'coroutine' object is not subscriptable`

#### Recovery behavior

On the first qualifying failure in a request:

1. classify the failure deterministically
2. record the failure class in request state and tool result details
3. append one targeted corrective message for the next turn
4. allow at most one automatic recovery attempt

The recovery prompt is deterministic and minimal. It only reminds the model that helpers like `read`, `glob`, `find`, `grep`, and `ls` are async wrappers that must be awaited before use.

#### Explicit non-permissions

Recovery does **not**:

- rewrite generated code out of band
- trigger more than once per request
- activate for mutation prompts
- activate for ambiguous exceptions
- broaden literal file/path semantics in the initial implementation
- auto-recover zero-match path cases

### 4. Request-scoped telemetry only

The extension now keeps additive, ephemeral request telemetry for PTC routing and recovery behavior.

Successful `code_execution` runs expose:

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

Key properties:

- request-scoped only
- additive only
- visible in `toolResult.details` for `code_execution`
- no persistent telemetry sink outside benchmark result artifacts

### 5. Deterministic JSON eval corpus

Eval cases now live under:

- `.pi/evals/ptc/cases/*.json`

Each case uses a stable JSON schema:

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

Seeded buckets currently cover:

- positive repo-wide PTC routing
- negative direct single-file routing
- mutation-prompt negative controls
- async recovery scenarios for `missing-await`
- async recovery scenarios for `async-wrapper-iterated`

Malformed cases fail validation deterministically.

### 6. Deterministic benchmark runner

The benchmark runner now consumes those JSON case files and emits JSON result records for each provider/model run.

CLI entrypoint:

```bash
npm run build
node dist/run-benchmarks.js \
  --provider local \
  --model seeded \
  --evals-path .pi/evals/ptc \
  --cases recovery-missing-await
```

Result records include at least:

- `case_id`
- `expected_first_path`
- `observed_first_path`
- `success`
- `recovery_attempted`
- `failure_class`
- `total_tokens`
- `duration_ms`

The runner can also compare a run against a baseline JSON file and report routing, recovery, and success regressions without modifying source planning docs.

### 7. Regression coverage

The test suite now covers:

- routing classification
- recovery failure classification
- deterministic recovery prompt generation
- max-attempt clamping
- one recovery attempt maximum
- mutation prompt exclusion from auto-route and auto-recovery
- per-request recovery state reset
- zero-match path failures staying ineligible for recovery
- eval schema validation and benchmark result behavior

## Historical routing benchmark notes

Before the deterministic eval corpus existed, manual prompt benchmarking still showed the core routing insight clearly: better routing and better `code_execution` guidance improved correctness more reliably than simply having the runtime available.

Prompt used:

> Analyze the first 8 `test/**/*.test.ts` files and return compact JSON only. For each file include path, line count, number of `test(` blocks, and whether it mentions `code_execution`. Do not include prose.

### `ccs-openai/gpt-5.4`

- with auto-routing **on**: correct result, `code_execution` used proactively
- with auto-routing **off**: the model still chose `code_execution`, but one run returned a wrong final result (`[]`)

Observed total tokens in that run pair:

- route on: `15751`
- route off: `14594`

Interpretation:

- routing improved reliability/correctness on that prompt
- token totals can still vary a lot by model behavior and retry shape
- correctness matters more than the raw token delta on a single run

### GLM turbo note

The user requested `glm-messages/glm-5-turbo`, but that exact provider/model name was not available in that pi installation.
The available equivalent was:

- `zai-messages/glm-5-turbo`

Observed total tokens in that run pair:

- route on: `15854`
- route off: `16785`

Interpretation:

- both runs were correct
- auto-routing reduced tool churn and token usage in that case

## Practical guidance for using `pi-ptc-next`

### For everyday usage

Use it normally.

The extension should now proactively lean toward `code_execution` when the request is a strong read-only PTC fit, while still using direct tools for simple requests.

If recovery is enabled, treat it as a narrow assist for first-attempt async-wrapper mistakes, not as a general retry engine.

### For custom tools

Prefer explicit caller modes.

#### Direct-only tool

```js
ptc: {
  enabled: true,
  readOnly: true,
  callers: ["direct"]
}
```

#### Code-only helper

```js
ptc: {
  enabled: true,
  readOnly: true,
  callers: ["code_execution"]
}
```

#### Shared tool

```js
ptc: {
  enabled: true,
  readOnly: true,
  callers: ["direct", "code_execution"]
}
```

### For benchmark and eval work

Prefer updating or adding JSON case files under `.pi/evals/ptc/cases` instead of relying only on ad-hoc prompts.

That keeps routing and recovery expectations diffable, replayable, and baseline-comparable.

## Current limitations

This fork is materially stronger now, but some limits remain:

- tool selection is still model behavior, not a guaranteed deterministic planner
- bounded recovery is async-wrapper-only in the initial implementation
- mutation-heavy prompts are intentionally excluded from auto-routing and auto-recovery
- path broadening is intentionally out of scope in the initial recovery layer
- benchmark outputs are deterministic, but real provider/model runs can still vary
- this is still not Anthropic-native protocol parity

## Likely next improvements

If future work continues beyond the current hardening pass, the most sensible next steps are:

1. expand the JSON eval corpus with more real prompts and failure shapes
2. run and store more provider/model baselines using the benchmark runner
3. refine prompt-router heuristics using measured eval regressions
4. add richer few-shot examples only if routing quality plateaus
5. evaluate whether persistent telemetry is worth a separate follow-on design

## Why this document exists

The key lesson from this work is simple:

**PTC is not only about being able to run Python. It is also about making the model choose that path at the right time, recover safely when a narrow class of mistakes happens, and measure regressions deterministically.**
