const test = require("node:test");
const assert = require("node:assert/strict");

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

    async execBackground() {
      return { execId: "bg-1" };
    }

    async waitForExec() {
      return this.execute("s1", "wait_for");
    }

    async toScript() {
      return { path: "/tmp/script.py", cells: 2, wrappedAsync: false };
    }

    pendingBackground() {
      return [];
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
      return [{ name: "python_exec" }];
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
        return [];
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
    assert.deepEqual(toolNames, ["provision_python_session", "python_exec", "python_session_to_script"]);
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

test("ptc extension auto-routes repo-wide analysis prompts toward python_exec", async () => {
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

    const routeResult = eventHandlers.get("before_agent_start")({
      prompt: "Analyze the first 8 test/**/*.test.ts files and return compact JSON only",
      systemPrompt: "base prompt",
    });

    assert.deepEqual(activeTools, ["python_exec", "provision_python_session"]);
    assert.match(routeResult.systemPrompt, /strong fit for python_exec/);
    assert.match(routeResult.systemPrompt, /provision_python_session/);

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

    const pythonExecTool = registered.find((tool) => tool.name === "python_exec");
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

    const pythonExecTool = registered.find((tool) => tool.name === "python_exec");
    assert.ok(pythonExecTool);

    eventHandlers.get("before_agent_start")({ prompt: "Analyze files", systemPrompt: "base prompt" });
    const firstResult = await pythonExecTool.execute("call-1", { session_id: "s1", code: "return 1" }, undefined, undefined, { cwd: process.cwd() });
    const secondResult = await pythonExecTool.execute("call-2", { session_id: "s1", code: "return 2" }, undefined, undefined, { cwd: process.cwd() });

    const firstTelemetry = firstResult.details.telemetry;
    assert.deepEqual(firstTelemetry, {
      autoRouted: false,
      firstToolPath: "code_execution",
      codeExecutionAttempts: 1,
      recoveryAttemptCount: 0,
      terminalState: "success",
    });
    assert.deepEqual(secondResult.details.telemetry, {
      autoRouted: false,
      firstToolPath: "code_execution",
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

    const pythonExecTool = registered.find((tool) => tool.name === "python_exec");
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

    const pythonExecTool = registered.find((tool) => tool.name === "python_exec");
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

test("ptc extension includes recovery telemetry in successful python_exec details after one bounded retry", async () => {
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

    const pythonExecTool = registered.find((tool) => tool.name === "python_exec");
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

test("ptc extension includes first-path telemetry in non-recovered python_exec details", async () => {
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

    const pythonExecTool = registered.find((tool) => tool.name === "python_exec");
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

    const pythonExecTool = registered.find((tool) => tool.name === "python_exec");
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
