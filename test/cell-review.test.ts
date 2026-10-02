const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { createCellReviewTool } = require("../dist/tools/cell-review.js");

function fixture(decision = { action: "approve" }) {
  const seen = [];
  const manager = {
    list: () => [{ id: "kernel-1" }],
    get: (id) => id === "kernel-1" ? {} : undefined,
    readCell: async (id, n) => {
      seen.push(["read", id, n]);
      return { cells: [{ cellType: n === 2 ? "markdown" : "code", source: "print('review only')" }] };
    },
    exec: () => { throw new Error("review must never execute code"); },
    runCell: () => { throw new Error("review must never execute a notebook cell"); },
  };
  const tool = createCellReviewTool(manager, async (_ctx, id, code) => {
    seen.push(["review", id, code]);
    return decision;
  });
  const call = (params, cwd = process.cwd()) => tool.execute("review-1", params, undefined, undefined, { cwd, hasUI: true });
  return { tool, call, seen };
}

test("reviewing inline code approves without executing or requiring a kernel", async () => {
  const { call, seen } = fixture();
  const result = await call({ code: "raise RuntimeError('do not execute')" });
  assert.equal(result.details.approved, true);
  assert.equal(result.details.rejected, false);
  assert.match(result.content[0].text, /Nothing was executed/);
  assert.deepEqual(seen, [["review", "unbound", "raise RuntimeError('do not execute')"]]);
});

test("reviewing a notebook cell shows its saved source from the most recent kernel", async () => {
  const { call, seen } = fixture();
  const result = await call({ n: 1 });
  assert.equal(result.details.approved, true);
  assert.equal(result.details.sessionId, "kernel-1");
  assert.deepEqual(seen, [["read", "kernel-1", 1], ["review", "kernel-1", "print('review only')"]]);
});

test("rejection returns the user feedback without executing", async () => {
  const { call } = fixture({ action: "reject", note: "Reduce the affected directory scope." });
  const result = await call({ code: "print('draft')" });
  assert.equal(result.details.approved, false);
  assert.equal(result.details.note, "Reduce the affected directory scope.");
  assert.match(result.content[0].text, /Cell rejected/);
});

test("review rejects missing, conflicting, unknown-kernel and markdown inputs", async () => {
  const { call, seen } = fixture();
  for (const params of [{}, { code: "x", n: 1 }, { file: "x.py", code: "x" }, { n: 1, session_id: "missing" }, { n: 2 }]) {
    const result = await call(params);
    assert.equal(result.details.approved, false);
    assert.equal(result.isError, true);
  }
  assert.ok(!seen.some(([kind]) => kind === "review"));
});

test("file review reads the complete file relative to the tool context", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "cell-review-"));
  const source = "print('first line')\nprint('last line')\n";
  await fs.writeFile(path.join(directory, "draft.py"), source);
  const { call, seen } = fixture();
  const result = await call({ file: "draft.py" }, directory);
  assert.equal(result.details.approved, true);
  assert.deepEqual(seen, [["review", "unbound", source]]);
});

test("a broken review dialog fails closed", async () => {
  const tool = createCellReviewTool({}, async () => { throw new Error("dialog unavailable"); });
  const result = await tool.execute("review-1", { code: "x = 1" }, undefined, undefined, { cwd: process.cwd() });
  assert.equal(result.details.approved, false);
  assert.equal(result.details.rejected, true);
  assert.equal(result.isError, true);
});
