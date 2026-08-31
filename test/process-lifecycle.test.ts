const test = require("node:test");
const assert = require("node:assert/strict");
const { CodeExecutor } = require("../dist/code-executor.js");
const { createSandbox } = require("../dist/sandbox-manager.js");

function settings(overrides = {}) {
  return {
    executionTimeoutMs: 10_000,
    maxOutputChars: 10_000,
    allowMutations: false,
    allowBash: false,
    maxParallelToolCalls: 4,
    useDocker: false,
    allowUnsandboxedSubprocess: true,
    debugLogging: false,
    autoRoute: false,
    callableTools: undefined,
    blockedTools: undefined,
    ...overrides,
  };
}

function toolRegistry() {
  return {
    createCallableToolRuntime() {
      return { tools: [], runTool: async () => null };
    },
  };
}

test("tight loops rate-limit progress frames and return only after Python is reaped", async () => {
  const realSandbox = await createSandbox(settings());
  let proc;
  const sandbox = {
    spawn(code, cwd) {
      proc = realSandbox.spawn(code, cwd);
      return proc;
    },
    terminate(child, signal) {
      return realSandbox.terminate(child, signal);
    },
    getRuntimeWorkspaceRoot(cwd) {
      return realSandbox.getRuntimeWorkspaceRoot(cwd);
    },
    async cleanup() {
      await realSandbox.cleanup();
    },
  };
  const executor = new CodeExecutor(sandbox, toolRegistry(), settings(), process.cwd());
  let progressUpdates = 0;

  try {
    const result = await executor.execute(
      "total = 0\nfor i in range(200000):\n    total += i\nreturn total",
      {
        cwd: process.cwd(),
        ctx: { cwd: process.cwd() },
        onUpdate: () => { progressUpdates += 1; },
      }
    );

    assert.equal(result.output, "19999900000");
    assert.ok(progressUpdates < 100, `expected throttled progress, received ${progressUpdates} updates`);
    assert.equal(proc.exitCode, 0);
    assert.equal(proc.signalCode, null);
  } finally {
    await sandbox.cleanup();
  }
});

test("a timed-out real Python loop is terminated and reaped before rejection returns", async () => {
  const realSandbox = await createSandbox(settings());
  let proc;
  const sandbox = {
    spawn(code, cwd) {
      proc = realSandbox.spawn(code, cwd);
      return proc;
    },
    terminate(child, signal) {
      return realSandbox.terminate(child, signal);
    },
    getRuntimeWorkspaceRoot(cwd) {
      return realSandbox.getRuntimeWorkspaceRoot(cwd);
    },
    async cleanup() {
      await realSandbox.cleanup();
    },
  };
  const executor = new CodeExecutor(
    sandbox,
    toolRegistry(),
    settings({ executionTimeoutMs: 100 }),
    process.cwd()
  );

  try {
    await assert.rejects(
      executor.execute("while True:\n    pass", {
        cwd: process.cwd(),
        ctx: { cwd: process.cwd() },
      }),
      /timed out/
    );

    assert.notEqual(proc.signalCode, null);
    assert.equal(proc.exitCode, null);
  } finally {
    await sandbox.cleanup();
  }
});

test("Python caps printed output before it can flood the RPC pipe", async () => {
  const sandbox = await createSandbox(settings());
  const executor = new CodeExecutor(
    sandbox,
    toolRegistry(),
    settings({ maxOutputChars: 1_000 }),
    process.cwd()
  );

  try {
    const result = await executor.execute(
      "print('x' * 500000, end='')",
      { cwd: process.cwd(), ctx: { cwd: process.cwd() } }
    );

    assert.equal(result.output.slice(0, 1_000), "x".repeat(1_000));
    assert.match(result.output, /showing first 1000 characters of 500000/);
  } finally {
    await sandbox.cleanup();
  }
});
