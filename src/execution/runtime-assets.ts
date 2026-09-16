import * as fs from "fs";
import * as path from "path";

export interface PythonRuntimeSources {
  rpcCode: string;
  runtimeCode: string;
  sessionCode: string;
}

function resolveRuntimeDir(extensionRoot: string): string {
  const candidates = [
    path.join(extensionRoot, "src", "python-runtime"),
    path.join(extensionRoot, "python-runtime"),
  ];

  for (const runtimeDir of candidates) {
    const rpcPath = path.join(runtimeDir, "rpc.py");
    const runtimePath = path.join(runtimeDir, "runtime.py");
    if (fs.existsSync(rpcPath) && fs.existsSync(runtimePath) && fs.existsSync(path.join(runtimeDir, "session.py"))) {
      return runtimeDir;
    }
  }

  throw new Error(`Expected Python runtime assets in one of: ${candidates.join(", ")}`);
}

export function loadPythonRuntimeSources(extensionRoot: string): PythonRuntimeSources {
  const runtimeDir = resolveRuntimeDir(extensionRoot);
  const rpcPath = path.join(runtimeDir, "rpc.py");
  const runtimePath = path.join(runtimeDir, "runtime.py");
  const sessionPath = path.join(runtimeDir, "session.py");

  return {
    rpcCode: fs.readFileSync(rpcPath, "utf-8"),
    runtimeCode: fs.readFileSync(runtimePath, "utf-8"),
    sessionCode: fs.readFileSync(sessionPath, "utf-8"),
  };
}
