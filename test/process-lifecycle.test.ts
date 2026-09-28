const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { PythonSessionManager } = require("../dist/python-session-manager.js");
const { createSandbox } = require("../dist/sandbox-manager.js");
const { loadSettingsFromEnv, parseSectionedOutput } = require("../dist/utils.js");

function parseSection(text, name) {
  const sections = parseSectionedOutput(text);
  assert.ok(sections, `expected sectioned output, got: ${text.slice(0, 200)}`);
  const found = sections.find((s) => s.name === name);
  assert.ok(found, `expected a '${name}' section in: ${text.slice(0, 200)}`);
  return found.body;
}

function settings(overrides = {}) {
  return {
    ...loadSettingsFromEnv(),
    executionTimeoutMs: 10_000,
    outputPreviewChars: 12_000,
    maxSpoolChars: 10_000_000,
    maxParallelToolCalls: 4,
    maxPythonSessions: 4,
    autoRoute: false,
    ...overrides,
  };
}

function toolRegistry() {
  return {
    createCallableToolRuntime() {
      return { tools: [], runTool: async () => ({ content: [] }) };
    },
  };
}

async function makeManager(overrides = {}) {
  const config = settings(overrides);
  const realSandbox = await createSandbox();
  let proc;
  const sandbox = {
    spawn(code, cwd) {
      proc = realSandbox.spawn(code, cwd);
      return proc;
    },
    terminate(child, signal) {
      return realSandbox.terminate(child, signal);
    },
    resolvePythonExecutable() {
      return realSandbox.resolvePythonExecutable();
    },
    getRuntimeWorkspaceRoot(cwd) {
      return realSandbox.getRuntimeWorkspaceRoot(cwd);
    },
    async cleanup() {
      await realSandbox.cleanup();
    },
  };
  const manager = new PythonSessionManager(
    sandbox,
    toolRegistry(),
    config,
    path.resolve(__dirname, ".."),
  );
  return { manager, sandbox, process: () => proc };
}

function fakeCtx() {
  return { cwd: process.cwd(), hasUI: false };
}

async function dispose(manager, sandbox) {
  await manager.disposeAll();
  await sandbox.cleanup();
}

test("tight loops rate-limit progress frames and the kernel is reaped on disposal", async () => {
  const { manager, sandbox, process: spawnedProcess } = await makeManager();
  let progressUpdates = 0;

  try {
    const { id } = await manager.provision({ cwd: process.cwd(), ctx: fakeCtx() });
    const proc = spawnedProcess();
    const result = await manager.execForeground(
      id,
      "total = 0\nfor i in range(200000):\n    total += i\nreturn total",
      {
        cwd: process.cwd(),
        onUpdate: () => { progressUpdates += 1; },
      },
    );

    assert.equal(parseSection(result.output, "return"), "19999900000");
    assert.ok(progressUpdates < 100, `expected throttled progress, received ${progressUpdates} updates`);
    assert.equal(proc.exitCode, null, "persistent kernel should remain alive after a cell");

    await dispose(manager, sandbox);
    assert.ok(proc.exitCode !== null || proc.signalCode !== null, "kernel process should be reaped");
  } finally {
    await dispose(manager, sandbox);
  }
});

test("an idle timeout interrupts the cell without killing the persistent kernel", async () => {
  const { manager, sandbox, process: spawnedProcess } = await makeManager({ executionTimeoutMs: 200 });

  try {
    const { id } = await manager.provision({ cwd: process.cwd(), ctx: fakeCtx() });
    const proc = spawnedProcess();
    await assert.rejects(
      manager.execForeground(id, "import time\ntime.sleep(30)", { cwd: process.cwd() }),
      /idle for|timed out|interrupted/i,
    );

    assert.equal(proc.exitCode, null);
    assert.equal(proc.signalCode, null);
    const recovered = await manager.execForeground(id, "return 'still alive'", { cwd: process.cwd() });
    assert.match(recovered.output, /^return \(Out\[2\]\):\n  still alive/);
  } finally {
    await dispose(manager, sandbox);
  }
});

test("Python's emergency spool valve caps output once before it reaches the host", async () => {
  const { manager, sandbox } = await makeManager({ maxSpoolChars: 1_000 });

  try {
    const { id } = await manager.provision({ cwd: process.cwd(), ctx: fakeCtx() });
    const result = await manager.execForeground(
      id,
      "print('x' * 500000, end='')",
      { cwd: process.cwd() },
    );

    assert.equal(parseSection(result.output, "output"), "x".repeat(1_000));
    assert.doesNotMatch(result.output, /Output truncated/);
  } finally {
    await dispose(manager, sandbox);
  }
});
