import { randomUUID } from "crypto";
import { execFileSync, spawn, type ChildProcess } from "child_process";
import type { SandboxManager } from "./contracts/execution-types";
import type { PtcSettings } from "./contracts/settings";
import { debugLog } from "./utils";
import { existsSync } from "fs";
import { homedir } from "os";
import { join } from "path";

const EXECUTION_TIMEOUT = 270_000;
const PROCESS_TERMINATION_GRACE_MS = 1_000;
const DOCKER_WORKSPACE_ROOT = "/workspace";

function isProcessRunning(proc: ChildProcess): boolean {
  return proc.exitCode === null && proc.signalCode === null;
}

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

function resolvePythonExecutable(): string {
  if (process.env.PTC_PYTHON_EXECUTABLE) {
    return process.env.PTC_PYTHON_EXECUTABLE;
  }
  const venvPython = join(homedir(), ".cache", "pi-ptc", "python-env", "bin", "python");
  if (existsSync(venvPython)) {
    return venvPython;
  }
  return "python3";
}

class SubprocessSandbox implements SandboxManager {
  private readonly children = new Set<ChildProcess>();

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

class DockerSandbox implements SandboxManager {
  private containerId: string | null = null;
  private lastUsed = 0;
  private readonly sessionId: string;
  private readonly activeExecutions = new Set<ChildProcess>();
  private cleanupInterval: NodeJS.Timeout | null = null;

  constructor(sessionId: string) {
    this.sessionId = sessionId;
    this.startCleanupTimer();
  }

  private startCleanupTimer(): void {
    this.cleanupInterval = setInterval(() => {
      try {
        this.cleanupExpired();
      } catch {
        // Best-effort cleanup only.
      }
    }, 60_000);
  }

  private cleanupExpired(): void {
    if (
      this.containerId &&
      this.activeExecutions.size === 0 &&
      Date.now() - this.lastUsed > EXECUTION_TIMEOUT
    ) {
      this.stopContainerNow();
    }
  }

  private stopContainerNow(): void {
    if (!this.containerId) {
      return;
    }

    const containerId = this.containerId;
    this.containerId = null;

    try {
      execFileSync("docker", ["stop", "--time", "1", containerId], { stdio: "ignore" });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("No such container") || message.includes("is not running")) {
        return;
      }
      throw new Error(`Failed to stop container ${containerId}: ${message}`);
    } finally {
      this.activeExecutions.clear();
    }
  }

  private ensureContainer(cwd: string): void {
    if (
      this.containerId &&
      (this.activeExecutions.size > 0 || Date.now() - this.lastUsed <= EXECUTION_TIMEOUT)
    ) {
      return;
    }

    this.stopContainerNow();

    const containerName = `pi-ptc-${this.sessionId}-${Date.now()}`;
    const output = execFileSync(
      "docker",
      [
        "run", "-d", "--rm", "--network", "none",
        "--name", containerName,
        "-v", `${cwd}:${DOCKER_WORKSPACE_ROOT}:ro`,
        "-w", DOCKER_WORKSPACE_ROOT,
        "--memory", "512m", "--cpus", "1.0",
        "python:3.12-slim", "tail", "-f", "/dev/null",
      ],
      { encoding: "utf-8" }
    );
    this.containerId = output.trim();
  }

  spawn(code: string, cwd: string): ChildProcess {
    try {
      this.ensureContainer(cwd);
      this.lastUsed = Date.now();

      const proc = spawn("docker", [
        "exec",
        "-i",
        "-w",
        DOCKER_WORKSPACE_ROOT,
        this.containerId as string,
        "python3",
        "-u",
        "-c",
        code,
      ]);
      this.activeExecutions.add(proc);
      const forget = () => {
        this.activeExecutions.delete(proc);
        this.lastUsed = Date.now();
      };
      proc.once("exit", forget);
      proc.once("error", forget);
      return proc;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to create/use Docker container: ${message}`);
    }
  }

  terminate(proc: ChildProcess, signal: NodeJS.Signals): boolean {
    return isProcessRunning(proc) ? proc.kill(signal) : false;
  }

  getRuntimeWorkspaceRoot(_cwd: string): string {
    return DOCKER_WORKSPACE_ROOT;
  }

  cleanup(): Promise<void> {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
    this.stopContainerNow();
    return Promise.resolve();
  }
}

function isDockerAvailable(): boolean {
  try {
    execFileSync("docker", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

export function createSandbox(settings: PtcSettings): Promise<SandboxManager> {
  if (settings.useDocker) {
    if (!isDockerAvailable()) {
      return Promise.reject(new Error("PTC_USE_DOCKER=true but Docker is not available on this system."));
    }

    debugLog("Using Docker sandbox (PTC_USE_DOCKER=true)");
    return Promise.resolve(new DockerSandbox(randomUUID()));
  }

  if (!settings.allowUnsandboxedSubprocess) {
    return Promise.reject(
      new Error(
        "PTC requires a sandboxed runtime. Set PTC_USE_DOCKER=true or explicitly opt into local subprocess mode with PTC_ALLOW_UNSANDBOXED_SUBPROCESS=true."
      )
    );
  }

  debugLog("Using subprocess sandbox (PTC_ALLOW_UNSANDBOXED_SUBPROCESS=true)");
  return Promise.resolve(new SubprocessSandbox());
}
