import { spawn, type ChildProcess } from "child_process";
import type { SandboxManager } from "./contracts/execution-types";
import { debugLog } from "./utils";
import { existsSync } from "fs";
import { venvPythonPath } from "./subagents-env";

const PROCESS_TERMINATION_GRACE_MS = 1_000;

function isProcessRunning(proc: ChildProcess): boolean {
  return proc.exitCode === null && proc.signalCode === null;
}

/** Resolve when the process exits (or already has); false if still running after `timeoutMs`. */
function waitForExit(proc: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (!isProcessRunning(proc)) {
    return Promise.resolve(true);
  }

  return new Promise((resolve) => {
    const finish = (exited: boolean) => {
      clearTimeout(timer);
      proc.removeListener("exit", onExit);
      proc.removeListener("error", onError);
      resolve(exited);
    };
    const onExit = () => finish(true);
    const onError = () => finish(true);
    const timer = setTimeout(() => finish(!isProcessRunning(proc)), timeoutMs);
    timer.unref?.();
    proc.once("exit", onExit);
    proc.once("error", onError);
  });
}

/**
 * Interpreter path for PTC kernels: `PTC_PYTHON_EXECUTABLE` wins, else the
 * provisioned PTC venv when it exists, else `python3` from PATH.
 */
export function resolvePythonExecutable(): string {
  if (process.env.PTC_PYTHON_EXECUTABLE) {
    return process.env.PTC_PYTHON_EXECUTABLE;
  }
  const venvPython = venvPythonPath();
  if (existsSync(venvPython)) {
    return venvPython;
  }
  return "python3";
}

/**
 * No-op "sandbox": kernels run as unsandboxed host subprocesses (yolo mode).
 * Tracks spawned children so cleanup() can terminate whole process groups
 * (SIGTERM, then SIGKILL after a 1 s grace period each).
 */
class SubprocessSandbox implements SandboxManager {
  private readonly children = new Set<ChildProcess>();

  resolvePythonExecutable(): string {
    return resolvePythonExecutable();
  }

  spawn(code: string, cwd: string): ChildProcess {
    const pythonExe = resolvePythonExecutable();
    const proc = spawn(pythonExe, ["-u", "-c", code], {
      cwd,
      env: { ...process.env },
      // A separate process group lets cleanup terminate grandchildren spawned
      // by user code instead of leaving them holding RPC pipes open.
      detached: process.platform !== "win32",
    });

    this.children.add(proc);
    const forget = () => this.children.delete(proc);
    proc.once("exit", forget);
    proc.once("error", forget);
    return proc;
  }

  terminate(proc: ChildProcess, signal: NodeJS.Signals): boolean {
    if (!isProcessRunning(proc)) {
      return false;
    }

    if (process.platform !== "win32" && proc.pid) {
      try {
        process.kill(-proc.pid, signal);
        return true;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "ESRCH") {
          return false;
        }
        throw error;
      }
    }

    return proc.kill(signal);
  }

  getRuntimeWorkspaceRoot(cwd: string): string {
    return cwd;
  }

  async cleanup(): Promise<void> {
    const children = [...this.children];
    for (const proc of children) {
      this.terminate(proc, "SIGTERM");
    }
    await Promise.all(children.map((proc) => waitForExit(proc, PROCESS_TERMINATION_GRACE_MS)));

    const survivors = children.filter(isProcessRunning);
    for (const proc of survivors) {
      this.terminate(proc, "SIGKILL");
    }
    await Promise.all(survivors.map((proc) => waitForExit(proc, PROCESS_TERMINATION_GRACE_MS)));
    this.children.clear();
  }
}

/**
 * Create the sandbox manager. Takes no settings: only unsandboxed subprocess
 * mode exists (VM-based checkpointing is planned; see docs/sandboxing.md), so
 * there is nothing to configure.
 */
export function createSandbox(): Promise<SandboxManager> {
  // No sandboxing substrate yet: kernels run as plain host subprocesses ("yolo"
  // mode). VM-based checkpointing is planned; see docs/sandboxing.md.
  debugLog("Using subprocess runtime (no sandboxing substrate yet)");
  return Promise.resolve(new SubprocessSandbox());
}
