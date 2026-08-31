const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { PassThrough } = require("node:stream");
const { RpcProtocol } = require("../dist/rpc-protocol.js");

class FakeProcess extends EventEmitter {
  constructor() {
    super();
    this.stdin = new PassThrough();
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
    this.exitCode = null;
    this.signalCode = null;
    this.killSignals = [];
  }

  kill(signal = "SIGTERM") {
    this.killSignals.push(signal);
    this.signalCode = signal;
    this.emit("exit", null, signal);
    return true;
  }
}

test("RpcProtocol normalizes nested tool results and reports details", async () => {
  const proc = new FakeProcess();
  let sent = "";
  const sentOnce = new Promise((resolve) => {
    proc.stdin.on("data", (chunk) => {
      sent += chunk.toString();
      resolve(undefined);
    });
  });

  const protocol = new RpcProtocol(
    proc,
    async () => ({ content: [{ type: "text", text: "a.ts\nb.ts" }], details: undefined }),
    "result = await find(pattern='**/*.ts')"
  );

  proc.stdout.write(JSON.stringify({ type: "tool_call", id: "1", tool: "find", params: { pattern: "**/*.ts" } }) + "\n");
  await sentOnce;
  assert.match(sent, /"type":"tool_result"/);
  assert.match(sent, /"value":\["a.ts","b.ts"\]/);

  proc.stdout.write(JSON.stringify({ type: "complete", output: "done" }) + "\n");
  const result = await protocol.waitForCompletion();
  assert.equal(result.output, "done");
  assert.equal(result.details.nestedToolCalls, 1);
  assert.equal(result.details.nestedResultCount, 1);
});

test("RpcProtocol preserves framed stdout before the final result", async () => {
  const proc = new FakeProcess();
  const protocol = new RpcProtocol(proc, async () => null, "print('hello')");

  proc.stdout.write(JSON.stringify({ type: "stdout", text: "hello\n" }) + "\n");
  proc.stdout.write(JSON.stringify({ type: "complete", output: "done" }) + "\n");

  const result = await protocol.waitForCompletion();
  assert.equal(result.output, "hello\ndone");
});

test("RpcProtocol rejects clean exits without a terminal protocol message", async () => {
  const proc = new FakeProcess();
  const protocol = new RpcProtocol(proc, async () => null, "print('hello')");

  proc.emit("exit", 0);
  proc.stdout.end();

  await assert.rejects(protocol.waitForCompletion(), /before completing the RPC protocol/);
});

test("RpcProtocol accepts a buffered complete frame that arrives after exit", async () => {
  const proc = new FakeProcess();
  const protocol = new RpcProtocol(proc, async () => null, "print('hello')");

  proc.emit("exit", 0);
  proc.stdout.write(JSON.stringify({ type: "complete", output: "done" }) + "\n");
  proc.stdout.end();

  const result = await protocol.waitForCompletion();
  assert.equal(result.output, "done");
});

test("RpcProtocol rejects invalid JSON frames as protocol errors", async () => {
  const proc = new FakeProcess();
  const protocol = new RpcProtocol(proc, async () => null, "print('hello')");

  proc.stdout.write("not-json\n");

  await assert.rejects(protocol.waitForCompletion(), /Invalid RPC message/);
});

test("RpcProtocol rejects unknown frame types", async () => {
  const proc = new FakeProcess();
  const protocol = new RpcProtocol(proc, async () => null, "print('hello')");

  proc.stdout.write(JSON.stringify({ type: "mystery" }) + "\n");

  await assert.rejects(protocol.waitForCompletion(), /Unknown RPC frame type/);
});

test("RpcProtocol rejects malformed tool_call frames", async () => {
  const proc = new FakeProcess();
  const protocol = new RpcProtocol(proc, async () => null, "print('hello')");

  proc.stdout.write(JSON.stringify({ type: "tool_call", id: 1, tool: "find", params: [] }) + "\n");

  await assert.rejects(protocol.waitForCompletion(), /Invalid tool_call frame/);
});

test("RpcProtocol terminates Python after a protocol parse failure", async () => {
  const proc = new FakeProcess();
  const protocol = new RpcProtocol(proc, async () => null, "while True: pass");

  proc.stdout.write("not-json\n");

  await assert.rejects(protocol.waitForCompletion(), /Invalid RPC message/);
  assert.deepEqual(proc.killSignals, ["SIGTERM"]);
  await protocol.dispose();
});

test("RpcProtocol timeout settles once and terminates Python", async () => {
  const proc = new FakeProcess();
  const failures = [];
  const protocol = new RpcProtocol(
    proc,
    async () => null,
    "while True: pass",
    undefined,
    undefined,
    { onFailure: (error) => failures.push(error) }
  );

  await assert.rejects(protocol.waitForCompletion(10), /timed out after 0 seconds/);
  assert.deepEqual(proc.killSignals, ["SIGTERM"]);
  assert.equal(failures.length, 1);
  await protocol.dispose();
});

test("RpcProtocol bounds streamed stdout before completion", async () => {
  const proc = new FakeProcess();
  const protocol = new RpcProtocol(
    proc,
    async () => null,
    "print('lots')",
    undefined,
    undefined,
    { maxOutputChars: 5 }
  );

  proc.stdout.write(JSON.stringify({ type: "stdout", text: "abcdefgh" }) + "\n");
  proc.stdout.write(JSON.stringify({ type: "complete", output: "xyz" }) + "\n");

  const result = await protocol.waitForCompletion();
  assert.equal(result.output, "abcde\n\n[Output truncated - showing first 5 characters of 11]");
});

test("RpcProtocol rejects an exited process even when inherited stdout stays open", async () => {
  const proc = new FakeProcess();
  const protocol = new RpcProtocol(proc, async () => null, "return 1");

  proc.emit("exit", 0); // deliberately leave proc.stdout open like an inherited fd

  await assert.rejects(protocol.waitForCompletion(), /before completing the RPC protocol/);
  await protocol.dispose();
});

test("RpcProtocol dispose waits for a successful child to exit", async () => {
  const proc = new FakeProcess();
  proc.stdin.once("finish", () => {
    proc.exitCode = 0;
    proc.emit("exit", 0);
  });
  const protocol = new RpcProtocol(proc, async () => null, "return 1");

  proc.stdout.write(JSON.stringify({ type: "complete", output: "done" }) + "\n");
  await protocol.waitForCompletion();
  await protocol.dispose();

  assert.equal(proc.exitCode, 0);
  assert.deepEqual(proc.killSignals, []);
});
