const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { parseEvalCase, validateEvalCase } = require("../dist/eval-cases.js");

const casesDir = path.join(__dirname, "..", ".pi", "evals", "ptc", "cases");
const requiredCaseFiles = [
  "ptc-positive-multi-file-aggregation.json",
  "ptc-positive-repo-count-ranking.json",
  "direct-negative-single-file-read.json",
  "direct-negative-mutation-fix.json",
  "recovery-missing-await.json",
  "recovery-async-wrapper-iterated.json",
];

function readCase(fileName: string) {
  const filePath = path.join(casesDir, fileName);
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

test("seeded PTC eval case files exist for routing and recovery buckets", () => {
  const caseFiles = new Set(fs.readdirSync(casesDir).filter((entry: string) => entry.endsWith(".json")));

  assert.deepEqual([...caseFiles].sort(), [...requiredCaseFiles].sort());
});

test("seeded PTC eval case files validate against the deterministic schema", () => {
  for (const fileName of requiredCaseFiles) {
    const parsed = parseEvalCase(readCase(fileName), fileName);

    assert.equal(parsed.id.length > 0, true);
    assert.equal(parsed.prompt.length > 0, true);
    assert.equal(parsed.acceptance.rules.length > 0, true);
  }
});

test("validateEvalCase rejects malformed cases deterministically", () => {
  const errors = validateEvalCase({
    prompt: "   ",
    expected_first_path: "none",
    acceptance: {
      type: "approximate",
      rules: ["", 3],
    },
  });

  assert.deepEqual(errors, [
    "id must be a non-empty string",
    "prompt must be a non-empty string",
    'expected_first_path must be "code_execution" or "direct"',
    'acceptance.type must be "exact", "structural", or "behavioral"',
    "acceptance.rules[0] must be a non-empty string",
    "acceptance.rules[1] must be a non-empty string",
  ]);
});

test("parseEvalCase surfaces the source name in deterministic validation failures", () => {
  assert.throws(
    () => parseEvalCase({ id: "broken", prompt: "hi", expected_first_path: "direct", acceptance: {} }, "broken.json"),
    /broken\.json validation failed: acceptance.type must be "exact", "structural", or "behavioral"; acceptance.rules must be a non-empty array of strings/
  );
});

test("validateEvalCase rejects rules with unknown keys or missing key=value form", () => {
  const errors = validateEvalCase({
    id: "typo-case",
    prompt: "hi",
    expected_first_path: "direct",
    acceptance: {
      type: "behavioral",
      rules: ["observed_first_path=code_execution", "recovery_atempted=true", "success", "=true", "output_json=true"],
    },
  });

  assert.deepEqual(errors, [
    'acceptance.rules[1] has unknown rule key "recovery_atempted" (expected one of: observed_first_path, success, recovery_attempted, failure_class, output_json)',
    'acceptance.rules[2] must match "key=value" with a known rule key',
    'acceptance.rules[3] must match "key=value" with a known rule key',
  ]);
});
