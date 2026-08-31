const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { PassThrough } = require("node:stream");
const { PtcPythonError } = require("../dist/execution/execution-errors.js");
const { CodeExecutor } = require("../dist/code-executor.js");

test("CodeExecutor rejects asyncio.run before execution", async () => {
  const sandboxManager = {
    spawn() {
      throw new Error("spawn should not be reached");
    },
    getRuntimeWorkspaceRoot(cwd) {
      return cwd;
    },
    async cleanup() {},
  };
  const toolRegistry = {
    createCallableToolRuntime() {
      throw new Error("tool registry should not be reached");
    },
  };

  const executor = new CodeExecutor(
    sandboxManager,
    toolRegistry,
    {
      executionTimeoutMs: 1000,
      maxOutputChars: 1000,
      allowMutations: false,
      allowBash: false,
      maxParallelToolCalls: 4,
      callableTools: undefined,
      blockedTools: undefined,
    },
    process.cwd()
  );

  await assert.rejects(
    executor.execute("import asyncio\nasyncio.run(main())", {
      cwd: process.cwd(),
      ctx: { cwd: process.cwd() },
    }),
    /Top-level await is already available/
  );
});

test("CodeExecutor passes the current execution context to nested tools", async () => {
  const sandboxManager = {
    spawn() {
      throw new Error("spawn should not be reached");
    },
    getRuntimeWorkspaceRoot(cwd) {
      return cwd;
    },
    async cleanup() {},
  };

  let capturedExecution = null;
  const toolRegistry = {
    createCallableToolRuntime(_cwd, _settings, execution) {
      capturedExecution = execution;
      throw new Error("stop after capturing execution context");
    },
  };

  const executor = new CodeExecutor(
    sandboxManager,
    toolRegistry,
    {
      executionTimeoutMs: 1000,
      maxOutputChars: 1000,
      allowMutations: false,
      allowBash: false,
      maxParallelToolCalls: 4,
      callableTools: undefined,
      blockedTools: undefined,
    },
    process.cwd()
  );

  const currentCtx = { cwd: "/tmp/current", label: "current-context" };
  await assert.rejects(
    executor.execute("return 1", {
      cwd: currentCtx.cwd,
      ctx: currentCtx,
      parentToolCallId: "parent-1",
    }),
    /stop after capturing execution context/
  );

  assert.equal(capturedExecution.ctx, currentCtx);
  assert.equal(capturedExecution.parentToolCallId, "parent-1");
});

test("CodeExecutor preserves typed Python errors", async () => {
  class FakeProcess extends EventEmitter {
    constructor() {
      super();
      this.stdin = new PassThrough();
      this.stdout = new PassThrough();
      this.stderr = new PassThrough();
      this.exitCode = 0;
    }

    kill() {}
  }

  const sandboxManager = {
    spawn() {
      return new FakeProcess();
    },
    getRuntimeWorkspaceRoot(cwd) {
      return cwd;
    },
    async cleanup() {},
  };

  const toolRegistry = {
    createCallableToolRuntime() {
      return {
        tools: [],
        runTool: async () => null,
      };
    },
  };

  const executor = new CodeExecutor(
    sandboxManager,
    toolRegistry,
    {
      executionTimeoutMs: 1000,
      maxOutputChars: 1000,
      allowMutations: false,
      allowBash: false,
      maxParallelToolCalls: 4,
      callableTools: undefined,
      blockedTools: undefined,
    },
    process.cwd()
  );

  const typedError = new PtcPythonError("boom", "traceback details");
  const originalLoad = executor.loadRuntimeFiles;
  const originalBuild = executor.buildCombinedCode;
  executor.loadRuntimeFiles = () => ({ rpcCode: "", runtimeCode: "" });
  executor.buildCombinedCode = () => "";
  const { RpcProtocol } = require("../dist/rpc-protocol.js");
  const originalWait = RpcProtocol.prototype.waitForCompletion;
  RpcProtocol.prototype.waitForCompletion = async function () {
    throw typedError;
  };

  try {
    await assert.rejects(
      executor.execute("return 1", { cwd: process.cwd(), ctx: { cwd: process.cwd() } }),
      (error) => error === typedError
    );
  } finally {
    RpcProtocol.prototype.waitForCompletion = originalWait;
    executor.loadRuntimeFiles = originalLoad;
    executor.buildCombinedCode = originalBuild;
  }
});

test("CodeExecutor runs the core tool-call pipeline through RpcProtocol", async () => {
  class FakeProcess extends EventEmitter {
    constructor() {
      super();
      this.stdin = new PassThrough();
      this.stdout = new PassThrough();
      this.stderr = new PassThrough();
      this.exitCode = null;
    }

    kill() {
      this.exitCode = 0;
      this.emit("exit", 0);
    }
  }

  let runToolArgs = null;
  const sandboxManager = {
    spawn() {
      const proc = new FakeProcess();
      proc.stdin.on("data", () => {
        proc.stdout.write(JSON.stringify({ type: "complete", output: "done" }) + "\n");
      });
      queueMicrotask(() => {
        proc.stdout.write(JSON.stringify({ type: "tool_call", id: "nested-1", tool: "glob", params: { pattern: "**/*.ts" } }) + "\n");
      });
      return proc;
    },
    getRuntimeWorkspaceRoot(cwd) {
      return cwd;
    },
    async cleanup() {},
  };

  const toolRegistry = {
    createCallableToolRuntime() {
      return {
        tools: [
          {
            name: "glob",
            description: "Find files",
            parameters: { type: "object", properties: { pattern: { type: "string" } }, required: ["pattern"] },
            source: "alias",
            isReadOnly: true,
          },
        ],
        runTool: async (...args) => {
          runToolArgs = args;
          return { content: [{ type: "text", text: "a.ts\nb.ts" }], details: undefined };
        },
      };
    },
  };

  const executor = new CodeExecutor(
    sandboxManager,
    toolRegistry,
    {
      executionTimeoutMs: 1000,
      maxOutputChars: 1000,
      allowMutations: false,
      allowBash: false,
      maxParallelToolCalls: 4,
      useDocker: false,
      allowUnsandboxedSubprocess: true,
      debugLogging: false,
      trustedReadOnlyTools: undefined,
      callableTools: undefined,
      blockedTools: undefined,
    },
    process.cwd()
  );

  const result = await executor.execute("files = await glob(pattern='**/*.ts')\nreturn len(files)", {
    cwd: process.cwd(),
    ctx: { cwd: process.cwd() },
  });

  assert.equal(result.output, "done");
  assert.deepEqual(runToolArgs, ["glob", { pattern: "**/*.ts" }, "nested-1"]);
  assert.equal(result.details.nestedToolCalls, 1);
  assert.equal(result.details.nestedResultCount, 1);
});

test("CodeExecutor does not spawn when the caller signal is already aborted", async () => {
  let spawnCalls = 0;
  const sandboxManager = {
    spawn() {
      spawnCalls += 1;
      throw new Error("must not spawn");
    },
    getRuntimeWorkspaceRoot(cwd) { return cwd; },
    async cleanup() {},
  };
  const toolRegistry = {
    createCallableToolRuntime() { throw new Error("must not create runtime"); },
  };
  const controller = new AbortController();
  controller.abort();
  const executor = new CodeExecutor(
    sandboxManager,
    toolRegistry,
    {
      executionTimeoutMs: 1000, maxOutputChars: 1000, allowMutations: false,
      allowBash: false, maxParallelToolCalls: 4, callableTools: undefined, blockedTools: undefined,
    },
    process.cwd()
  );

  await assert.rejects(
    executor.execute("return 1", { cwd: process.cwd(), ctx: { cwd: process.cwd() }, signal: controller.signal }),
    /aborted before/
  );
  assert.equal(spawnCalls, 0);
});

test("CodeExecutor aborts the nested-tool signal on execution timeout", async () => {
  class HangingProcess extends EventEmitter {
    constructor() {
      super();
      this.stdin = new PassThrough();
      this.stdout = new PassThrough();
      this.stderr = new PassThrough();
      this.exitCode = null;
      this.signalCode = null;
    }
    kill(signal) {
      this.signalCode = signal;
      this.emit("exit", null, signal);
      return true;
    }
  }

  let nestedSignal;
  const proc = new HangingProcess();
  const sandboxManager = {
    spawn() { return proc; },
    getRuntimeWorkspaceRoot(cwd) { return cwd; },
    async cleanup() {},
  };
  const toolRegistry = {
    createCallableToolRuntime(_cwd, _settings, execution) {
      nestedSignal = execution.signal;
      return { tools: [], runTool: async () => null };
    },
  };
  const executor = new CodeExecutor(
    sandboxManager,
    toolRegistry,
    {
      executionTimeoutMs: 10, maxOutputChars: 1000, allowMutations: false,
      allowBash: false, maxParallelToolCalls: 4, callableTools: undefined, blockedTools: undefined,
    },
    process.cwd()
  );

  await assert.rejects(
    executor.execute("while True: pass", { cwd: process.cwd(), ctx: { cwd: process.cwd() } }),
    /timed out/
  );
  assert.equal(nestedSignal.aborted, true);
  assert.equal(proc.signalCode, "SIGTERM");
});
