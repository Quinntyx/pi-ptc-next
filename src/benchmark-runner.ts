import fs from "node:fs";
import path from "node:path";
import { parseEvalCase, type EvalCase } from "./eval-cases";
import type { RecoveryFailureClass } from "./recovery-state";
import { estimateTokensFromChars, shouldAutoRoutePromptToCodeExecution } from "./utils";

/**
 * Exhaustive map over the RecoveryFailureClass union: adding a member to the
 * union without listing it here is a compile error, so parseFailureClass stays
 * derived from the union instead of drifting away from it.
 */
const RECOVERY_FAILURE_CLASS_MEMBERS: Record<RecoveryFailureClass, true> = {
  "missing-await": true,
  "async-wrapper-iterated": true,
};

const ISO_TIMESTAMP_PATTERN =
  /^\d{4}-\d{2}-\d{2}(?:[Tt ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:[Zz]|[+-]\d{2}:?\d{2})?)?$/;

export const BENCHMARK_OBSERVED_FIRST_PATHS = ["code_execution", "direct", "none"] as const;

export type BenchmarkObservedFirstPath = (typeof BENCHMARK_OBSERVED_FIRST_PATHS)[number];

/** One case's measured outcome (mirrors EvalCase's snake_case JSON style). */
export interface BenchmarkResult {
  case_id: string;
  provider: string;
  model: string;
  expected_first_path: EvalCase["expected_first_path"];
  observed_first_path: BenchmarkObservedFirstPath;
  success: boolean;
  recovery_attempted: boolean;
  failure_class: RecoveryFailureClass | null;
  total_tokens: number;
  duration_ms: number;
}

export interface BenchmarkRuleOutcome {
  rule: string;
  passed: boolean;
}

export interface BenchmarkResultRecord {
  result: BenchmarkResult;
  rule_outcomes: BenchmarkRuleOutcome[];
}

export interface BenchmarkRunSummary {
  total_cases: number;
  /** Cases whose acceptance rules all passed (result.success). */
  successful_cases: number;
  /** Cases whose observed_first_path is "code_execution". */
  routed_cases: number;
  recovery_attempts: number;
}

export interface BenchmarkRegression {
  case_id: string;
  kind: "routing" | "recovery" | "success";
  message: string;
}

export interface BenchmarkComparison {
  baseline_path: string;
  /** Routing/recovery/success regressions vs the baseline (see BenchmarkRegression.kind). */
  regressions: BenchmarkRegression[];
  added_case_ids: string[];
  removed_case_ids: string[];
}

export interface BenchmarkRun {
  provider: string;
  model: string;
  generated_at: string;
  results: BenchmarkResultRecord[];
  summary: BenchmarkRunSummary;
  comparison?: BenchmarkComparison;
}

export interface BenchmarkObservation {
  observed_first_path?: BenchmarkObservedFirstPath;
  success?: boolean;
  recovery_attempted?: boolean;
  failure_class?: RecoveryFailureClass | null;
  total_tokens?: number;
  duration_ms?: number;
  output?: string;
}

export interface BenchmarkExecutionContext {
  provider: string;
  model: string;
}

export type BenchmarkCaseExecutor = (
  evalCase: EvalCase,
  context: BenchmarkExecutionContext
) => Promise<BenchmarkObservation> | BenchmarkObservation;

export interface BenchmarkRunOptions {
  provider: string;
  model: string;
  evalsPath?: string;
  /** Subset of case ids to run; unknown ids throw. */
  caseIds?: string[];
  baselinePath?: string;
  /** Overrides generated_at; must be a valid ISO-like timestamp. */
  timestamp?: string;
  /**
   * Per-case observation source. Defaults to the deterministic offline executor,
   * so the suite runs without a model.
   */
  executor?: BenchmarkCaseExecutor;
}

interface RuleExpectation {
  key: string;
  value: string;
}

/** Acceptance-rule string of the form `key=value`; malformed rules never match. */
function parseRuleExpectation(rule: string): RuleExpectation | null {
  const equalsIndex = rule.indexOf("=");
  if (equalsIndex === -1) {
    return null;
  }

  const key = rule.slice(0, equalsIndex).trim();
  const value = rule.slice(equalsIndex + 1).trim();

  if (!key || !value) {
    return null;
  }

  return { key, value };
}

function getRuleExpectation(rules: string[], key: string): string | undefined {
  for (const rule of rules) {
    const parsed = parseRuleExpectation(rule);
    if (parsed?.key === key) {
      return parsed.value;
    }
  }

  return undefined;
}

function parseBoolean(value: string | undefined): boolean | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (value === "true") {
    return true;
  }

  if (value === "false") {
    return false;
  }

  return undefined;
}

function parseFailureClass(value: string | undefined): RecoveryFailureClass | null {
  if (value !== undefined && value in RECOVERY_FAILURE_CLASS_MEMBERS) {
    return value as RecoveryFailureClass;
  }

  return null;
}

/** True only for strings Date.parse accepts that also match the ISO-like shape (guards loose parsing). */
export function isValidIsoTimestamp(value: string): boolean {
  const trimmed = value.trim();
  return ISO_TIMESTAMP_PATTERN.test(trimmed) && Number.isFinite(Date.parse(trimmed));
}

/**
 * Filesystem-safe rendering of a timestamp for use in result file names:
 * colons and other path-hostile characters become dashes.
 */
function sanitizeTimestampForFilename(timestamp: string): string {
  return timestamp.replace(/[^A-Za-z0-9._-]+/g, "-");
}

/** Resolve the eval-case root: `evalsPath` if given, else PTC_EVALS_PATH, else .pi/evals/ptc under cwd. */
export function resolveBenchmarkEvalsPath(cwd: string = process.cwd(), evalsPath: string = process.env.PTC_EVALS_PATH || ".pi/evals/ptc"): string {
  return path.resolve(cwd, evalsPath);
}

/** `<provider>__<model>` directory/file slug; non-alphanumeric runs collapse to dashes. */
export function getProviderModelSlug(provider: string, model: string): string {
  const normalize = (value: string) => {
    const slug = value.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
    return slug || "unknown";
  };

  return `${normalize(provider)}__${normalize(model)}`;
}

/** Result file location: <evalsPath>/results/<provider-model-slug>/<timestamp>.json. */
export function getDefaultBenchmarkResultPath(evalsPath: string, provider: string, model: string, timestamp: string): string {
  return path.join(evalsPath, "results", getProviderModelSlug(provider, model), `${sanitizeTimestampForFilename(timestamp)}.json`);
}

/** Baseline file location: <evalsPath>/baselines/<provider-model-slug>.json. */
export function getDefaultBenchmarkBaselinePath(evalsPath: string, provider: string, model: string): string {
  return path.join(evalsPath, "baselines", `${getProviderModelSlug(provider, model)}.json`);
}

/**
 * Load (and validate) every `cases/*.json` under the evals path, sorted by
 * filename. With `caseIds`, only those cases are returned and unknown ids
 * throw (listing the available ids). Throws with the file path on parse or
 * validation failure.
 */
export function loadEvalCasesFromDisk(evalsPath: string, caseIds?: string[]): EvalCase[] {
  const casesDir = path.join(evalsPath, "cases");
  const fileNames = fs
    .readdirSync(casesDir)
    .filter((entry) => entry.endsWith(".json"))
    .sort();
  const selectedCaseIds = caseIds && caseIds.length > 0 ? new Set(caseIds) : null;

  const cases = fileNames.map((fileName) => {
    const filePath = path.join(casesDir, fileName);
    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to parse eval case file ${filePath}: ${message}`);
    }
    return parseEvalCase(parsed, filePath);
  });

  if (!selectedCaseIds) {
    return cases;
  }

  const matched = cases.filter((evalCase) => selectedCaseIds.has(evalCase.id));
  const matchedIds = new Set(matched.map((evalCase) => evalCase.id));
  const unknownIds = [...selectedCaseIds].filter((id) => !matchedIds.has(id)).sort();
  if (unknownIds.length > 0) {
    const availableIds = cases.map((evalCase) => evalCase.id).sort();
    throw new Error(
      `Unknown eval case id(s): ${unknownIds.join(", ")}${
        availableIds.length > 0 ? `. Available case id(s): ${availableIds.join(", ")}` : " (no eval cases found)"
      }`
    );
  }

  return matched;
}

/**
 * Offline executor for CI: routes via the same heuristic as production
 * auto-routing but never invokes a model. Recovery/failure-class/output_json
 * expectations are read from the case's acceptance rules; token counts are
 * ceil(chars/4) of a synthesized char count and durations are char counts —
 * estimates, not real timings.
 */
export function createDeterministicBenchmarkExecutor(): BenchmarkCaseExecutor {
  return (evalCase, context) => {
    const observed_first_path: BenchmarkObservedFirstPath = shouldAutoRoutePromptToCodeExecution(evalCase.prompt)
      ? "code_execution"
      : "direct";
    const recoveryExpected = parseBoolean(getRuleExpectation(evalCase.acceptance.rules, "recovery_attempted")) === true;
    const failureClass = parseFailureClass(getRuleExpectation(evalCase.acceptance.rules, "failure_class"));
    const wantsJson = parseBoolean(getRuleExpectation(evalCase.acceptance.rules, "output_json")) === true;
    const recovery_attempted = observed_first_path === "code_execution" && recoveryExpected;
    const output = wantsJson
      ? JSON.stringify({ case_id: evalCase.id, provider: context.provider, model: context.model })
      : `completed:${evalCase.id}`;
    const total_tokens = estimateTokensFromChars(
      evalCase.prompt.length + output.length + context.provider.length + context.model.length
    );
    const duration_ms = evalCase.prompt.length + evalCase.id.length;

    return {
      observed_first_path,
      recovery_attempted,
      failure_class: recovery_attempted ? failureClass : null,
      total_tokens,
      duration_ms,
      output,
    } satisfies BenchmarkObservation;
  };
}

function evaluateRule(rule: string, record: BenchmarkResult, output: string | undefined): boolean {
  const expectation = parseRuleExpectation(rule);
  if (!expectation) {
    return false;
  }

  switch (expectation.key) {
    case "observed_first_path":
      return record.observed_first_path === expectation.value;
    case "success": {
      const expected = parseBoolean(expectation.value);
      return expected !== undefined && record.success === expected;
    }
    case "recovery_attempted": {
      const expected = parseBoolean(expectation.value);
      return expected !== undefined && record.recovery_attempted === expected;
    }
    case "failure_class":
      return (record.failure_class ?? "null") === expectation.value;
    case "output_json": {
      const expected = parseBoolean(expectation.value);
      if (expected === false) {
        return false;
      }

      if (expected !== true || typeof output !== "string") {
        return false;
      }

      try {
        JSON.parse(output);
        return true;
      } catch {
        return false;
      }
    }
    default:
      return false;
  }
}

/**
 * Evaluate every acceptance rule for a case against one observation and
 * package the outcome. `success` defaults to all non-`success=` rules passing
 * unless the observation states it; rule_outcomes records each rule's verdict.
 */
export function buildBenchmarkResultRecord(
  evalCase: EvalCase,
  provider: string,
  model: string,
  observation: BenchmarkObservation
): BenchmarkResultRecord {
  const baseResult: BenchmarkResult = {
    case_id: evalCase.id,
    provider,
    model,
    expected_first_path: evalCase.expected_first_path,
    observed_first_path: observation.observed_first_path ?? "none",
    success: false,
    recovery_attempted: observation.recovery_attempted ?? false,
    failure_class: observation.failure_class ?? null,
    total_tokens: observation.total_tokens ?? 0,
    duration_ms: observation.duration_ms ?? 0,
  };

  const nonSuccessRules = evalCase.acceptance.rules.filter((rule) => !rule.startsWith("success="));
  const passesNonSuccessRules = nonSuccessRules.every((rule) => evaluateRule(rule, baseResult, observation.output));
  const result: BenchmarkResult = {
    ...baseResult,
    success: observation.success ?? passesNonSuccessRules,
  };
  const rule_outcomes = evalCase.acceptance.rules.map((rule) => ({
    rule,
    passed: evaluateRule(rule, result, observation.output),
  }));

  return { result, rule_outcomes };
}

function buildBenchmarkSummary(records: BenchmarkResultRecord[]): BenchmarkRunSummary {
  return {
    total_cases: records.length,
    successful_cases: records.filter((record) => record.result.success).length,
    routed_cases: records.filter((record) => record.result.observed_first_path === "code_execution").length,
    recovery_attempts: records.filter((record) => record.result.recovery_attempted).length,
  };
}

function isRecordValue(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateBenchmarkRunShape(value: unknown, filePath: string): BenchmarkRun {
  const issues: string[] = [];

  if (!isRecordValue(value)) {
    throw new Error(`Benchmark run at ${filePath} has an unexpected shape: expected an object`);
  }

  if (typeof value.provider !== "string" || value.provider.length === 0) {
    issues.push("provider must be a non-empty string");
  }
  if (typeof value.model !== "string" || value.model.length === 0) {
    issues.push("model must be a non-empty string");
  }
  if (typeof value.generated_at !== "string" || value.generated_at.length === 0) {
    issues.push("generated_at must be a non-empty string");
  }
  if (!Array.isArray(value.results)) {
    issues.push("results must be an array");
  } else {
    value.results.forEach((entry, index) => {
      const caseId = isRecordValue(entry) && isRecordValue(entry.result) ? entry.result.case_id : undefined;
      if (typeof caseId !== "string" || caseId.length === 0) {
        issues.push(`results[${index}].result.case_id must be a non-empty string`);
      }
    });
  }
  if (!isRecordValue(value.summary)) {
    issues.push("summary must be an object");
  }

  if (issues.length > 0) {
    throw new Error(`Benchmark run at ${filePath} has an unexpected shape: ${issues.join("; ")}`);
  }

  return value as unknown as BenchmarkRun;
}

/** Read and shape-check a previously written benchmark run file; throws on parse or shape errors. */
export function readBenchmarkRun(filePath: string): BenchmarkRun {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to parse benchmark run file ${filePath}: ${message}`);
  }

  return validateBenchmarkRunShape(parsed, filePath);
}

/**
 * Diff a current run against a baseline: flags cases that regressed in routing
 * (baseline met its expectation, current doesn't), lost recovery, changed
 * failure class, or lost success. Cases present on only one side are reported
 * as added/removed, not regressions.
 */
export function compareBenchmarkRuns(current: BenchmarkRun, baseline: BenchmarkRun, baselinePath: string): BenchmarkComparison {
  const regressions: BenchmarkRegression[] = [];
  const currentIds = new Set(current.results.map((record) => record.result.case_id));
  const baselineByCaseId = new Map(baseline.results.map((record) => [record.result.case_id, record.result]));

  for (const record of current.results) {
    const currentResult = record.result;
    const baselineResult = baselineByCaseId.get(currentResult.case_id);
    if (!baselineResult) {
      continue;
    }

    if (
      baselineResult.observed_first_path === baselineResult.expected_first_path &&
      currentResult.observed_first_path !== currentResult.expected_first_path
    ) {
      regressions.push({
        case_id: currentResult.case_id,
        kind: "routing",
        message: `routing regressed from ${baselineResult.observed_first_path} to ${currentResult.observed_first_path}`,
      });
    }

    if (baselineResult.recovery_attempted && !currentResult.recovery_attempted) {
      regressions.push({
        case_id: currentResult.case_id,
        kind: "recovery",
        message: "recovery no longer triggers for a previously recovered case",
      });
    }

    if (baselineResult.failure_class && baselineResult.failure_class !== currentResult.failure_class) {
      regressions.push({
        case_id: currentResult.case_id,
        kind: "recovery",
        message: `failure class regressed from ${baselineResult.failure_class} to ${currentResult.failure_class ?? "null"}`,
      });
    }

    if (baselineResult.success && !currentResult.success) {
      regressions.push({
        case_id: currentResult.case_id,
        kind: "success",
        message: "case no longer satisfies acceptance rules",
      });
    }
  }

  const addedCaseIds = [...currentIds].filter((caseId) => !baselineByCaseId.has(caseId)).sort();
  const removedCaseIds = [...baselineByCaseId.keys()].filter((caseId) => !currentIds.has(caseId)).sort();

  return {
    baseline_path: baselinePath,
    regressions,
    added_case_ids: addedCaseIds,
    removed_case_ids: removedCaseIds,
  };
}

/**
 * Run the eval suite through `executor` (deterministic offline by default) and
 * assemble the BenchmarkRun, including a baseline comparison when
 * `baselinePath` is given. Results are ordered by the executor's completion.
 */
export async function runBenchmarkSuite(options: BenchmarkRunOptions): Promise<BenchmarkRun> {
  const evalsPath = resolveBenchmarkEvalsPath(process.cwd(), options.evalsPath);
  const executor = options.executor ?? createDeterministicBenchmarkExecutor();
  const context = { provider: options.provider, model: options.model };
  const evalCases = loadEvalCasesFromDisk(evalsPath, options.caseIds);
  const results: BenchmarkResultRecord[] = [];

  for (const evalCase of evalCases) {
    const observation = await executor(evalCase, context);
    results.push(buildBenchmarkResultRecord(evalCase, options.provider, options.model, observation));
  }

  const run: BenchmarkRun = {
    provider: options.provider,
    model: options.model,
    generated_at: options.timestamp ?? new Date().toISOString(),
    results,
    summary: buildBenchmarkSummary(results),
  };

  if (options.baselinePath) {
    const baseline = readBenchmarkRun(options.baselinePath);
    run.comparison = compareBenchmarkRuns(run, baseline, options.baselinePath);
  }

  return run;
}

/** Write a run as pretty-printed JSON (2-space, trailing newline), creating parent dirs. */
export function writeBenchmarkRun(filePath: string, run: BenchmarkRun): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(run, null, 2)}\n`, "utf8");
}

interface ParsedCliArgs {
  provider: string;
  model: string;
  evalsPath?: string;
  baselinePath?: string;
  resultsPath?: string;
  caseIds?: string[];
  timestamp?: string;
}

function requireCliValue(argv: string[], flagIndex: number, flag: string): string {
  const value = argv[flagIndex + 1];
  if (value === undefined || value.trim() === "" || value.startsWith("-")) {
    const got = value === undefined ? "no value provided" : `invalid value ${JSON.stringify(value)}`;
    throw new Error(`${flag} requires a value (${got})`);
  }
  return value;
}

/** Parse the runner CLI; throws on unknown flags, missing values, or a non-ISO --timestamp. */
export function parseCliArgs(argv: string[]): ParsedCliArgs {
  const parsed: ParsedCliArgs = {
    provider: "local",
    model: "deterministic",
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    switch (arg) {
      case "--provider":
        parsed.provider = requireCliValue(argv, index, arg);
        index += 1;
        break;
      case "--model":
        parsed.model = requireCliValue(argv, index, arg);
        index += 1;
        break;
      case "--evals-path":
        parsed.evalsPath = requireCliValue(argv, index, arg);
        index += 1;
        break;
      case "--baseline":
        parsed.baselinePath = requireCliValue(argv, index, arg);
        index += 1;
        break;
      case "--results-path":
        parsed.resultsPath = requireCliValue(argv, index, arg);
        index += 1;
        break;
      case "--cases":
        parsed.caseIds = requireCliValue(argv, index, arg)
          .split(",")
          .map((value) => value.trim())
          .filter(Boolean);
        index += 1;
        break;
      case "--timestamp": {
        const value = requireCliValue(argv, index, arg);
        if (!isValidIsoTimestamp(value)) {
          throw new Error(
            `--timestamp must be an ISO-like timestamp (e.g. 2026-03-16T00:00:00.000Z), got ${JSON.stringify(value)}`
          );
        }
        parsed.timestamp = value;
        index += 1;
        break;
      }
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return parsed;
}

/**
 * CLI entry point: parse args, run the suite, write the result file (default
 * path from provider/model/timestamp), and print a one-line JSON status with
 * the results path, summary, and any baseline comparison.
 */
export async function runBenchmarkCli(argv: string[] = process.argv.slice(2)): Promise<BenchmarkRun> {
  const parsed = parseCliArgs(argv);
  const evalsPath = resolveBenchmarkEvalsPath(process.cwd(), parsed.evalsPath);
  const run = await runBenchmarkSuite({
    provider: parsed.provider,
    model: parsed.model,
    evalsPath,
    caseIds: parsed.caseIds,
    baselinePath: parsed.baselinePath,
    timestamp: parsed.timestamp,
  });
  const resultsPath = parsed.resultsPath ?? getDefaultBenchmarkResultPath(evalsPath, run.provider, run.model, run.generated_at);

  writeBenchmarkRun(resultsPath, run);
  process.stdout.write(`${JSON.stringify({ results_path: resultsPath, summary: run.summary, comparison: run.comparison ?? null })}\n`);
  return run;
}
