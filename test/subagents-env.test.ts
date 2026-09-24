const test = require("node:test");
const assert = require("node:assert/strict");
const { isStampStale, resolvePackageDir, resolveSourceDir } = require("../dist/subagents-env.js");

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

function makeCheckout(layout, tmpRoot) {
  const dir = path.join(tmpRoot, layout);
  const pyprojectDir = layout === "main" ? path.join(dir, "main") : dir;
  fs.mkdirSync(pyprojectDir, { recursive: true });
  fs.writeFileSync(path.join(pyprojectDir, "pyproject.toml"), '[project]\nname = "pi-subagents"\n');
  return dir;
}

test("resolvePackageDir prefers the main/ layout", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ptc-subagents-"));
  try {
    const flat = makeCheckout("flat", tmp);
    const nested = makeCheckout("main", tmp);
    assert.equal(resolvePackageDir(flat), flat);
    assert.equal(resolvePackageDir(nested), path.join(nested, "main"));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("resolveSourceDir resolves the dev checkout in either layout, else undefined", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ptc-subagents-"));
  try {
    assert.equal(resolveSourceDir(path.join(tmp, "missing")), undefined);
    const nested = makeCheckout("main", tmp);
    assert.equal(resolveSourceDir(nested), path.join(nested, "main"));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("isStampStale honors the interval and tolerates garbage stamps", () => {
  const now = 1_000_000;
  assert.equal(isStampStale(undefined, 3_600_000, now), true);
  assert.equal(isStampStale({ syncedAt: now - 60_000 }, 3_600_000, now), false);
  assert.equal(isStampStale({ syncedAt: now - 7_200_000 }, 3_600_000, now), true);
  assert.equal(isStampStale({ syncedAt: Number.NaN }, 3_600_000, now), true);
});
