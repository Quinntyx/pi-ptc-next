const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { loadPythonRuntimeSources } = require("../dist/execution/runtime-assets.js");

function withTempExtensionRoot(callback) {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-ptc-runtime-assets-"));

  try {
    return callback(tempRoot);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

test("loadPythonRuntimeSources reads all runtime files from the extension root", () => {
  withTempExtensionRoot((extensionRoot) => {
    const runtimeDir = path.join(extensionRoot, "src", "python-runtime");
    fs.mkdirSync(runtimeDir, { recursive: true });
    fs.writeFileSync(path.join(runtimeDir, "rpc.py"), "RPC = True\n", "utf-8");
    fs.writeFileSync(path.join(runtimeDir, "runtime.py"), "RUNTIME = True\n", "utf-8");
    fs.writeFileSync(path.join(runtimeDir, "session.py"), "SESSION = True\n", "utf-8");

    const sources = loadPythonRuntimeSources(extensionRoot);
    assert.equal(sources.rpcCode, "RPC = True\n");
    assert.equal(sources.runtimeCode, "RUNTIME = True\n");
    assert.equal(sources.sessionCode, "SESSION = True\n");
  });
});

test("loadPythonRuntimeSources also supports src-root entrypoints", () => {
  withTempExtensionRoot((extensionRoot) => {
    const srcRoot = path.join(extensionRoot, "src");
    const runtimeDir = path.join(srcRoot, "python-runtime");
    fs.mkdirSync(runtimeDir, { recursive: true });
    fs.writeFileSync(path.join(runtimeDir, "rpc.py"), "RPC = True\n", "utf-8");
    fs.writeFileSync(path.join(runtimeDir, "runtime.py"), "RUNTIME = True\n", "utf-8");
    fs.writeFileSync(path.join(runtimeDir, "session.py"), "SESSION = True\n", "utf-8");

    const sources = loadPythonRuntimeSources(srcRoot);
    assert.equal(sources.rpcCode, "RPC = True\n");
    assert.equal(sources.runtimeCode, "RUNTIME = True\n");
    assert.equal(sources.sessionCode, "SESSION = True\n");
  });
});

test("loadPythonRuntimeSources rejects missing runtime assets", () => {
  withTempExtensionRoot((extensionRoot) => {
    const runtimeDir = path.join(extensionRoot, "src", "python-runtime");
    fs.mkdirSync(runtimeDir, { recursive: true });
    fs.writeFileSync(path.join(runtimeDir, "rpc.py"), "RPC = True\n", "utf-8");

    assert.throws(
      () => loadPythonRuntimeSources(extensionRoot),
      /Expected Python runtime assets/
    );
  });
});
