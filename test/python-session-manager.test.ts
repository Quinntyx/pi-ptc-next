const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { PythonSessionManager, UnknownSessionError } = require("../dist/python-session-manager.js");
const { loadSettingsFromEnv } = require("../dist/utils.js");

// Only run the real-interpreter round trip when local subprocess mode is on
// (Docker sandboxing would need a container; CI without PTC envs skips).
const RUN_REAL = process.env.PTC_ALLOW_UNSANDBOXED_SUBPROCESS === "true";

function makeManager(hooks = {}, settingsOverrides = {}) {
  const settings = {
    ...loadSettingsFromEnv(),
    executionTimeoutMs: 30_000,
    maxPythonSessions: 4,
    ...settingsOverrides,
  };
  const sandboxManager = {
    spawn(code, cwd) {
      // Same spawn shape as SubprocessSandbox.
      const { spawn } = require("node:child_process");
      const pythonExe = process.env.PTC_PYTHON_EXECUTABLE
        || (fs.existsSync(path.join(os.homedir(), ".cache", "pi-ptc", "python-env", "bin", "python"))
          ? path.join(os.homedir(), ".cache", "pi-ptc", "python-env", "bin", "python")
          : "python3");
      const proc = spawn(pythonExe, ["-u", "-c", code], { cwd, env: { ...process.env }, detached: process.platform !== "win32" });
      return proc;
    },
    terminate(proc, signal) {
      if (proc.exitCode === null && proc.signalCode === null) {
        try {
          if (process.platform !== "win32" && proc.pid) {
            process.kill(-proc.pid, signal);
            return true;
          }
        } catch {
          // fall through
        }
        return proc.kill(signal);
      }
      return false;
    },
    getRuntimeWorkspaceRoot(cwd) {
      return cwd;
    },
    async cleanup() {},
  };
  const toolRegistry = {
    createCallableToolRuntime() {
      return { tools: [], runTool: async () => ({ content: [] }) };
    },
  };
  return new PythonSessionManager(sandboxManager, toolRegistry, settings, path.resolve(__dirname, ".."), hooks);
}

test("persistent session: definition persists across chunks and returns work", { skip: !RUN_REAL }, async () => {
  const manager = makeManager();
  try {
    const { id } = await manager.provision({ cwd: process.cwd(), ctx: fakeCtx() });

    const first = await manager.execForeground(id, "def double(x):\n    return x * 2\nreturn 'defined'", {});
    assert.equal(first.output, "defined");

    const second = await manager.execForeground(id, "result = [d for d in [double(1), double(2), double(3)]]\nreturn result", {});
    assert.deepEqual(JSON.parse(second.output), [2, 4, 6]);
  } finally {
    await manager.disposeAll();
  }
});

test("persistent session: top-level await chunk works and later chunks see its locals", { skip: !RUN_REAL }, async () => {
  const manager = makeManager();
  try {
    const { id } = await manager.provision({ cwd: process.cwd(), ctx: fakeCtx() });

    const awaited = await manager.execForeground(
      id,
      "await asyncio.sleep(0.01)\nvalue = 'awaited'\nreturn value",
      {}
    );
    assert.equal(awaited.output, "awaited");

    const uses = await manager.execForeground(id, "return value", {});
    assert.equal(uses.output, "awaited");
  } finally {
    await manager.disposeAll();
  }
});

test("persistent session: exec errors do not kill the session", { skip: !RUN_REAL }, async () => {
  const manager = makeManager();
  try {
    const { id } = await manager.provision({ cwd: process.cwd(), ctx: fakeCtx() });

    await assert.rejects(
      manager.execForeground(id, "x = undefined_name\nreturn 1", {}),
      (error) => error.message.includes("undefined_name")
    );

    const recovered = await manager.execForeground(id, "x = 1\nreturn x", {});
    assert.equal(recovered.output, "1");
  } finally {
    await manager.disposeAll();
  }
});

test("persistent session: unknown session id errors with live sessions", { skip: !RUN_REAL }, async () => {
  const manager = makeManager();
  try {
    await assert.rejects(
      manager.execForeground("nope", "return 1", {}),
      (error) => error instanceof UnknownSessionError && error.message.includes("nope")
    );
  } finally {
    await manager.disposeAll();
  }
});

test("persistent session: subagent_state frames flow to the runtime hooks", { skip: !RUN_REAL }, async () => {
  const snapshots = [];
  const manager = makeManager({
    onSubagentSnapshot: (sessionId, snapshot) => snapshots.push({ sessionId, snapshot }),
  });
  try {
    const { id } = await manager.provision({ cwd: process.cwd(), ctx: fakeCtx() });
    await manager.execForeground(
      id,
      "import builtins\nemit = getattr(builtins, 'PTC_STATE_EMIT', None)\nassert emit is not None, 'bridge missing'\nemit({'agents': [{'id': 'a1', 'name': 'probe', 'status': 'running'}], 'totals': {'running': 1}})\nreturn 'emitted'",
      {}
    );

    assert.equal(snapshots.length, 1);
    assert.equal(snapshots[0].sessionId, id);
    assert.deepEqual(snapshots[0].snapshot.agents[0].name, "probe");
  } finally {
    await manager.disposeAll();
  }
});

test("persistent session: script export writes a durable, runnable file", { skip: !RUN_REAL }, async () => {
  const manager = makeManager();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-ptc-script-"));
  try {
    const { id } = await manager.provision({ cwd: tempDir, ctx: fakeCtx() });
    await manager.execForeground(id, "base_value = 21\nreturn 'ok'", {});
    await manager.execForeground(id, "doubled = base_value * 2\nreturn doubled", {});

    const result = await manager.toScript(id, { cwd: tempDir, name: "exported" });
    assert.ok(fs.existsSync(result.path));
    assert.equal(result.cells, 2);
    assert.equal(result.wrappedAsync, false);
    const content = fs.readFileSync(result.path, "utf-8");
    assert.match(content, /# ── cell 1 ──/);
    assert.match(content, /base_value = 21/);
    assert.match(content, /doubled = base_value \* 2/);

    // The exported script runs standalone: exec it in a fresh namespace and
    // confirm the merged variables exist with the right value.
    const { execFileSync } = require("node:child_process");
    const pythonExe = process.env.PTC_PYTHON_EXECUTABLE || "python3";
    const probe = `ns = {}\nexec(open(${JSON.stringify(result.path)}).read(), ns)\nimport json\nprint(json.dumps(ns.get('doubled')))`;
    const stdout = execFileSync(pythonExe, ["-c", probe], { cwd: tempDir, encoding: "utf-8" });
    assert.match(stdout, /42/);
  } finally {
    await manager.disposeAll();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("persistent session: script export wraps async sessions", { skip: !RUN_REAL }, async () => {
  const manager = makeManager();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-ptc-script-"));
  try {
    const { id } = await manager.provision({ cwd: tempDir, ctx: fakeCtx() });
    await manager.execForeground(id, "await asyncio.sleep(0)\nmark = 'async-ok'\nreturn mark", {});

    const result = await manager.toScript(id, { cwd: tempDir });
    assert.equal(result.wrappedAsync, true);
    const content = fs.readFileSync(result.path, "utf-8");
    assert.match(content, /async def main\(\):/);
    assert.match(content, /asyncio\.run\(main\(\)\)/);
    assert.match(content, /mark = 'async-ok'/);
  } finally {
    await manager.disposeAll();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("persistent session: disposal reaps the interpreter", { skip: !RUN_REAL }, async () => {
  const manager = makeManager();
  const { id } = await manager.provision({ cwd: process.cwd(), ctx: fakeCtx() });
  const summaries = manager.list();
  assert.equal(summaries.length, 1);
  assert.equal(summaries[0].id, id);

  await manager.dispose(id);
  assert.equal(manager.list().length, 0);
});

test("persistent session: execForeground forwards partial updates to the caller's onUpdate", { skip: !RUN_REAL }, async () => {
  const manager = makeManager();
  const updates: Array<{ userCode?: string[]; subagentSnapshot?: unknown }> = [];
  try {
    const { id } = await manager.provision({ cwd: process.cwd(), ctx: fakeCtx() });

    // Several executed lines guarantee progress frames; the bridge call
    // guarantees a subagent_state frame — both must reach onUpdate.
    await manager.execForeground(
      id,
      "import builtins, time\nemit = getattr(builtins, 'PTC_STATE_EMIT', None)\nemit({'agents': [{'id': 'a', 'name': 'upd', 'status': 'running'}], 'totals': {'running': 1}})\ntime.sleep(0.2)\nreturn 'done'",
      {
        cwd: process.cwd(),
        onUpdate: (update: { details?: { userCode?: string[]; subagentSnapshot?: unknown } }) => {
          updates.push((update.details ?? {}) as { userCode?: string[]; subagentSnapshot?: unknown });
        },
      }
    );

    assert.ok(updates.length > 0, "expected at least one partial update");
    assert.ok(
      updates.some((update) => Array.isArray(update.userCode) && update.userCode.length > 0),
      "expected a partial update carrying the chunk's code view lines"
    );
    assert.ok(
      updates.some((update) => update.subagentSnapshot !== undefined),
      "expected a partial update carrying the subagent snapshot"
    );
  } finally {
    await manager.disposeAll();
  }
});

test("persistent session: subagent activity re-arms the idle timeout", { skip: !RUN_REAL }, async () => {
  // 1.2s idle window, ~3s of work: only the subagent frames between sleeps keep it alive.
  const manager = makeManager({}, { executionTimeoutMs: 1_200 });
  const updates = [];
  try {
    const { id } = await manager.provision({ cwd: process.cwd(), ctx: fakeCtx() });
    const result = await manager.execForeground(
      id,
      [
        "import builtins, time",
        "emit = getattr(builtins, 'PTC_STATE_EMIT', None)",
        "for i in range(5):",
        "    emit({'agents': [{'id': 'a', 'name': 'tick', 'status': 'running'}], 'totals': {'running': 1, 'tick': i}})",
        "    time.sleep(0.6)",
        "return 'survived'",
      ].join("\n"),
      {
        cwd: process.cwd(),
        onUpdate: (update) => updates.push(update),
      }
    );

    assert.equal(result.output, "survived");
    assert.equal(manager.list().length, 1, "session should still be live");
    assert.ok(updates.length > 0);
  } finally {
    await manager.disposeAll();
  }
});

test("persistent session: idle timeout interrupts the chunk and keeps the session", { skip: !RUN_REAL }, async () => {
  const manager = makeManager({}, { executionTimeoutMs: 1_200 });
  try {
    const { id } = await manager.provision({ cwd: process.cwd(), ctx: fakeCtx() });
    // Bind state before hanging, to prove the namespace survives the interrupt.
    await manager.execForeground(id, "kept = 'survived'\nreturn kept", { cwd: process.cwd() });

    const error = await manager
      .execForeground(id, "import time\ntime.sleep(30)\nreturn 'late'", { cwd: process.cwd() })
      .then(() => null, (failure) => failure);
    assert.ok(error, "a silent chunk must time out");
    assert.match(error.message, /idle for 1 seconds/);
    assert.match(error.message, /Python traceback:/, "the timeout must carry the Python stack");
    assert.match(error.message, /Stopped at:\n  chunk line \d+: time\.sleep\(30\)/, "the report should name the line that was stuck");

    // Ctrl-C semantics: the interpreter stays interactive with its state intact.
    assert.equal(manager.list().length, 1, "session should survive the interrupt");
    const after = await manager.execForeground(id, "return kept", { cwd: process.cwd() });
    assert.equal(after.output, "survived");
  } finally {
    await manager.disposeAll();
  }
});

test("persistent session: parallel python_exec calls are serialized and both return", { skip: !RUN_REAL }, async () => {
  // pi dispatches several python_exec calls from one assistant message in parallel;
  // racing them used to orphan one promise (the transcript wedged forever).
  const manager = makeManager({}, { executionTimeoutMs: 20_000 });
  try {
    const { id } = await manager.provision({ cwd: process.cwd(), ctx: fakeCtx() });

    const first = manager.execForeground(id, "import time\ntime.sleep(0.4)\nreturn 'first'", { cwd: process.cwd() });
    const queuedNotices: string[] = [];
    const second = manager.execForeground(id, "import time\ntime.sleep(0.4)\nreturn 'second'", {
      cwd: process.cwd(),
      onUpdate: (update: { content?: Array<{ text?: string }> }) => {
        const text = (update.content ?? []).map((block) => block.text ?? "").join("");
        if (text) queuedNotices.push(text);
      },
    });
    const [a, b] = await Promise.all([first, second]);

    assert.equal(a.output, "first");
    assert.equal(b.output, "second");
    assert.ok(
      queuedNotices.some((text) => text.includes("Queued")),
      `a chunk waiting behind another should announce that: ${JSON.stringify(queuedNotices)}`
    );

    // The session stays usable afterwards.
    const third = await manager.execForeground(id, "return 'third'", { cwd: process.cwd() });
    assert.equal(third.output, "third");
  } finally {
    await manager.disposeAll();
  }
});

test("persistent session: aborting interrupts the chunk but keeps the session usable", { skip: !RUN_REAL }, async () => {
  const manager = makeManager({}, { executionTimeoutMs: 60_000 });
  try {
    const { id } = await manager.provision({ cwd: process.cwd(), ctx: fakeCtx() });
    await manager.execForeground(id, "before = 41\nreturn before", { cwd: process.cwd() });

    const controller = new AbortController();
    const pending = manager.execForeground(id, "import time\ntime.sleep(30)\nreturn 'never'", {
      cwd: process.cwd(),
      signal: controller.signal,
    });
    await new Promise((resolve) => setTimeout(resolve, 700));
    controller.abort();

    const error = await pending.then(() => null, (failure) => failure);
    assert.ok(error, "the aborted call must settle");
    assert.match(error.message, /aborted/i);
    assert.match(error.message, /Python traceback:/, "abort must carry the Python stack");
    assert.match(error.message, /Stopped at:\n  chunk line \d+: time\.sleep\(30\)/);

    // The session keeps running with its namespace intact (Ctrl-C semantics).
    assert.equal(manager.list().length, 1, "aborted session should survive");
    const after = await manager.execForeground(id, "return before + 1", { cwd: process.cwd() });
    assert.equal(after.output, "42");
  } finally {
    await manager.disposeAll();
  }
});

test("persistent session: an aborted subagent wait leaves handles usable", { skip: !RUN_REAL }, async () => {
  // The chunk is cancelled at its await, so the fan-out's handles survive in the
  // namespace for a later chunk to await.
  const manager = makeManager({}, { executionTimeoutMs: 30_000 });
  try {
    const { id } = await manager.provision({ cwd: process.cwd(), ctx: fakeCtx() });
    const controller = new AbortController();
    const pending = manager.execForeground(
      id,
      "import asyncio\nhandles = ['sentinel-1', 'sentinel-2']\nawait asyncio.sleep(30)\nreturn handles",
      { cwd: process.cwd(), signal: controller.signal }
    );
    await new Promise((resolve) => setTimeout(resolve, 700));
    controller.abort();
    await pending.then(() => null, () => null);

    const after = await manager.execForeground(id, "return handles", { cwd: process.cwd() });
    assert.match(after.output, /sentinel-1/);
  } finally {
    await manager.disposeAll();
  }
});

test("persistent session: an unserializable result is an error, not a session death", { skip: !RUN_REAL }, async () => {
  // Returning something json cannot encode (a module, a socket) used to kill the
  // interpreter with "session terminated during execution".
  const manager = makeManager({}, { executionTimeoutMs: 20_000 });
  try {
    const { id } = await manager.provision({ cwd: process.cwd(), ctx: fakeCtx() });
    await manager.execForeground(id, "kept = 'still-here'\nreturn kept", { cwd: process.cwd() });

    const result = await manager.execForeground(id, "import time\nreturn {'mod': time, 'nested': {'m': time}}", {
      cwd: process.cwd(),
    });
    assert.match(result.output, /time/, "the module should be rendered via repr");

    assert.equal(manager.list().length, 1, "session must survive an unserializable result");
    const after = await manager.execForeground(id, "return kept", { cwd: process.cwd() });
    assert.equal(after.output, "still-here");
  } finally {
    await manager.disposeAll();
  }
});

test("persistent session: the line arrow catches up when a chunk blocks", { skip: !RUN_REAL }, async () => {
  // A chunk runs its first statements within milliseconds; those progress frames
  // used to be dropped by the rate limiter, leaving the viewer's arrow pinned at
  // line 1 for the whole await that followed.
  const manager = makeManager({}, { executionTimeoutMs: 30_000 });
  const lines: Array<number | undefined> = [];
  try {
    const { id } = await manager.provision({ cwd: process.cwd(), ctx: fakeCtx() });
    const chunk = [
      "import asyncio",
      "a = 1",
      "b = 2",
      "c = a + b",
      "d = c * 2",
      "await asyncio.sleep(1.0)",
      "e = d + 1",
      "return e",
    ].join("\n");
    await manager.execForeground(id, chunk, {
      cwd: process.cwd(),
      onUpdate: (update: { details?: { currentLine?: number } }) => {
        lines.push(update.details?.currentLine);
      },
    });

    const reported = lines.filter((line): line is number => typeof line === "number");
    assert.ok(reported.length > 0, "expected progress updates");
    assert.ok(
      reported.includes(6),
      `the await line must be reported before the chunk resumes, got ${JSON.stringify(reported)}`
    );
    assert.ok(
      reported[reported.length - 1] >= 6,
      `the chunk must not end by reporting an earlier line, got ${JSON.stringify(reported)}`
    );
  } finally {
    await manager.disposeAll();
  }
});

function fakeCtx() {
  return { cwd: process.cwd(), hasUI: false };
}
