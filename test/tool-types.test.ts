const test = require("node:test");
const assert = require("node:assert/strict");

test("tool-types contract module is directly importable", () => {
  const toolTypes = require("../dist/contracts/tool-types.js");
  assert.equal(typeof toolTypes, "object");
});

test("getExplicitCallers treats an explicit empty allowlist as no callers", () => {
  const { getExplicitCallers } = require("../dist/contracts/tool-types.js");

  // Explicit (possibly empty) arrays are authoritative (review items L3/C4).
  assert.deepEqual(getExplicitCallers({ callers: [] }), { explicit: true, callers: new Set() });
  assert.deepEqual(getExplicitCallers({ callers: ["direct"] }), {
    explicit: true,
    callers: new Set(["direct"]),
  });
  assert.deepEqual(getExplicitCallers({ callers: ["direct", "code_execution"] }), {
    explicit: true,
    callers: new Set(["direct", "code_execution"]),
  });

  // Omitted callers carry no caller set; consumers apply their own defaults.
  assert.deepEqual(getExplicitCallers(undefined), { explicit: false });
  assert.deepEqual(getExplicitCallers({ enabled: true }), { explicit: false });
  assert.deepEqual(getExplicitCallers({ callers: undefined }), { explicit: false });
});
