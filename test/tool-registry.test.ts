const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");

function createStubTool(name, description) {
  return {
    name,
    description,
    parameters: { type: "object", properties: { value: { type: "string" } }, required: ["value"] },
    async execute() {
      return { content: [{ type: "text", text: "ok" }], details: undefined };
    },
  };
}

function loadToolRegistryWithStubbedHost() {
  const originalLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === "@mariozechner/pi-coding-agent") {
      return {
        createReadTool: () => createStubTool("read", "read"),
        createBashTool: () => createStubTool("bash", "bash"),
        createEditTool: () => createStubTool("edit", "edit"),
        createWriteTool: () => createStubTool("write", "write"),
        createGrepTool: () => createStubTool("grep", "grep"),
        createFindTool: () => createStubTool("find", "find"),
        createLsTool: () => createStubTool("ls", "ls"),
      };
    }
    return originalLoad(request, parent, isMain);
  };

  try {
    delete require.cache[require.resolve("../dist/tool-registry.js")];
    return require("../dist/tool-registry.js").ToolRegistry;
  } finally {
    Module._load = originalLoad;
  }
}

function createRegistry(getAllTools = () => []) {
  const ToolRegistry = loadToolRegistryWithStubbedHost();
  const pi = {
    getAllTools,
  };
  return new ToolRegistry(pi);
}

test("ToolRegistry treats an explicit empty ptc.callers allowlist as deny-all", () => {
  const registry = createRegistry();
  registry.upsertTool({
    name: "query_db",
    description: "Query DB",
    parameters: stringParamSchema(),
    ptc: { enabled: true, readOnly: true, callers: [] },
    async execute() {
      return { content: [{ type: "text", text: "ok" }], details: undefined };
    },
  });

  const settings = baseSettings();
  const callable = registry.getCallableTools(process.cwd(), settings);
  assert.ok(!callable.some((tool) => tool.name === "query_db"));

  const routable = registry.getAutoRoutableToolNames(process.cwd(), settings);
  assert.ok(!routable.includes("query_db"));
});

const activityWrappedParams = () => ({
  type: "object",
  properties: {
    value: { type: "string" },
    activity: { type: "string", description: "Activity label" },
  },
  required: ["value"],
});

test("ToolRegistry keeps the clean custom-tool schema over pi's activity-wrapped copy", () => {
  const piTools = [
    {
      name: "query_db",
      description: "Query DB (activity-wrapped)",
      parameters: activityWrappedParams(),
    },
  ];
  const registry = createRegistry(() => piTools);
  registry.upsertTool({
    name: "query_db",
    description: "Query DB",
    parameters: stringParamSchema(),
    ptc: { enabled: true, readOnly: true },
    async execute() {
      return { content: [{ type: "text", text: "ok" }], details: undefined };
    },
  });

  const info = registry.getAllTools(process.cwd()).find((tool) => tool.name === "query_db");
  assert.ok(info);
  // The author's declared schema wins; the leaked `activity` kwarg must not appear.
  assert.equal(info.description, "Query DB");
  assert.ok(!("activity" in info.parameters.properties));
});

test("ToolRegistry only claims extension ownership in removeTool when a tool was removed", () => {
  const registry = createRegistry();

  assert.equal(registry.removeTool("bash"), false);
  // A no-op removeTool must not permanently hide the builtin.
  const names = registry.getAllTools(process.cwd()).map((tool) => tool.name);
  assert.ok(names.includes("bash"));

  registry.upsertTool({
    name: "query_db",
    description: "Query DB",
    parameters: stringParamSchema(),
    async execute() {
      return { content: [{ type: "text", text: "ok" }], details: undefined };
    },
  });
  assert.equal(registry.removeTool("query_db"), true);
  assert.ok(!registry.getAllTools(process.cwd()).some((tool) => tool.name === "query_db"));
});

test("ToolRegistry denylist uses every currently registered PTC tool name", () => {
  const { PTC_TOOL_NAMES } = require("../dist/tool-registry.js");
  assert.deepEqual(PTC_TOOL_NAMES, [
    "provision_kernel",
    "exec_cell",
    "list_kernels",
    "inspect_kernel",
    "provision_dependency",
    "read_cell_output",
  ]);

  const registry = createRegistry();
  for (const name of PTC_TOOL_NAMES) {
    registry.upsertTool({
      name,
      description: name,
      parameters: stringParamSchema(),
      ptc: { enabled: true, readOnly: true, callers: ["direct", "code_execution"] },
      async execute() {
        return { content: [{ type: "text", text: "ok" }], details: undefined };
      },
    });
  }

  const settings = baseSettings({
    allowBash: true,
    callableTools: [...PTC_TOOL_NAMES],
  });
  assert.deepEqual(registry.getCallableTools(process.cwd(), settings), []);
  assert.deepEqual(registry.getAutoRoutableToolNames(process.cwd(), settings), []);
});

function baseSettings(overrides = {}) {
  return {
    executionTimeoutMs: 1000,
    outputPreviewChars: 1000,
    maxSpoolChars: 10_000_000,
    allowBash: false,
    maxParallelToolCalls: 4,
    debugLogging: false,
    autoRoute: true,
    callableTools: undefined,
    blockedTools: undefined,
    ...overrides,
  };
}

function stringParamSchema() {
  return {
    type: "object",
    properties: {
      value: { type: "string" },
    },
    required: ["value"],
  };
}

test("custom tools are callable with no allowlist now that mutation gating is gone", () => {
  const registry = createRegistry();
  registry.upsertTool({
    name: "query_db",
    description: "Query DB",
    parameters: stringParamSchema(),
    ptc: { enabled: true, readOnly: true },
    async execute() {
      return { content: [{ type: "text", text: "ok" }], details: undefined };
    },
  });

  const callable = registry.getCallableTools(process.cwd(), baseSettings());
  const names = callable.map((tool) => tool.name);

  // Builtins (read/edit/find/glob/grep/ls/write) plus the custom tool; mutations are no longer gated.
  assert.deepEqual(names.sort(), ["edit", "find", "glob", "grep", "ls", "query_db", "read", "write"]);
});

test("non-read-only custom tools are callable too (mutations are not gated, yolo mode)", () => {
  const registry = createRegistry();
  registry.upsertTool({
    name: "deploy",
    description: "Deploy",
    parameters: stringParamSchema(),
    ptc: { enabled: true },
    async execute() {
      return { content: [{ type: "text", text: "ok" }], details: undefined };
    },
  });

  const callable = registry.getCallableTools(process.cwd(), baseSettings());
  assert.ok(callable.some((tool) => tool.name === "deploy"));
});

test("ToolRegistry rejects duplicate python helper names", () => {
  const registry = createRegistry();
  const parameters = stringParamSchema();

  for (const name of ["tool_a", "tool_b"]) {
    registry.upsertTool({
      name,
      description: name,
      parameters,
      ptc: { enabled: true, readOnly: true, pythonName: "shared_name" },
      async execute() {
        return { content: [{ type: "text", text: "ok" }], details: undefined };
      },
    });
  }

  assert.throws(
    () => registry.getCallableTools(process.cwd(), baseSettings()),
    /Duplicate Python helper name/
  );
});

test("ToolRegistry respects code_execution-only callers for custom tools", () => {
  const registry = createRegistry();
  registry.upsertTool({
    name: "query_db",
    description: "Query DB",
    parameters: stringParamSchema(),
    ptc: { enabled: true, readOnly: true, callers: ["code_execution"] },
    async execute() {
      return { content: [{ type: "text", text: "ok" }], details: undefined };
    },
  });

  const callable = registry.getCallableTools(
    process.cwd(),
    baseSettings()
  );
  assert.ok(callable.some((tool) => tool.name === "query_db"));

  const routable = registry.getAutoRoutableToolNames(
    process.cwd(),
    baseSettings()
  );
  assert.ok(!routable.includes("query_db"));
});

test("ToolRegistry auto-routing only hides tools callable both directly and from code_execution", () => {
  const registry = createRegistry();
  registry.upsertTool({
    name: "query_db",
    description: "Query DB",
    parameters: stringParamSchema(),
    ptc: { enabled: true, readOnly: true, callers: ["direct", "code_execution"] },
    async execute() {
      return { content: [{ type: "text", text: "ok" }], details: undefined };
    },
  });

  const routable = registry.getAutoRoutableToolNames(
    process.cwd(),
    baseSettings()
  );
  assert.ok(routable.includes("read"));
  assert.ok(routable.includes("query_db"));
  assert.ok(!routable.includes("code_execution"));
});
