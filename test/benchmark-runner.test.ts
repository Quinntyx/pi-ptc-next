const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  buildBenchmarkResultRecord,
  compareBenchmarkRuns,
  createDeterministicBenchmarkExecutor,
  getDefaultBenchmarkResultPath,
  getProviderModelSlug,
  isValidIsoTimestamp,
  loadEvalCasesFromDisk,
  parseCliArgs,
  readBenchmarkRun,
  resolveBenchmarkEvalsPath,
  runBenchmarkCli,
  runBenchmarkSuite,
  writeBenchmarkRun,
} = require("../dist/benchmark-runner.js");

const seededEvalsPath = path.join(__dirname, "..", ".pi", "evals", "ptc");

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ptc-benchmark-"));
}

test("buildBenchmarkResultRecord preserves required benchmark result fields", () => {
  const record = buildBenchmarkResultRecord(
    {
      id: "recovery-missing-await",
      prompt: "Use Python to read package.json and return compact JSON only.",
      expected_first_path: "code_execution",
      acceptance: {
        type: "behavioral",
        rules: [
          "observed_first_path=code_execution",
          "recovery_attempted=true",
          "failure_class=missing-await",
          "success=true",
        ],
      },
    },
    "local",
    "seeded",
    {
      observed_first_path: "code_execution",
      recovery_attempted: true,
      failure_class: "missing-await",
      total_tokens: 12,
      duration_ms: 34,
      output: '{"ok":true}',
    }
  );

  assert.deepEqual(record.result, {
    case_id: "recovery-missing-await",
    provider: "local",
    model: "seeded",
    expected_first_path: "code_execution",
    observed_first_path: "code_execution",
    success: true,
    recovery_attempted: true,
    failure_class: "missing-await",
    total_tokens: 12,
    duration_ms: 34,
  });
});

test("runBenchmarkSuite executes a seeded eval subset and returns deterministic JSON-ready results", async () => {
  const run = await runBenchmarkSuite({
    provider: "local",
    model: "seeded",
    evalsPath: seededEvalsPath,
    caseIds: ["ptc-positive-multi-file-aggregation", "recovery-missing-await"],
    timestamp: "2026-03-16T00:00:00.000Z",
    executor: async (evalCase) => ({
      observed_first_path: evalCase.expected_first_path,
      recovery_attempted: evalCase.id === "recovery-missing-await",
      failure_class: evalCase.id === "recovery-missing-await" ? "missing-await" : null,
      total_tokens: 21,
      duration_ms: 8,
      output: '{"ok":true}',
    }),
  });

  assert.equal(run.provider, "local");
  assert.equal(run.model, "seeded");
  assert.equal(run.generated_at, "2026-03-16T00:00:00.000Z");
  assert.equal(run.summary.total_cases, 2);
  assert.equal(run.summary.successful_cases, 2);
  assert.equal(run.summary.recovery_attempts, 1);
  assert.equal(JSON.parse(JSON.stringify(run)).results.length, 2);
  assert.equal(run.results[1].result.failure_class, "missing-await");
});

test("compareBenchmarkRuns reports routing and recovery regressions deterministically", () => {
  const baseline = {
    provider: "local",
    model: "seeded",
    generated_at: "2026-03-16T00:00:00.000Z",
    results: [
      {
        result: {
          case_id: "recovery-missing-await",
          provider: "local",
          model: "seeded",
          expected_first_path: "code_execution",
          observed_first_path: "code_execution",
          success: true,
          recovery_attempted: true,
          failure_class: "missing-await",
          total_tokens: 11,
          duration_ms: 7,
        },
        rule_outcomes: [],
      },
    ],
    summary: {
      total_cases: 1,
      successful_cases: 1,
      routed_cases: 1,
      recovery_attempts: 1,
    },
  };
  const current = {
    provider: "local",
    model: "seeded",
    generated_at: "2026-03-16T00:00:01.000Z",
    results: [
      {
        result: {
          case_id: "recovery-missing-await",
          provider: "local",
          model: "seeded",
          expected_first_path: "code_execution",
          observed_first_path: "direct",
          success: false,
          recovery_attempted: false,
          failure_class: null,
          total_tokens: 9,
          duration_ms: 6,
        },
        rule_outcomes: [],
      },
    ],
    summary: {
      total_cases: 1,
      successful_cases: 0,
      routed_cases: 0,
      recovery_attempts: 0,
    },
  };

  const comparison = compareBenchmarkRuns(current, baseline, "/tmp/baseline.json");

  assert.deepEqual(comparison, {
    baseline_path: "/tmp/baseline.json",
    added_case_ids: [],
    removed_case_ids: [],
    regressions: [
      {
        case_id: "recovery-missing-await",
        kind: "routing",
        message: "routing regressed from code_execution to direct",
      },
      {
        case_id: "recovery-missing-await",
        kind: "recovery",
        message: "recovery no longer triggers for a previously recovered case",
      },
      {
        case_id: "recovery-missing-await",
        kind: "recovery",
        message: "failure class regressed from missing-await to null",
      },
      {
        case_id: "recovery-missing-await",
        kind: "success",
        message: "case no longer satisfies acceptance rules",
      },
    ],
  });
});

test("runBenchmarkCli writes a result file and emits comparison output for a seeded subset", async () => {
  const tempDir = makeTempDir();
  const evalsPath = path.join(tempDir, "evals");
  const resultsPath = path.join(tempDir, "results.json");
  const baselinePath = path.join(tempDir, "baseline.json");

  fs.mkdirSync(path.join(evalsPath, "cases"), { recursive: true });
  fs.writeFileSync(
    path.join(evalsPath, "cases", "case.json"),
    JSON.stringify(
      {
        id: "ptc-positive-multi-file-aggregation",
        prompt: "Find the top 5 most imported packages across all TypeScript files in src and return compact JSON only.",
        expected_first_path: "code_execution",
        acceptance: {
          type: "behavioral",
          rules: ["observed_first_path=code_execution", "success=true", "output_json=true"],
        },
      },
      null,
      2
    )
  );

  writeBenchmarkRun(baselinePath, {
    provider: "local",
    model: "seeded",
    generated_at: "2026-03-16T00:00:00.000Z",
    results: [
      {
        result: {
          case_id: "ptc-positive-multi-file-aggregation",
          provider: "local",
          model: "seeded",
          expected_first_path: "code_execution",
          observed_first_path: "direct",
          success: false,
          recovery_attempted: false,
          failure_class: null,
          total_tokens: 5,
          duration_ms: 5,
        },
        rule_outcomes: [],
      },
    ],
    summary: {
      total_cases: 1,
      successful_cases: 0,
      routed_cases: 0,
      recovery_attempts: 0,
    },
  });

  const originalWrite = process.stdout.write;
  let stdout = "";
  process.stdout.write = (((chunk: string | Uint8Array<ArrayBufferLike>, ...args: unknown[]) => {
    stdout += String(chunk);
    const maybeCallback = args[args.length - 1];
    if (typeof maybeCallback === "function") {
      maybeCallback();
    }
    return true;
  }) as typeof process.stdout.write);

  try {
    await runBenchmarkCli([
      "--provider",
      "local",
      "--model",
      "seeded",
      "--evals-path",
      evalsPath,
      "--baseline",
      baselinePath,
      "--results-path",
      resultsPath,
      "--timestamp",
      "2026-03-16T00:00:00.000Z",
    ]);
  } finally {
    process.stdout.write = originalWrite;
  }

  const writtenRun = JSON.parse(fs.readFileSync(resultsPath, "utf8"));
  const emitted = JSON.parse(stdout.trim());

  assert.equal(writtenRun.results.length, 1);
  assert.equal(writtenRun.results[0].result.case_id, "ptc-positive-multi-file-aggregation");
  assert.equal(writtenRun.comparison.regressions.length, 0);
  assert.deepEqual(emitted, {
    results_path: resultsPath,
    summary: writtenRun.summary,
    comparison: writtenRun.comparison,
  });
});

test("benchmark helper paths stay under the eval root and sanitize the timestamp", () => {
  const evalsPath = resolveBenchmarkEvalsPath("/repo", ".pi/evals/ptc");

  assert.equal(evalsPath, path.join("/repo", ".pi", "evals", "ptc"));
  assert.equal(getProviderModelSlug("OpenAI", "gpt-5.4-mini"), "openai__gpt-5.4-mini");
  // Colons are unsafe in filenames on Windows and hostile to shells.
  assert.equal(
    getDefaultBenchmarkResultPath(evalsPath, "OpenAI", "gpt-5.4-mini", "2026-03-16T00:00:00.000Z"),
    path.join(evalsPath, "results", "openai__gpt-5.4-mini", "2026-03-16T00-00-00.000Z.json")
  );
  assert.equal(
    getDefaultBenchmarkResultPath(evalsPath, "openai", "gpt", "bad:timestamp:with:colons"),
    path.join(evalsPath, "results", "openai__gpt", "bad-timestamp-with-colons.json")
  );
});

test("deterministic benchmark executor derives recovery hints from eval rules", async () => {
  const executor = createDeterministicBenchmarkExecutor();
  const observation = await executor(
    {
      id: "recovery-async-wrapper-iterated",
      prompt: "Count imports across src/**/*.ts and return compact JSON only.",
      expected_first_path: "code_execution",
      acceptance: {
        type: "behavioral",
        rules: [
          "observed_first_path=code_execution",
          "recovery_attempted=true",
          "failure_class=async-wrapper-iterated",
          "output_json=true",
        ],
      },
    },
    { provider: "local", model: "seeded" }
  );

  assert.equal(observation.observed_first_path, "code_execution");
  assert.equal(observation.recovery_attempted, true);
  assert.equal(observation.failure_class, "async-wrapper-iterated");
  assert.deepEqual(JSON.parse(observation.output), {
    case_id: "recovery-async-wrapper-iterated",
    provider: "local",
    model: "seeded",
  });
});

test("parseCliArgs rejects missing or flag-like values for value-taking flags", () => {
  assert.throws(() => parseCliArgs(["--provider"]), /--provider requires a value \(no value provided\)/);
  assert.throws(() => parseCliArgs(["--provider", "--model", "m"]), /--provider requires a value/);
  assert.throws(() => parseCliArgs(["--model", "--cases", "x"]), /--model requires a value/);
  assert.throws(() => parseCliArgs(["--evals-path"]), /--evals-path requires a value/);
  assert.throws(() => parseCliArgs(["--baseline", ""]), /--baseline requires a value/);
  assert.throws(() => parseCliArgs(["--results-path", "--timestamp"]), /--results-path requires a value/);
  assert.throws(() => parseCliArgs(["--cases"]), /--cases requires a value/);
  assert.throws(() => parseCliArgs(["--timestamp"]), /--timestamp requires a value/);

  const parsed = parseCliArgs([
    "--provider",
    "openai",
    "--model",
    "gpt-5.4-mini",
    "--cases",
    "a,b",
    "--timestamp",
    "2026-03-16T00:00:00.000Z",
  ]);
  assert.equal(parsed.provider, "openai");
  assert.equal(parsed.model, "gpt-5.4-mini");
  assert.deepEqual(parsed.caseIds, ["a", "b"]);
  assert.equal(parsed.timestamp, "2026-03-16T00:00:00.000Z");
});

test("parseCliArgs validates the timestamp format", () => {
  assert.throws(() => parseCliArgs(["--timestamp", "not-a-date"]), /--timestamp must be an ISO-like timestamp/);
  assert.throws(() => parseCliArgs(["--timestamp", "2026-03-16T99:00:00Z"]), /--timestamp must be an ISO-like timestamp/);
  assert.equal(isValidIsoTimestamp("2026-03-16T00:00:00.000Z"), true);
  assert.equal(isValidIsoTimestamp("2026-03-16"), true);
  assert.equal(isValidIsoTimestamp("nope"), false);
  assert.equal(isValidIsoTimestamp("2026:03:16"), false);
});

test("runBenchmarkSuite errors when requested case ids match no shipped case", async () => {
  await assert.rejects(
    () =>
      runBenchmarkSuite({
        provider: "local",
        model: "seeded",
        evalsPath: seededEvalsPath,
        caseIds: ["does-not-exist", "also-missing"],
      }),
    (error: Error) => {
      assert.match(error.message, /Unknown eval case id\(s\): also-missing, does-not-exist/);
      assert.match(error.message, /Available case id\(s\):/);
      return true;
    }
  );
});

test("loadEvalCasesFromDisk includes the file path in malformed JSON errors", () => {
  const tempDir = makeTempDir();
  fs.mkdirSync(path.join(tempDir, "cases"));
  fs.writeFileSync(path.join(tempDir, "cases", "broken.json"), "{ not json");

  assert.throws(() => loadEvalCasesFromDisk(tempDir), (error: Error) => {
    assert.match(error.message, /Failed to parse eval case file/);
    assert.match(error.message, /broken\.json/);
    return true;
  });
});

test("loadEvalCasesFromDisk surfaces the file path in validation errors", () => {
  const tempDir = makeTempDir();
  fs.mkdirSync(path.join(tempDir, "cases"));
  fs.writeFileSync(
    path.join(tempDir, "cases", "invalid.json"),
    JSON.stringify({ id: "invalid", prompt: "hi", expected_first_path: "nonsense", acceptance: { type: "exact", rules: ["success=true"] } })
  );

  assert.throws(() => loadEvalCasesFromDisk(tempDir), /invalid\.json validation failed/);
});

test("readBenchmarkRun rejects shape-mismatched baseline files", () => {
  const tempDir = makeTempDir();
  const filePath = path.join(tempDir, "baseline.json");

  fs.writeFileSync(filePath, JSON.stringify({ provider: "local", results: "not-an-array" }));
  assert.throws(() => readBenchmarkRun(filePath), /results must be an array/);

  fs.writeFileSync(filePath, JSON.stringify({ results: [{ result: { case_id: "" } }], summary: {} }));
  assert.throws(() => readBenchmarkRun(filePath), /results\[0\]\.result\.case_id must be a non-empty string/);

  fs.writeFileSync(filePath, "not json at all");
  assert.throws(() => readBenchmarkRun(filePath), /Failed to parse benchmark run file/);
});

test("compareBenchmarkRuns reports added and removed case ids", () => {
  const baseline = {
    provider: "local",
    model: "seeded",
    generated_at: "2026-03-16T00:00:00.000Z",
    results: [
      {
        result: {
          case_id: "removed-case",
          provider: "local",
          model: "seeded",
          expected_first_path: "direct",
          observed_first_path: "direct",
          success: true,
          recovery_attempted: false,
          failure_class: null,
          total_tokens: 1,
          duration_ms: 1,
        },
        rule_outcomes: [],
      },
    ],
    summary: { total_cases: 1, successful_cases: 1, routed_cases: 0, recovery_attempts: 0 },
  };
  const current = {
    provider: "local",
    model: "seeded",
    generated_at: "2026-03-16T00:00:01.000Z",
    results: [
      {
        result: {
          case_id: "added-case",
          provider: "local",
          model: "seeded",
          expected_first_path: "direct",
          observed_first_path: "direct",
          success: true,
          recovery_attempted: false,
          failure_class: null,
          total_tokens: 1,
          duration_ms: 1,
        },
        rule_outcomes: [],
      },
    ],
    summary: { total_cases: 1, successful_cases: 1, routed_cases: 0, recovery_attempts: 0 },
  };

  const comparison = compareBenchmarkRuns(current, baseline, "/tmp/baseline.json");

  assert.deepEqual(comparison.added_case_ids, ["added-case"]);
  assert.deepEqual(comparison.removed_case_ids, ["removed-case"]);
  assert.deepEqual(comparison.regressions, []);
});

test("shipped eval cases all pass under the deterministic executor (smoke)", async () => {
  const run = await runBenchmarkSuite({
    provider: "local",
    model: "smoke",
    evalsPath: seededEvalsPath,
    timestamp: "2026-03-16T00:00:00.000Z",
  });

  assert.equal(run.summary.total_cases, 6);
  for (const record of run.results) {
    assert.equal(
      record.result.observed_first_path,
      record.result.expected_first_path,
      `${record.result.case_id} did not route as expected`
    );
    for (const outcome of record.rule_outcomes) {
      assert.equal(outcome.passed, true, `${record.result.case_id} failed rule: ${outcome.rule}`);
    }
  }
});
