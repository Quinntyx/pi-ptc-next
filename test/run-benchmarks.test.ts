const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const repoRoot = path.join(__dirname, "..");
const cliPath = path.join(repoRoot, "dist", "run-benchmarks.js");
const seededEvalsPath = path.join(repoRoot, ".pi", "evals", "ptc");

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ptc-run-benchmarks-"));
}

test("run-benchmarks CLI exits non-zero when comparison has regressions", () => {
  const tempDir = makeTempDir();
  const evalsPath = path.join(tempDir, "evals");
  const resultsPath = path.join(tempDir, "results.json");
  const baselinePath = path.join(tempDir, "baseline.json");

  fs.mkdirSync(path.join(evalsPath, "cases"), { recursive: true });
  fs.writeFileSync(
    path.join(evalsPath, "cases", "case.json"),
    JSON.stringify({
      id: "cli-regression-case",
      prompt: "Count files across the repo and return compact JSON only.",
      expected_first_path: "direct",
      acceptance: {
        type: "behavioral",
        rules: ["observed_first_path=direct", "success=true"],
      },
    })
  );
  fs.writeFileSync(
    baselinePath,
    JSON.stringify({
      provider: "local",
      model: "ci",
      generated_at: "2026-03-16T00:00:00.000Z",
      results: [
        {
          result: {
            case_id: "cli-regression-case",
            provider: "local",
            model: "ci",
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
    })
  );

  const result = spawnSync(
    process.execPath,
    [
      cliPath,
      "--provider",
      "local",
      "--model",
      "ci",
      "--evals-path",
      evalsPath,
      "--baseline",
      baselinePath,
      "--results-path",
      resultsPath,
      "--timestamp",
      "2026-03-16T00:00:00.000Z",
    ],
    { encoding: "utf8" }
  );

  assert.equal(result.status, 1, `expected exit code 1, stderr: ${result.stderr}`);
  const written = JSON.parse(fs.readFileSync(resultsPath, "utf8"));
  assert.equal(written.comparison.regressions.length > 0, true);
});

test("run-benchmarks CLI exits non-zero and writes no results for unknown --cases ids", () => {
  const tempDir = makeTempDir();
  const resultsPath = path.join(tempDir, "results.json");

  const result = spawnSync(
    process.execPath,
    [
      cliPath,
      "--provider",
      "local",
      "--model",
      "ci",
      "--evals-path",
      seededEvalsPath,
      "--cases",
      "definitely-not-a-case",
      "--results-path",
      resultsPath,
      "--timestamp",
      "2026-03-16T00:00:00.000Z",
    ],
    { encoding: "utf8" }
  );

  assert.equal(result.status, 1, `expected exit code 1, stderr: ${result.stderr}`);
  assert.match(result.stderr, /Unknown eval case id\(s\): definitely-not-a-case/);
  assert.equal(fs.existsSync(resultsPath), false);
});

test("run-benchmarks CLI rejects invalid flag values with a non-zero exit", () => {
  const tempDir = makeTempDir();
  const resultsPath = path.join(tempDir, "results.json");

  const missingValue = spawnSync(process.execPath, [cliPath, "--provider"], { encoding: "utf8" });
  assert.equal(missingValue.status, 1);
  assert.match(missingValue.stderr, /--provider requires a value/);

  const badTimestamp = spawnSync(
    process.execPath,
    [cliPath, "--evals-path", seededEvalsPath, "--results-path", resultsPath, "--timestamp", "not-a-date"],
    { encoding: "utf8" }
  );
  assert.equal(badTimestamp.status, 1);
  assert.match(badTimestamp.stderr, /--timestamp must be an ISO-like timestamp/);
  assert.equal(fs.existsSync(resultsPath), false);
});
