const test = require("node:test");
const assert = require("node:assert/strict");
const { renderSubagentPanel } = require("../dist/execution/subagent-panel.js");

test("subagent fan panel renders groups, awaited arrow, and status lines", () => {
  const noopTheme = { fg: (_c, s) => s };
      const now = Date.now();
  const snapshot = {
    agents: [
      { id: "a", name: "test-digger", group: "researching", status: "running", startedAt: now - 63000, elapsedMs: 63000, toolCalls: 27, thinkingMs: 6200, label: "testing", labelElapsedMs: 12000, awaited: false, ctx: { tokens: 230000, limit: 1000000, percent: 23 } },
      { id: "b", name: "docs-sweeper", group: "researching", status: "running", startedAt: now - 10500, elapsedMs: 10500, toolCalls: 48, label: "scanning", awaited: true, ctx: { tokens: 580000, limit: 1000000, percent: 58 } },
      { id: "c", name: "planner", group: "researching", status: "running", startedAt: now - 19200, elapsedMs: 19200, toolCalls: 7, label: "synthesizing", awaited: false, ctx: { tokens: 12000, limit: 1000000, percent: 1 } },
    ],
    totals: { running: 2, settled: 0, failed: 0 },
    groups: { researching: now - 63000 },
    timestamp: now,
  };
  const lines = renderSubagentPanel(snapshot, noopTheme);
  const plain = lines.map((l) => l.replace(/\x1b\[[0-9;]*m/g, ""));
  assert.ok(plain.some((l) => l.startsWith("    ● researching")), plain.join("\n"));
  assert.ok(plain.some((l) => l.includes("▶ ├ ● docs-sweeper")));
  assert.ok(plain.some((l) => l.includes("├ ● test-digger") && l.includes("ctx 230k/1m (23%)")));
  assert.ok(plain.some((l) => l.includes("╰ testing") && l.includes("thinking 6.2s")));
});