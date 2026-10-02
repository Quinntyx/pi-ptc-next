const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const skill = fs.readFileSync(path.join(__dirname, "../skills/pi-subagents/SKILL.md"), "utf8");
const api = skill.split("# API\n")[1].split("# Rules\n")[0];
const blocks = [...api.matchAll(/```python\n([\s\S]*?)\n```/g)].map((match) => match[1]);

test("subagent API example uses three explicitly numbered notebook cells", () => {
  assert.equal(blocks.length, 3);
  for (let i = 0; i < blocks.length; i++) {
    assert.match(blocks[i].split("\n")[0], new RegExp(`^# Block ${i + 1} —`));
  }
  assert.ok(!blocks[0].includes("subagents.Task("));
  assert.ok(blocks[0].includes("REPORT_SCHEMA"));
  assert.ok(blocks[1].includes("subagents.Task("));
  assert.ok(blocks[1].includes("cwd=str(WORK_DIR)"));
  assert.ok(blocks[1].includes("pool.pop("));
  assert.ok(blocks[2].includes("pool.close()"));
});

test("workflow examples consume validated bodies and have replay guards", () => {
  const source = blocks.join("\n");
  assert.doesNotMatch(source, /fail_fast\s*=|\.ok\b|\.unwrap\(|confirm\s*=|review\s*=/);
  assert.ok(blocks[1].includes("result.body"));
  assert.ok(blocks[1].includes("result_path.exists()"));
  assert.ok(blocks[1].includes("active_workflow_key != workflow_key"));
});

test("review, failure handling and activity API guidance name the current contracts", () => {
  assert.match(skill, /request_cell_review/);
  assert.match(skill, /AgentPoolFailureError/);
  assert.match(skill, /SchemaValidationError/);
  assert.match(skill, /three repair follow-ups/);
  assert.match(skill, /pi-activity/);
  assert.match(skill, /## /);
});
