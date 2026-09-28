# Benchmarks and evals

## What it does

`pi-ptc` ships a self-contained, deterministic benchmark harness for the extension's auto-routing and auto-recovery behavior. A set of seeded eval cases lives as JSON files under `.pi/evals/ptc/cases/`, each describing a prompt, the first execution path you expect the model to take (`code_execution` or `direct`), and a list of acceptance rules. The benchmark CLI (`src/run-benchmarks.ts` → `dist/run-benchmarks.js`) loads the cases, runs them through a case executor, evaluates every acceptance rule, writes a JSON run file, and — if you point it at a previously saved baseline — reports routing/recovery/success regressions and exits non-zero when any are found. By default it uses a built-in deterministic executor, so runs are reproducible and need no model API access.

## How it works

- **Case loading** (`loadEvalCasesFromDisk` in `src/benchmark-runner.ts`): reads every `*.json` file in `<evals-path>/cases/` in sorted filename order and validates each one with `parseEvalCase` (`src/eval-cases.ts`). Invalid files (bad shape, unknown acceptance rule keys, unknown `expected_first_path` or acceptance `type`) fail the run at load time. If you pass `--cases`, only matching case ids run, and unknown ids are an error listing the available ids.
- **Default executor** (`createDeterministicBenchmarkExecutor`): no LLM is called. Classification is done by replaying the extension's real routing heuristic, `shouldAutoRoutePromptToCodeExecution(prompt)` (`src/utils.ts`), over the case prompt:
  - If the heuristic routes the prompt, `observed_first_path` is `"code_execution"`; otherwise `"direct"`.
  - `recovery_attempted` is true only when the case was routed to code execution *and* the case's rules expect `recovery_attempted=true`.
  - `failure_class` is copied from the case's `failure_class=` rule when recovery fired, else `null`.
  - If the rules include `output_json=true`, the synthetic output is `JSON.stringify({case_id, provider, model})` (valid JSON, so the rule passes); otherwise it is `completed:<case_id>`.
  - `total_tokens` is estimated as `ceil(chars / 4)` over prompt + output + provider + model; `duration_ms` is derived from the prompt and case id lengths. These are synthetic stand-ins, not real measurements.
  - A custom executor can be injected programmatically via the `executor` option of `runBenchmarkSuite` (e.g. to drive a real model); the CLI always uses the deterministic one.
- **Rule evaluation** (`evaluateRule`): each rule must be `key=value`. Supported keys: `observed_first_path`, `success`, `recovery_attempted`, `failure_class`, and `output_json`. A case's `success` field defaults to "all non-`success=` rules passed" unless the executor reports `success` explicitly; the per-rule outcomes are recorded in the result file either way.
- **Result file**: the run is written as JSON containing `provider`, `model`, `generated_at`, per-case records (`case_id`, `expected_first_path`, `observed_first_path`, `success`, `recovery_attempted`, `failure_class`, `total_tokens`, `duration_ms`, plus `rule_outcomes`), and a `summary` (`total_cases`, `successful_cases`, `routed_cases`, `recovery_attempts`).
- **Baseline comparison** (`compareBenchmarkRuns`): with `--baseline`, the current run is diffed against the saved run file. Regressions are reported for: a case whose routing matched its expectation in the baseline but not now (`routing`), a case that previously recovered but no longer does or whose failure class changed (`recovery`), and a case that previously satisfied its rules but no longer does (`success`). Added and removed case ids are listed separately. The CLI sets exit code 1 when any regression exists, so it can gate CI.
- **Result placement**: by default the run file is written to `<evals-path>/results/<provider>__<model>/<sanitized-timestamp>.json`. The conventional baseline location is `<evals-path>/baselines/<provider>__<model>.json` (that's what `getDefaultBenchmarkBaselinePath` builds; nothing writes it for you — promote a result file there yourself).

## Usage

Build first (the CLI runs from `dist`), then run the whole seeded suite:

```bash
npm run build
node dist/run-benchmarks.js \
  --provider local \
  --model seeded \
  --evals-path .pi/evals/ptc
```

The CLI prints one JSON line to stdout:

```json
{
  "results_path": "/path/to/repo/.pi/evals/ptc/results/local__seeded/2026-03-16T00-00-00.000Z.json",
  "summary": { "total_cases": 6, "successful_cases": 6, "routed_cases": 4, "recovery_attempts": 2 },
  "comparison": null
}
```

Run a single case and compare against a saved baseline:

```bash
node dist/run-benchmarks.js \
  --provider local \
  --model seeded \
  --evals-path .pi/evals/ptc \
  --cases recovery-missing-await \
  --baseline .pi/evals/ptc/baselines/local__seeded.json \
  --timestamp 2026-03-16T00:00:00.000Z
```

Exit code is 0 on a clean run and 1 on regressions (or any load/usage error, with the message on stderr).

## Eval case format

Each case is one JSON file in `<evals-path>/cases/`, e.g. the seeded `recovery-missing-await.json`:

```json
{
  "id": "recovery-missing-await",
  "prompt": "Use Python to read package.json, count the top-level keys, and return compact JSON only.",
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

Fields:

- `id` — non-empty string; must be unique in practice (it selects cases and keys baseline comparison).
- `prompt` — the prompt text. With the default executor this is the only thing classified, so it must trigger (or not trigger) the routing heuristic in `src/utils.ts` the same way a live prompt would.
- `expected_first_path` — `"code_execution"` or `"direct"`.
- `acceptance.type` — `"exact"`, `"structural"`, or `"behavioral"` (a label; the runner treats all types the same and evaluates only `rules`).
- `acceptance.rules` — non-empty array of `key=value` strings. Keys: `observed_first_path` (`code_execution` | `direct` | `none`), `success` (`true`/`false`), `recovery_attempted` (`true`/`false`), `failure_class` (`missing-await`, `async-wrapper-iterated`, or `null`), `output_json` (`true` means the executor's output must parse as JSON). Unknown keys are rejected at load time.

The six seeded cases cover: two positive repo-wide-routing cases (`ptc-positive-*`), two direct-path negatives including a mutation-prompt control (`direct-negative-*`), and two recovery cases for the `missing-await` and `async-wrapper-iterated` failure classes.

## Options

CLI flags (all parsed by `parseCliArgs`; unknown flags are an error):

| Flag | Meaning | Default |
| --- | --- | --- |
| `--provider <name>` | Provider label stored in the run and result path | `local` |
| `--model <name>` | Model label stored in the run and result path | `deterministic` |
| `--evals-path <dir>` | Eval root containing `cases/` | `PTC_EVALS_PATH` or `.pi/evals/ptc` |
| `--cases <id,id,...>` | Comma-separated case ids to run (subset) | all cases |
| `--baseline <file>` | Benchmark run JSON to diff against | none |
| `--results-path <file>` | Explicit output file | `<evals>/results/<provider>__<model>/<timestamp>.json` |
| `--timestamp <iso>` | Override `generated_at` (must be an ISO-like timestamp, e.g. `2026-03-16T00:00:00.000Z`); also used for the default result filename, sanitized | current UTC time |

## Configuration

- `PTC_EVALS_PATH` — overrides the default eval root (`.pi/evals/ptc`). Relative paths are resolved against the current working directory.
- Routing behavior that the deterministic executor replays depends on the same heuristic as the live extension (`shouldAutoRoutePromptToCodeExecution`); the extension's own routing toggle (`PTC_AUTO_ROUTE`, default `true`) governs live sessions but the benchmark executor always applies the heuristic for classification.

## Standalone setup notes

- **Eval cases are not published to npm.** The package's `files` allowlist ships only `dist`, `src/python-runtime`, `tools`, and `skills` — `.pi/evals/ptc/` exists only in the git repository. If you installed `@quinntyx/pi-ptc-next` from a registry, clone or copy the `.pi/evals/ptc` directory from the repo, or write your own cases in the format above under any directory and point `--evals-path` (or `PTC_EVALS_PATH`) at it.
- **No npm script wraps the benchmark.** There is no `benchmark` entry in `package.json`; you must run `npm run build && node dist/run-benchmarks.js ...` yourself. The import path in `src/run-benchmarks.ts` is relative, so any checkout of the repo works as-is.
- **No author-specific paths or private URLs are hardcoded in the benchmark code.** All locations derive from `process.cwd()`, `--evals-path`, or `PTC_EVALS_PATH`. (Unlike the subagent provisioner, this feature has no dependency on `~/docs/src/...`, `~/.config/pi` profiles, or tmux sessions.) If you set `PTC_EVALS_PATH` in your shell for other pi-ptc features, remember it also changes the benchmark's default eval root.
- **Baselines are yours to manage.** Nothing seeds `<evals>/baselines/`; save a run's result file there (e.g. `cp .pi/evals/ptc/results/local__seeded/<ts>.json .pi/evals/ptc/baselines/local__seeded.json`) once you trust it. The runner validates baseline shape and fails clearly on a malformed file.
- **The default executor is synthetic.** `total_tokens` and `duration_ms` are derived deterministically from string lengths (chars/4 and prompt-length heuristics), not measured. Use the seeded suite for routing/recovery regression gating; for real token/cost measurement, drive live `exec_cell` sessions and read the `details.telemetry` / `details.metrics` fields on tool results instead, or supply a custom executor through the `runBenchmarkSuite` API.
- **Timestamps in filenames.** Default result filenames sanitize the ISO timestamp (colons become dashes) so they are filesystem-safe on all platforms; `--timestamp` must still parse as ISO-like or the CLI rejects it.
