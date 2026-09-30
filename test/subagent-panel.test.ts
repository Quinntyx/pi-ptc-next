const test = require("node:test");
const assert = require("node:assert/strict");
const { renderSubagentNotification, renderSubagentPanel } = require("../dist/execution/subagent-panel.js");

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
  assert.ok(plain.some((l) => l.startsWith("  ▸ ") && l.includes("● docs-sweeper"))); // awaited marker in the gutter (narrow-glyph U+25B8); running rows sort by start
  assert.ok(plain.some((l) => l.includes("├ ● test-digger") && l.includes("ctx 230k/1m (23%)")));
  assert.ok(plain.some((l) => l.includes("╰ testing · 12.0s · 3 tool calls · thinking 6.2s")));
  assert.ok(plain.filter((l) => l === "    │").length >= 2); // rail continuation lines
  assert.ok(!plain.some((l) => l.includes("╰ synthesizing · ") && l.includes("tool call")));
});

test("last-child detail rows nest under the status glyph, not the branch column", () => {
  const now = Date.now();
  const noopTheme = { fg: (_c, s) => s };
  const snapshot = {
    agents: [
      { id: "a", name: "first", group: "audit", status: "running", startedAt: now - 60_000, elapsedMs: 60_000, label: "inspecting" },
      { id: "b", name: "last", group: "audit", status: "closed", startedAt: now - 50_000, elapsedMs: 50_000, phase: "idle", label: null },
    ],
    totals: { running: 1, settled: 1, failed: 0 },
    groups: { audit: now - 60_000 },
    timestamp: now,
  };
  const plain = renderSubagentPanel(snapshot, noopTheme).map((l) => l.replace(/\x1b\[[0-9;]*m/g, ""));

  // non-last detail: rail + connector, text aligned with the agent name
  assert.ok(plain.some((l) => l === "    │ ╰ inspecting"), plain.join("\n"));
  // last detail: same connector column (6) even though there is no rail —
  // a "    ╰" would read as a sibling agent row
  assert.ok(plain.some((l) => l === "      ╰ idle"), plain.join("\n"));
  assert.ok(!plain.some((l) => l === "    ╰ idle"), plain.join("\n"));
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

test("declared stages with no agents render as idle, matching the live header style", () => {
  const now = Date.now();
  const noopTheme = { fg: (_c, s) => s };
  const snapshot = {
    agents: [
      { id: "a", name: "review-runtime-a", group: "review", status: "running", execScope: "exec_cur", startedAt: now - 60_000, elapsedMs: 60_000, toolCalls: 2, awaited: false },
      { id: "b", name: "review-runtime-b", group: "review", status: "running", execScope: "exec_cur", startedAt: now - 55_000, elapsedMs: 55_000, toolCalls: 1, awaited: false },
    ],
    totals: { running: 2, settled: 0, failed: 0 },
    groups: { review: now - 60_000 },
    pools: [
      {
        id: "p1", name: "two-pass", status: "open", concurrency: 6, running: 2, queued: 0, results: 0,
        startedAt: now - 60_000,
        stages: [
          { id: "s1", name: "review", slots: 4, queued: 0, running: 2, submitted: 2, settled: 0, failed: 0, cancelled: 0, startedAt: now - 60_000 },
          { id: "s2", name: "adjudicate", slots: 2, queued: 0, running: 0, submitted: 0, settled: 0, failed: 0, cancelled: 0, startedAt: now - 59_000 },
        ],
      },
    ],
    timestamp: now,
  };

  const lines = renderSubagentPanel(snapshot, noopTheme, "exec_cur");
  const plain = lines.map((l) => l.replace(/\x1b\[[0-9;]*m/g, ""));
  const text = plain.join("\n");

  // the idle stage renders with the same header shape as live stages
  // (dot replaced by a checkmark) and an "idle" detail row — not the
  // bracketed ad-hoc styling.
  assert.ok(plain.some((l) => l.trim().startsWith("✓ adjudicate ·")), plain.join("\n"));
  assert.ok(text.includes("╰ idle"), plain.join("\n"));
  assert.ok(!text.includes("[2 slots]"), "no ad-hoc slot brackets");
  assert.ok(!text.includes("no tasks yet"), "no ad-hoc idle text");
  // the review stage has agents, so it renders its group, not an idle row
  assert.ok(plain.some((l) => l.trim().startsWith("● review ·")));
  assert.ok(!text.includes("4/4 done (earlier cell)"));
  // footer unaffected by idle stages
  assert.ok(text.includes("2 running"));
});

test("a stage whose agents settled in an earlier cell shows its tally, styled identically", () => {
  const now = Date.now();
  const noopTheme = { fg: (_c, s) => s };
  const snapshot = {
    agents: [],
    totals: { running: 0, settled: 0, failed: 0 },
    groups: {},
    pools: [
      {
        id: "p1", name: "wf", status: "open", concurrency: 4, running: 0, queued: 0, results: 0,
        startedAt: now - 300_000,
        stages: [
          { id: "s1", name: "build", slots: 2, queued: 0, running: 0, submitted: 4, settled: 4, failed: 0, cancelled: 0, startedAt: now - 300_000 },
        ],
      },
    ],
    timestamp: now,
  };

  const lines = renderSubagentPanel(snapshot, noopTheme, "exec_cur");
  const plain = lines.map((l) => l.replace(/\x1b\[[0-9;]*m/g, ""));
  const text = plain.join("\n");
  assert.ok(plain.some((l) => l.trim().startsWith("✓ build ·")), text);
  assert.ok(text.includes("╰ 4/4 done (earlier cell)"), text);
  assert.ok(!text.includes("[2 slots]"));
});

test("queued rows are capped, active rows lead, and completed rows precede overflow", () => {
  const now = Date.now();
  const noopTheme = { fg: (_c, s) => s };
  const agents = [
    { id: "done", name: "finished", group: "work", status: "closed", startedAt: now - 20_000, elapsedMs: 16_000 },
    ...Array.from({ length: 5 }, (_, i) => ({ id: `q${i}`, name: `queued-${i}`, group: "work", status: "queued", startedAt: now + i, elapsedMs: 0 })),
    { id: "run", name: "executing", group: "work", status: "running", startedAt: now - 5_000, elapsedMs: 5_000 },
  ];
  const snapshot = { agents, groups: { work: now - 20_000 }, timestamp: now };
  const plain = renderSubagentPanel(snapshot, noopTheme).join("\n");

  assert.equal((plain.match(/queued-\d/g) || []).length, 2, plain);
  assert.ok(plain.includes("… 3 more queued"), plain);
  assert.ok(plain.indexOf("executing") < plain.indexOf("queued-0"), plain);
  assert.ok(plain.indexOf("queued-1") < plain.indexOf("finished"), plain);
  assert.ok(plain.indexOf("finished") < plain.indexOf("3 more queued"), plain);
  assert.ok(plain.includes("finished · 16.0s"), plain);

  const notification = renderSubagentNotification(snapshot, noopTheme);
  assert.ok(notification);
  assert.ok(!notification.includes("queued-0"), notification);
  assert.ok(notification.includes("⎿ … 5 more queued"), notification);
  assert.ok(notification.includes("✓ finished"), notification);
});

test("idle agents and stages freeze rather than displaying wall-clock age", () => {
  const now = Date.now();
  const noopTheme = { fg: (_c, s) => s };
  const snapshot = {
    agents: [
      { id: "idle", name: "retained", group: "review", status: "running", idle: true, startedAt: now - 300_000, elapsedMs: 12_500, busyMs: 12_500 },
    ],
    groups: { review: now - 300_000 },
    pools: [{
      id: "p", name: "wf", status: "open", concurrency: 2, running: 0, queued: 0, results: 0, startedAt: now - 300_000,
      stages: [
        { id: "review", name: "review", slots: 1, queued: 0, running: 0, submitted: 1, settled: 0, failed: 0, cancelled: 0, startedAt: now - 300_000, busyMs: 12_500, activeSince: null },
        { id: "later", name: "later", slots: 1, queued: 0, running: 0, submitted: 0, settled: 0, failed: 0, cancelled: 0, startedAt: now - 299_000, busyMs: 0, activeSince: null },
      ],
    }],
    timestamp: now,
  };
  const plain = renderSubagentPanel(snapshot, noopTheme).join("\n");
  const idleRow = plain.split("\n").find((line) => line.includes("retained"));

  assert.ok(plain.includes("● review · 12.5s"), plain);
  assert.ok(plain.includes("✓ later · 0.0s"), plain);
  assert.ok(plain.includes("idle · waiting for orchestrator"), plain);
  assert.ok(idleRow && !idleRow.includes("12.5s"), plain);
  assert.ok(plain.includes("1 idle") && !plain.includes("1 running"), plain);
});

test("notification and live metadata use dim styling and zero context limits are safe", () => {
  const now = Date.now();
  const theme = { fg: (color, text) => `<${color}>${text}</${color}>` };
  const snapshot = {
    agents: [{ id: "a", name: "worker", group: "stage", status: "closed", startedAt: now - 16_000, elapsedMs: 16_000, toolCalls: 2, ctx: { tokens: 10, limit: 0 } }],
    groups: { stage: now - 16_000 },
    timestamp: now,
  };
  const panel = renderSubagentPanel(snapshot, theme).join("\n");
  const notification = renderSubagentNotification(snapshot, theme);

  assert.ok(panel.includes("<text>worker</text>"), panel);
  assert.ok(panel.includes("<dim>· 16.0s</dim>"), panel);
  assert.ok(panel.includes("(0%)") && !panel.includes("Infinity"), panel);
  assert.ok(panel.includes("✓ 1 done"), panel);
  assert.ok(notification.includes("<text>worker</text>"), notification);
  assert.ok(notification.includes("<dim>· 16.0s · 2 tool calls · ctx 0k/0k (0%)</dim>"), notification);
});
