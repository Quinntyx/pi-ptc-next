const test = require("node:test");
const assert = require("node:assert/strict");
const { createSandbox } = require("../dist/sandbox-manager.js");

function readStdout(proc) {
  return new Promise((resolve, reject) => {
    let output = "";
    proc.stdout?.on("data", (chunk) => {
      output += chunk.toString();
    });
    proc.on("error", reject);
    proc.on("exit", (code) => {
      if (code === 0) {
        resolve(output);
      } else {
        reject(new Error(`Process exited with code ${code}`));
      }
    });
  });
}

test("createSandbox allows subprocess execution only with explicit opt-in", async () => {
  const settings = {
    useDocker: false,
    allowUnsandboxedSubprocess: true,
  };
  const sandbox = await createSandbox(settings);
  const cwd = process.cwd();
  const proc = sandbox.spawn("print('hello from sandbox')", cwd);
  const output = await readStdout(proc);
  assert.match(output, /hello from sandbox/);
  assert.equal(sandbox.getRuntimeWorkspaceRoot(cwd), cwd);
  await sandbox.cleanup();
});

test("createSandbox rejects implicit unsandboxed subprocess mode", async () => {
  await assert.rejects(
    createSandbox({ useDocker: false, allowUnsandboxedSubprocess: false }),
    /PTC requires a sandboxed runtime/
  );
});

test("subprocess sandbox cleanup terminates and reaps active Python executions", async () => {
  const sandbox = await createSandbox({ useDocker: false, allowUnsandboxedSubprocess: true });
  const proc = sandbox.spawn("import time; time.sleep(60)", process.cwd());
  const exited = new Promise((resolve) => proc.once("exit", resolve));

  await sandbox.cleanup();
  await exited;

  assert.notEqual(proc.signalCode, null);
  assert.equal(proc.exitCode === null || proc.exitCode === 0, true);
});
