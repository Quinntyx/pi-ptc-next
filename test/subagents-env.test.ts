const test = require("node:test");
const assert = require("node:assert/strict");
const {
  isStampStale,
  shouldAttemptSync,
  resolvePackageDir,
  resolveSourceDir,
  sourceAvailable,
  defaultCacheRoot,
  venvPythonPath,
  DEFAULT_PYTHON_VERSION,
  ensureSubagentsEnv,
  pidAlive,
  readLockPid,
} = require("../dist/subagents-env.js");

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function makeOptions(cacheRoot, extensionRoot, extra = {}) {
  return {
    cacheRoot,
    extensionRoot: extensionRoot ?? cacheRoot,
    // Keep every test off the real dev checkout / managed clone.
    devSource: path.join(cacheRoot, "no-such-dev-checkout"),
    ...extra,
  };
}

function writeStamp(extensionRoot, stamp) {
  fs.writeFileSync(path.join(extensionRoot, ".ptc-subagents-sync.json"), JSON.stringify(stamp));
}

function readStamp(extensionRoot) {
  return JSON.parse(fs.readFileSync(path.join(extensionRoot, ".ptc-subagents-sync.json"), "utf8"));
}

/** Spawn a child that stays alive; returns { pid, stop }. */
function spawnLiveProcess() {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1e6)"], {
    stdio: "ignore",
  });
  return { pid: child.pid, stop: () => child.kill() };
}

/** Wait until predicate() is true or the deadline passes. */
async function waitFor(predicate, deadlineMs = 5000) {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > deadlineMs) throw new Error("waitFor: deadline exceeded");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

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

// --- improvement 11: retry sooner on failed stamps -------------------------------

test("shouldAttemptSync retries a fresh failed stamp only when the runtime is missing", () => {
  const now = 1_000_000;
  const interval = 24 * 3_600_000;
  const freshFailed = { syncedAt: now - 60_000, ok: false };
  const freshOk = { syncedAt: now - 60_000, ok: true };
  // Stale stamps always sync.
  assert.equal(shouldAttemptSync({ syncedAt: now - interval - 1, ok: true }, interval, now, true), true);
  // Fresh ok stamp skips even without a runtime.
  assert.equal(shouldAttemptSync(freshOk, interval, now, false), false);
  // Fresh failed stamp + runtime present: keep the throttle.
  assert.equal(shouldAttemptSync(freshFailed, interval, now, true), false);
  // Fresh failed stamp + runtime missing: retry immediately (was 24h-blocked).
  assert.equal(shouldAttemptSync(freshFailed, interval, now, false), true);
});

test("sourceAvailable accepts a dev checkout or a managed clone", () => {
  const tmp = tmpDir("ptc-src-avail-");
  try {
    assert.equal(sourceAvailable(path.join(tmp, "missing"), path.join(tmp, "clone")), false);
    const checkout = makeCheckout("flat", tmp);
    assert.equal(sourceAvailable(checkout, path.join(tmp, "clone")), true);
    fs.mkdirSync(path.join(tmp, "clone", ".git"), { recursive: true });
    assert.equal(sourceAvailable(path.join(tmp, "missing"), path.join(tmp, "clone")), true);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("ensureSubagentsEnv retries immediately after a failed initial clone", async () => {
  const cacheRoot = tmpDir("ptc-retry-");
  const extensionRoot = tmpDir("ptc-retry-ext-");
  // Pretend the venv already exists so the retry path skips venv creation.
  fs.mkdirSync(path.join(cacheRoot, `python-env-${DEFAULT_PYTHON_VERSION}`,
    process.platform === "win32" ? "Scripts" : "bin"), { recursive: true });
  fs.writeFileSync(venvPythonPath(cacheRoot), "");
  try {
    // Fresh stamp recording a failed sync; no venv python, no clone → runtime missing.
    writeStamp(extensionRoot, { syncedAt: Date.now(), ok: false });
    const result = await ensureSubagentsEnv(
      makeOptions(cacheRoot, extensionRoot, {
        // Local nonexistent repo: git clone fails fast, no network needed.
        repoUrl: path.join(cacheRoot, "no-such-repo"),
      }),
    );
    assert.equal(result.status, "failed");
    assert.match(result.reason, /git clone/);
    // The failed attempt was re-stamped and logged.
    assert.equal(readStamp(extensionRoot).ok, false);
    assert.ok(fs.existsSync(path.join(cacheRoot, "subagents-sync.log")));
    // The lock was released afterwards.
    assert.equal(fs.existsSync(path.join(cacheRoot, "subagents-sync.lock")), false);
  } finally {
    fs.rmSync(cacheRoot, { recursive: true, force: true });
    fs.rmSync(extensionRoot, { recursive: true, force: true });
  }
});

test("ensureSubagentsEnv keeps the throttle for a fresh failed stamp when the runtime is present", async () => {
  const cacheRoot = tmpDir("ptc-throttle-");
  const extensionRoot = tmpDir("ptc-throttle-ext-");
  try {
    // Fake a ready runtime: venv python + managed clone with .git.
    fs.mkdirSync(path.join(cacheRoot, "python-env", "bin"), { recursive: true });
    fs.writeFileSync(path.join(cacheRoot, "python-env", "bin", "python"), "");
    fs.mkdirSync(path.join(cacheRoot, "pi-subagents", ".git"), { recursive: true });
    writeStamp(extensionRoot, { syncedAt: Date.now(), ok: false });
    const result = await ensureSubagentsEnv(makeOptions(cacheRoot, extensionRoot));
    assert.equal(result.status, "skipped");
    assert.equal(result.reason, "recently synced");
    // No sync attempt: the log was never touched.
    assert.equal(fs.existsSync(path.join(cacheRoot, "subagents-sync.log")), false);
  } finally {
    fs.rmSync(cacheRoot, { recursive: true, force: true });
    fs.rmSync(extensionRoot, { recursive: true, force: true });
  }
});

// --- improvement 11: log rotation ------------------------------------------------

test("ensureSubagentsEnv rotates an oversized sync log", async () => {
  const cacheRoot = tmpDir("ptc-logrot-");
  const extensionRoot = tmpDir("ptc-logrot-ext-");
  try {
    fs.mkdirSync(path.join(cacheRoot, "python-env", "bin"), { recursive: true });
    fs.writeFileSync(path.join(cacheRoot, "python-env", "bin", "python"), "");
    const logFile = path.join(cacheRoot, "subagents-sync.log");
    fs.writeFileSync(logFile, "x".repeat(1_100_000));
    const result = await ensureSubagentsEnv(
      makeOptions(cacheRoot, extensionRoot, { repoUrl: path.join(cacheRoot, "no-such-repo") }),
    );
    assert.equal(result.status, "failed");
    assert.ok(fs.existsSync(`${logFile}.1`), "rotated backup should exist");
    assert.ok(fs.statSync(`${logFile}.1`).size > 1_000_000);
    assert.ok(fs.statSync(logFile).size < 1_000_000, "new log file should be fresh");
  } finally {
    fs.rmSync(cacheRoot, { recursive: true, force: true });
    fs.rmSync(extensionRoot, { recursive: true, force: true });
  }
});

// --- M9 / L18: pid-tagged atomic lock --------------------------------------------

test("pidAlive detects live and dead pids", async () => {
  assert.equal(pidAlive(process.pid), true);
  assert.equal(pidAlive(0), false);
  assert.equal(pidAlive(-1), false);
  const { pid, stop } = spawnLiveProcess();
  try {
    await waitFor(() => pidAlive(pid));
    assert.equal(pidAlive(pid), true);
  } finally {
    stop();
  }
  await waitFor(() => !pidAlive(pid));
  assert.equal(pidAlive(pid), false);
});

test("ensureSubagentsEnv skips while a live foreign pid holds the lock", async () => {
  const cacheRoot = tmpDir("ptc-lock-live-");
  const { pid, stop } = spawnLiveProcess();
  try {
    await waitFor(() => pidAlive(pid));
    fs.writeFileSync(path.join(cacheRoot, "subagents-sync.lock"), String(pid));
    const result = await ensureSubagentsEnv(makeOptions(cacheRoot));
    assert.equal(result.status, "skipped");
    assert.equal(result.reason, "another sync holds the lock");
    // The foreign lock was not broken or removed.
    assert.equal(readLockPid(path.join(cacheRoot, "subagents-sync.lock")), pid);
  } finally {
    stop();
    fs.rmSync(cacheRoot, { recursive: true, force: true });
  }
});

test("ensureSubagentsEnv breaks a stale lock whose recorded pid is dead", async () => {
  const cacheRoot = tmpDir("ptc-lock-dead-");
  const lockFile = path.join(cacheRoot, "subagents-sync.lock");
  try {
    // A pid that cannot exist on a sane system.
    fs.writeFileSync(lockFile, "2147483646");
    const result = await ensureSubagentsEnv(
      makeOptions(cacheRoot, undefined, { repoUrl: path.join(cacheRoot, "no-such-repo") }),
    );
    // The dead holder's lock was broken and the sync proceeded (and failed on clone).
    assert.equal(result.status, "failed");
    assert.equal(fs.existsSync(lockFile), false, "lock must be released after the run");
  } finally {
    fs.rmSync(cacheRoot, { recursive: true, force: true });
  }
});

test("ensureSubagentsEnv still skips a fresh legacy (timestamp) lock and breaks an aged one", async () => {
  const cacheRoot = tmpDir("ptc-lock-legacy-");
  const lockFile = path.join(cacheRoot, "subagents-sync.lock");
  try {
    // Legacy locks hold a timestamp, not a pid.
    const fakeNow = 10_000_000_000;
    fs.writeFileSync(lockFile, String(fakeNow - 60_000));
    const fresh = await ensureSubagentsEnv(makeOptions(cacheRoot, undefined, { now: () => fakeNow }));
    assert.equal(fresh.status, "skipped");
    assert.equal(fresh.reason, "another sync holds the lock");

    fs.writeFileSync(lockFile, String(fakeNow - 10 * 60_000));
    const stale = await ensureSubagentsEnv(
      makeOptions(cacheRoot, undefined, {
        now: () => fakeNow,
        repoUrl: path.join(cacheRoot, "no-such-repo"),
      }),
    );
    assert.equal(stale.status, "failed"); // aged legacy lock broken; sync ran
    assert.equal(fs.existsSync(lockFile), false);
  } finally {
    fs.rmSync(cacheRoot, { recursive: true, force: true });
  }
});

test("ensureSubagentsEnv releases its own pid-tagged lock after a run", async () => {
  const cacheRoot = tmpDir("ptc-lock-release-");
  const lockFile = path.join(cacheRoot, "subagents-sync.lock");
  try {
    // Fresh ok stamp → sync is a no-op, but the lock is still taken and released.
    writeStamp(cacheRoot, { syncedAt: Date.now(), ok: true });
    fs.mkdirSync(path.join(cacheRoot, "python-env", "bin"), { recursive: true });
    fs.writeFileSync(path.join(cacheRoot, "python-env", "bin", "python"), "");
    fs.mkdirSync(path.join(cacheRoot, "pi-subagents", ".git"), { recursive: true });
    const result = await ensureSubagentsEnv(makeOptions(cacheRoot));
    assert.equal(result.status, "skipped");
    assert.equal(fs.existsSync(lockFile), false);
  } finally {
    fs.rmSync(cacheRoot, { recursive: true, force: true });
  }
});

test("readLockPid tolerates missing or non-numeric lock content", () => {
  const tmp = tmpDir("ptc-lockpid-");
  try {
    const lockFile = path.join(tmp, "lock");
    assert.equal(readLockPid(lockFile), undefined);
    fs.writeFileSync(lockFile, "not-a-pid\n");
    assert.equal(readLockPid(lockFile), undefined);
    fs.writeFileSync(lockFile, "  1234  \n");
    assert.equal(readLockPid(lockFile), 1234);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// --- C5: shared venv path helpers -------------------------------------------------

test("defaultCacheRoot and venvPythonPath agree on the canonical layout", () => {
  const root = path.join("some", "cache");
  // Preferred layout: version-pinned venv (DEFAULT_PYTHON_VERSION).
  assert.equal(venvPythonPath(root), path.join(root, `python-env-${DEFAULT_PYTHON_VERSION}`, "bin", "python"));
  // The no-root variant resolves the *effective* shared venv: the pinned one
  // when present, else the legacy unversioned venv on upgraded installs.
  const expected = ["", "-"].map((suffix) =>
    path.join(defaultCacheRoot(), `python-env${suffix}`, "bin", "python")).find((p) => fs.existsSync(p));
  assert.equal(venvPythonPath(), expected);
  if (process.platform === "win32") {
    assert.match(venvPythonPath(root), /Scripts[\\/]python\.exe$/);
  }
});
