const test = require("node:test");
const assert = require("node:assert/strict");
const { renderSubagentPanel } = require("../dist/execution/subagent-panel.js");

test("subagent fan panel renders groups, awaited arrow, and status lines", () => {
  const noopTheme = { fg: (_c, s) => s };
      const now = Date.now();
  const snapshot = {
    agents: [
      { id: "a", name: "test-digger", group: "researching", status: "running", startedAt: now - 63000, elapsedMs: 63000, toolCalls: 27, thinkingMs: 6200, label: "testing", labelElapsedMs: 12000, labelCalls: 3, awaited: false, ctx: { tokens: 230000, limit: 1000000, percent: 23 } },
      { id: "b", name: "docs-sweeper", group: "researching", status: "running", startedAt: now - 10500, elapsedMs: 10500, toolCalls: 48, label: "scanning", labelCalls: 1, awaited: true, ctx: { tokens: 580000, limit: 1000000, percent: 58 } },
      { id: "c", name: "planner", group: "researching", status: "running", startedAt: now - 19200, elapsedMs: 19200, toolCalls: 7, label: "synthesizing", labelCalls: 0, awaited: false, ctx: { tokens: 12000, limit: 1000000, percent: 1 } },
    ],
    totals: { running: 2, settled: 0, failed: 0 },
    groups: { researching: now - 63000 },
    timestamp: now,
  };
  const lines = renderSubagentPanel(snapshot, noopTheme);
  const plain = lines.map((l) => l.replace(/\x1b\[[0-9;]*m/g, ""));
  assert.ok(plain.some((l) => l.startsWith("    ● researching")), plain.join("\n"));
  assert.ok(plain.some((l) => l.startsWith("  ▶ ├ ● docs-sweeper"))); // arrow in the gutter, tree glyph at col 4
  assert.ok(plain.some((l) => l.includes("├ ● test-digger") && l.includes("ctx 230k/1m (23%)")));
  assert.ok(plain.some((l) => l.includes("╰ testing · 12s · 3 tool calls · thinking 6.2s")));
  assert.ok(plain.filter((l) => l === "    │").length >= 2); // rail continuation lines
  assert.ok(!plain.some((l) => l.includes("╰ synthesizing · ") && l.includes("tool call")));
});

test("the fan is scoped to the exec being streamed and settled rows freeze their runtime", () => {
  const now = Date.now();
  const hoursAgo = now - 1300 * 60_000;
  const noopTheme = { fg: (_c, s) => s };
  const snapshot = {
    agents: [
      // A batch from a previous PTC call in the same (long-lived) interpreter,
      // settled long before this exec began.
      { id: "old", name: "batch2-ds", group: "old batch", status: "settled", execScope: "exec_old", startedAt: hoursAgo, elapsedMs: 1300 * 60_000, label: "idle" },
      // Spawned in the exec being streamed.
      { id: "cur", name: "gktA-scaffold", group: "this exec", status: "running", execScope: "exec_cur", startedAt: now - 200_000, elapsedMs: 200_000, label: "exploring", labelElapsedMs: 90_000, labelCalls: 3, awaited: true },
      // Spawned in an earlier exec but still awaited now.
      { id: "hang", name: "carried-over", status: "running", execScope: "exec_prev", startedAt: now - 500_000, elapsedMs: 500_000 },
    ],
    totals: { running: 2, settled: 1, failed: 0 },
    groups: { "old batch": hoursAgo, "this exec": now - 200_000 },
    timestamp: now,
  };

  const lines = renderSubagentPanel(snapshot, noopTheme, "exec_cur");
  const plain = lines.map((l) => l.replace(/\x1b\[[0-9;]*m/g, ""));
  const text = plain.join("\n");

  assert.ok(text.includes("gktA-scaffold"), "the current exec's agents render");
  assert.ok(text.includes("carried-over"), "agents still awaited from earlier execs render");
  assert.ok(!text.includes("batch2-ds"), "agents settled before this exec stay out");
  assert.ok(!text.includes("1300m"), "no age-of-handle numbers");
  // Frozen runtime: a running row ticks from its own start, not the registry's age.
  assert.ok(plain.some((l) => l.includes("gktA-scaffold") && l.includes("3m 20s")), plain.join("\n"));

  // Without scoping context (the global runtime API) everything is returned.
  assert.ok(renderSubagentPanel(snapshot, noopTheme).length > 0);
});
