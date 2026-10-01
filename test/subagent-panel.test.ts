const test = require("node:test");
const assert = require("node:assert/strict");
const { relevantAgents } = require("../dist/execution/subagent-panel.js");

// The workflow-tree renderer (subagent fan panel, transcript notification) was
// removed in the notebook-output rework. What survives here is the snapshot
// filter the status-bar footer (and a future re-render) builds on.

test("relevantAgents returns all rows when no exec id is given", () => {
  const snapshot = {
    agents: [
      { id: "a", name: "digger", status: "running" },
      { id: "b", name: "sweeper", status: "settled" },
    ],
    totals: { running: 1, settled: 1, failed: 0 },
    timestamp: Date.now(),
  };
  assert.deepEqual(relevantAgents(snapshot).map((a) => a.id), ["a", "b"]);
});

test("relevantAgents scopes to the streamed exec but keeps globally active rows", () => {
  const snapshot = {
    agents: [
      { id: "old", name: "batch2-ds", status: "settled", execScope: "exec_old" },
      { id: "cur", name: "scaffold", status: "running", execScope: "exec_cur" },
      { id: "glob", name: "orphan-runner", status: "running" },
      { id: "q", name: "waiting", status: "queued", execScope: "exec_other" },
      { id: "start", name: "booting", status: "starting", execScope: "exec_other" },
    ],
    totals: { running: 2, settled: 1, failed: 0 },
    timestamp: Date.now(),
  };
  assert.deepEqual(relevantAgents(snapshot, "exec_cur").map((a) => a.id), ["cur", "glob", "q", "start"]);
});

test("relevantAgents tolerates missing or malformed snapshots", () => {
  assert.deepEqual(relevantAgents(undefined), []);
  assert.deepEqual(relevantAgents({ agents: "not-an-array" }), []);
});
