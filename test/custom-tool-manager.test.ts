const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { CustomToolManager, loadCustomToolsFromDir } = require("../dist/custom-tool-manager.js");

async function writeTool(toolsDir, filename, source) {
  await fs.writeFile(path.join(toolsDir, filename), `${source}\n`);
}

async function waitFor(condition, timeoutMs = 3000) {
  const startedAt = Date.now();
  while (!condition()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error("Timed out waiting for condition");
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

test("loadCustomToolsFromDir loads ptc metadata from tools directory", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ptc-tools-"));
  const toolsDir = path.join(root, "tools");
  await fs.mkdir(toolsDir, { recursive: true });
  await writeTool(
    toolsDir,
    "echo.js",
    `module.exports = {
      name: 'echo',
      description: 'Echo input',
      parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
      ptc: { enabled: true, readOnly: true, pythonName: 'echo_tool' },
      async execute() { return { content: [{ type: 'text', text: 'ok' }], details: undefined }; }
    };`
  );

  const loaded = await loadCustomToolsFromDir(toolsDir);
  assert.equal(loaded.length, 1);
  assert.equal(loaded[0].tool.name, "echo");
  assert.deepEqual(loaded[0].tool.ptc, {
    enabled: true,
    readOnly: true,
    pythonName: "echo_tool",
  });
});

test("loadCustomToolsFromDir fails loudly for invalid custom tools", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ptc-invalid-tools-"));
  const toolsDir = path.join(root, "tools");
  await fs.mkdir(toolsDir, { recursive: true });
  await writeTool(toolsDir, "broken.js", "module.exports = { name: 'broken' };");

  await assert.rejects(loadCustomToolsFromDir(toolsDir), /Failed to load 1 custom tool/);
});

test("CustomToolManager startup loads valid tools and warns for invalid ones", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ptc-manager-"));
  const toolsDir = path.join(root, "tools");
  await fs.mkdir(toolsDir, { recursive: true });
  await writeTool(
    toolsDir,
    "echo.js",
    `module.exports = {
      name: 'echo',
      description: 'Echo input',
      parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
      async execute() { return { content: [{ type: 'text', text: 'ok' }], details: undefined }; }
    };`
  );
  await writeTool(toolsDir, "broken.js", "module.exports = { name: 'broken' };");

  const registered: string[] = [];
  const activeTools: string[] = [];
  const upserted: string[] = [];
  let changed = 0;
  const warnings: string[] = [];
  const warningHandler = (warning) => {
    warnings.push(warning.message);
  };
  process.on("warning", warningHandler);

  const pi = {
    registerTool(tool) {
      registered.push(tool.name);
    },
    getActiveTools() {
      return [...activeTools];
    },
    setActiveTools(next) {
      activeTools.splice(0, activeTools.length, ...next);
    },
  };

  const toolRegistry = {
    upsertTool(tool) {
      upserted.push(tool.name);
    },
    removeTool() {
      return true;
    },
  };

  const manager = new CustomToolManager(root, pi, toolRegistry, () => {
    changed += 1;
  });

  try {
    await manager.start();
    await new Promise((resolve) => setImmediate(resolve));
  } finally {
    manager.close();
    process.off("warning", warningHandler);
  }

  assert.deepEqual(registered, ["echo"]);
  assert.deepEqual(upserted, ["echo"]);
  assert.deepEqual(activeTools, ["echo"]);
  assert.equal(changed, 1);
  assert.match(warnings.join("\n"), /Skipping invalid custom tool broken\.js during startup/);
});

test("CustomToolManager does not auto-activate code_execution-only tools", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ptc-code-only-"));
  const toolsDir = path.join(root, "tools");
  await fs.mkdir(toolsDir, { recursive: true });
  await writeTool(
    toolsDir,
    "query.js",
    `module.exports = {
      name: 'query_db',
      description: 'Query DB',
      parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
      ptc: { enabled: true, readOnly: true, callers: ['code_execution'] },
      async execute() { return { content: [{ type: 'text', text: 'ok' }], details: undefined }; }
    };`
  );

  const activeTools: string[] = [];
  const pi = {
    registerTool() {},
    getActiveTools() {
      return [...activeTools];
    },
    setActiveTools(next) {
      activeTools.splice(0, activeTools.length, ...next);
    },
  };
  const toolRegistry = {
    upsertTool() {},
    removeTool() {
      return true;
    },
  };

  const manager = new CustomToolManager(root, pi, toolRegistry);
  try {
    await manager.start();
  } finally {
    manager.close();
  }

  assert.deepEqual(activeTools, []);
});

test("CustomToolManager reloads, renames, invalidates, and removes tools end-to-end", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ptc-reload-"));
  const toolsDir = path.join(root, "tools");
  await fs.mkdir(toolsDir, { recursive: true });
  await writeTool(
    toolsDir,
    "echo.js",
    `module.exports = {
      name: 'echo',
      description: 'Echo input',
      parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
      async execute() { return { content: [{ type: 'text', text: 'ok' }], details: undefined }; }
    };`
  );

  const activeTools: string[] = [];
  const registered: string[] = [];
  const removed: string[] = [];
  const warnings: string[] = [];
  const warningHandler = (warning) => {
    warnings.push(warning.message);
  };
  process.on("warning", warningHandler);

  const pi = {
    registerTool(tool) {
      registered.push(tool.name);
    },
    getActiveTools() {
      return [...activeTools];
    },
    setActiveTools(next) {
      activeTools.splice(0, activeTools.length, ...next);
    },
  };

  const toolRegistry = {
    upsertTool() {},
    removeTool(name) {
      removed.push(name);
      return true;
    },
  };

  let changed = 0;
  const manager = new CustomToolManager(root, pi, toolRegistry, () => {
    changed += 1;
  });

  try {
    await manager.start();
    await waitFor(() => activeTools.includes("echo"));

    await writeTool(
      toolsDir,
      "echo.js",
      `module.exports = {
        name: 'echo_v2',
        description: 'Echo input v2',
        parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
        async execute() { return { content: [{ type: 'text', text: 'ok' }], details: undefined }; }
      };`
    );
    await waitFor(() => activeTools.includes("echo_v2") && !activeTools.includes("echo"));

    await writeTool(toolsDir, "echo.js", "module.exports = { name: 'broken' };\n");
    await waitFor(() => !activeTools.includes("echo_v2"));

    await writeTool(
      toolsDir,
      "echo.js",
      `module.exports = {
        name: 'echo_final',
        description: 'Echo input final',
        parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
        async execute() { return { content: [{ type: 'text', text: 'ok' }], details: undefined }; }
      };`
    );
    await waitFor(() => activeTools.includes("echo_final"));

    await fs.unlink(path.join(toolsDir, "echo.js"));
    await waitFor(() => !activeTools.includes("echo_final"));
  } finally {
    manager.close();
    process.off("warning", warningHandler);
  }

  assert.ok(registered.includes("echo"));
  assert.ok(registered.includes("echo_v2"));
  assert.ok(registered.includes("echo_final"));
  assert.ok(removed.includes("echo"));
  assert.ok(removed.includes("echo_v2"));
  assert.ok(removed.includes("echo_final"));
  assert.ok(changed >= 4);
  assert.match(warnings.join("\n"), /Custom tool reload failed for echo\.js/);
});

test("CustomToolManager hot-reloads export default (ESM) tools", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ptc-esm-reload-"));
  const toolsDir = path.join(root, "tools");
  await fs.mkdir(toolsDir, { recursive: true });
  await writeTool(
    toolsDir,
    "esm_echo.js",
    `export default {
      name: 'esm_echo',
      description: 'ESM echo',
      parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
      async execute() { return { content: [{ type: 'text', text: 'ok' }], details: undefined }; }
    };`
  );

  const activeTools = [];
  const removed = [];
  const warnings = [];
  const warningHandler = (warning) => {
    warnings.push(warning.message);
  };
  process.on("warning", warningHandler);

  const pi = {
    registerTool() {},
    getActiveTools() {
      return [...activeTools];
    },
    setActiveTools(next) {
      activeTools.splice(0, activeTools.length, ...next);
    },
  };
  const toolRegistry = {
    upsertTool() {},
    removeTool(name) {
      removed.push(name);
      return true;
    },
  };

  let changed = 0;
  const manager = new CustomToolManager(root, pi, toolRegistry, () => {
    changed += 1;
  });

  try {
    await manager.start();
    await waitFor(() => activeTools.includes("esm_echo"));

    // Rewrite as ESM with a new name; without ESM cache-busting the stale
    // module would be re-registered and esm_echo_v2 would never appear (H3).
    await writeTool(
      toolsDir,
      "esm_echo.js",
      `export default {
        name: 'esm_echo_v2',
        description: 'ESM echo v2',
        parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
        async execute() { return { content: [{ type: 'text', text: 'ok' }], details: undefined }; }
      };`
    );
    await waitFor(() => activeTools.includes("esm_echo_v2") && !activeTools.includes("esm_echo"));
    assert.ok(removed.includes("esm_echo"));
    assert.ok(changed >= 2);
  } finally {
    manager.close();
    process.off("warning", warningHandler);
  }
});

test("CustomToolManager watcher survives fs.watch error events and re-watches", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ptc-watch-error-"));
  const toolsDir = path.join(root, "tools");
  await fs.mkdir(toolsDir, { recursive: true });
  await writeTool(
    toolsDir,
    "echo.js",
    `module.exports = {
      name: 'echo',
      description: 'Echo input',
      parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
      async execute() { return { content: [{ type: 'text', text: 'ok' }], details: undefined }; }
    };`
  );

  const activeTools = [];
  const warnings = [];
  const warningHandler = (warning) => {
    warnings.push(warning.message);
  };
  process.on("warning", warningHandler);

  const pi = {
    registerTool() {},
    getActiveTools() {
      return [...activeTools];
    },
    setActiveTools(next) {
      activeTools.splice(0, activeTools.length, ...next);
    },
  };
  const toolRegistry = {
    upsertTool() {},
    removeTool() {
      return true;
    },
  };

  const manager = new CustomToolManager(root, pi, toolRegistry);
  try {
    await manager.start();
    const originalWatcher = manager.watcher;
    assert.ok(originalWatcher);

    // Without an 'error' listener this throws ERR_UNHANDLED_ERROR (L1).
    originalWatcher.emit("error", new Error("simulated watch failure"));

    // The manager logs and schedules a re-watch.
    await waitFor(() => manager.watcher && manager.watcher !== originalWatcher, 5000);

    // Watching still works after the error.
    await writeTool(
      toolsDir,
      "echo.js",
      `module.exports = {
        name: 'echo_rewatched',
        description: 'Echo input rewatched',
        parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
        async execute() { return { content: [{ type: 'text', text: 'ok' }], details: undefined }; }
      };`
    );
    await waitFor(() => activeTools.includes("echo_rewatched"));
    assert.match(warnings.join("\n"), /Custom tools watcher error/);
  } finally {
    manager.close();
    process.off("warning", warningHandler);
  }
});

test("CustomToolManager serializes overlapping reconciles for the same file", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ptc-serialized-"));
  const toolsDir = path.join(root, "tools");
  await fs.mkdir(toolsDir, { recursive: true });
  await writeTool(
    toolsDir,
    "echo.js",
    `export default {
      name: 'echo_initial',
      description: 'Initial',
      parameters: { type: 'object', properties: {} },
      async execute() { return { content: [{ type: 'text', text: 'initial' }] }; }
    };`
  );

  const activeTools = [];
  const pi = {
    registerTool() {},
    getActiveTools() {
      return [...activeTools];
    },
    setActiveTools(next) {
      activeTools.splice(0, activeTools.length, ...next);
    },
  };
  const toolRegistry = {
    upsertTool() {},
    removeTool() {
      return true;
    },
  };

  const manager = new CustomToolManager(root, pi, toolRegistry);
  try {
    await manager.start();
    manager.watcher.close();
    manager.watcher = null;

    await writeTool(
      toolsDir,
      "echo.js",
      `await new Promise((resolve) => setTimeout(resolve, 250));
      export default {
        name: 'echo_slow',
        description: 'Slow old event',
        parameters: { type: 'object', properties: {} },
        async execute() { return { content: [{ type: 'text', text: 'slow' }] }; }
      };`
    );
    manager.enqueueReconcile("echo.js");
    await new Promise((resolve) => setTimeout(resolve, 30));

    await writeTool(
      toolsDir,
      "echo.js",
      `export default {
        name: 'echo_latest',
        description: 'Latest event',
        parameters: { type: 'object', properties: {} },
        async execute() { return { content: [{ type: 'text', text: 'latest' }] }; }
      };`
    );
    manager.enqueueReconcile("echo.js");

    await waitFor(() => activeTools.includes("echo_latest"));
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.deepEqual(activeTools, ["echo_latest"]);
  } finally {
    manager.close();
  }
});

test("CustomToolManager drops an in-flight reconcile after close", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ptc-inflight-close-"));
  const toolsDir = path.join(root, "tools");
  await fs.mkdir(toolsDir, { recursive: true });
  await writeTool(
    toolsDir,
    "echo.js",
    `export default {
      name: 'echo_initial',
      description: 'Initial',
      parameters: { type: 'object', properties: {} },
      async execute() { return { content: [{ type: 'text', text: 'initial' }] }; }
    };`
  );

  const activeTools = [];
  const registered = [];
  const pi = {
    registerTool(tool) {
      registered.push(tool.name);
    },
    getActiveTools() {
      return [...activeTools];
    },
    setActiveTools(next) {
      activeTools.splice(0, activeTools.length, ...next);
    },
  };
  const toolRegistry = {
    upsertTool() {},
    removeTool() {
      return true;
    },
  };

  const manager = new CustomToolManager(root, pi, toolRegistry);
  await manager.start();
  manager.watcher.close();
  manager.watcher = null;

  await writeTool(
    toolsDir,
    "echo.js",
    `await new Promise((resolve) => setTimeout(resolve, 250));
    export default {
      name: 'echo_after_close',
      description: 'Must not register',
      parameters: { type: 'object', properties: {} },
      async execute() { return { content: [{ type: 'text', text: 'late' }] }; }
    };`
  );
  manager.enqueueReconcile("echo.js");
  await new Promise((resolve) => setTimeout(resolve, 30));
  manager.close();
  await new Promise((resolve) => setTimeout(resolve, 350));

  assert.deepEqual(registered, ["echo_initial"]);
  assert.deepEqual(activeTools, ["echo_initial"]);
});

test("CustomToolManager ignores reconciles that land after close", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ptc-closed-"));
  const toolsDir = path.join(root, "tools");
  await fs.mkdir(toolsDir, { recursive: true });
  await writeTool(
    toolsDir,
    "echo.js",
    `module.exports = {
      name: 'echo',
      description: 'Echo input',
      parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
      async execute() { return { content: [{ type: 'text', text: 'ok' }], details: undefined }; }
    };`
  );

  const activeTools = [];
  const pi = {
    registerTool() {},
    getActiveTools() {
      return [...activeTools];
    },
    setActiveTools(next) {
      activeTools.splice(0, activeTools.length, ...next);
    },
  };
  const toolRegistry = {
    upsertTool() {},
    removeTool() {
      return true;
    },
  };

  const manager = new CustomToolManager(root, pi, toolRegistry);
  await manager.start();
  await waitFor(() => activeTools.includes("echo"));

  manager.close();
  await writeTool(
    toolsDir,
    "echo.js",
    `module.exports = {
      name: 'echo_after_close',
      description: 'Echo after close',
      parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
      async execute() { return { content: [{ type: 'text', text: 'ok' }], details: undefined }; }
    };`
  );
  // Outlive the 300ms debounce window plus an import cycle.
  await new Promise((resolve) => setTimeout(resolve, 700));
  assert.deepEqual(activeTools, ["echo"]);
});

test("CustomToolManager rejects custom tools colliding with builtin names", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ptc-builtin-collision-"));
  const toolsDir = path.join(root, "tools");
  await fs.mkdir(toolsDir, { recursive: true });
  await writeTool(
    toolsDir,
    "read.js",
    `module.exports = {
      name: 'read',
      description: 'Fake read',
      parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
      async execute() { return { content: [{ type: 'text', text: 'ok' }], details: undefined }; }
    };`
  );

  const registered = [];
  const activeTools = [];
  const warnings = [];
  const warningHandler = (warning) => {
    warnings.push(warning.message);
  };
  process.on("warning", warningHandler);

  const pi = {
    registerTool(tool) {
      registered.push(tool.name);
    },
    getActiveTools() {
      return [...activeTools];
    },
    setActiveTools(next) {
      activeTools.splice(0, activeTools.length, ...next);
    },
  };
  const toolRegistry = {
    upsertTool() {},
    removeTool() {
      return true;
    },
  };

  const manager = new CustomToolManager(root, pi, toolRegistry);
  try {
    await manager.start();
    await new Promise((resolve) => setImmediate(resolve));
  } finally {
    manager.close();
    process.off("warning", warningHandler);
  }

  assert.deepEqual(registered, []);
  assert.deepEqual(activeTools, []);
  assert.match(warnings.join("\n"), /collides with a reserved builtin\/PTC tool name/);
});

test("CustomToolManager warns and rejects cross-file duplicate tool names", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ptc-duplicate-name-"));
  const toolsDir = path.join(root, "tools");
  await fs.mkdir(toolsDir, { recursive: true });
  for (const filename of ["a_first.js", "b_second.js"]) {
    await writeTool(
      toolsDir,
      filename,
      `module.exports = {
        name: 'dupe',
        description: 'Duplicate tool from ${filename}',
        parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
        async execute() { return { content: [{ type: 'text', text: 'ok' }], details: undefined }; }
      };`
    );
  }

  const registered = [];
  const warnings = [];
  const warningHandler = (warning) => {
    warnings.push(warning.message);
  };
  process.on("warning", warningHandler);

  const pi = {
    registerTool(tool) {
      registered.push(tool.name);
    },
    getActiveTools() {
      return [];
    },
    setActiveTools() {},
  };
  const toolRegistry = {
    upsertTool() {},
    removeTool() {
      return true;
    },
  };

  const manager = new CustomToolManager(root, pi, toolRegistry);
  try {
    await manager.start();
    await new Promise((resolve) => setImmediate(resolve));
  } finally {
    manager.close();
    process.off("warning", warningHandler);
  }

  // The first file wins; the second is treated as a load error.
  assert.deepEqual(registered, ["dupe"]);
  assert.match(warnings.join("\n"), /already provided by a_first\.js; duplicate name rejected/);
});
