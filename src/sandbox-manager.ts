import { randomUUID } from "crypto";
import { execSync, spawn } from "child_process";
import type { SandboxManager } from "./contracts/execution-types";
import type { PtcSettings } from "./contracts/settings";
import { debugLog } from "./utils";
import { existsSync } from "fs";
import { homedir } from "os";
import { join } from "path";

const EXECUTION_TIMEOUT = 270_000;
const DOCKER_WORKSPACE_ROOT = "/workspace";
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
  spawn(code: string, cwd: string): import("child_process").ChildProcess {
    const pythonExe = resolvePythonExecutable();
    return spawn(pythonExe, ["-u", "-c", code], {
      cwd,
      env: { ...process.env },
    });
  }

  getRuntimeWorkspaceRoot(cwd: string): string {
    return cwd;
  }

  cleanup(): Promise<void> {
    return Promise.resolve();
  }
}

class DockerSandbox implements SandboxManager {
  private containerId: string | null = null;
  private lastUsed = 0;
  private readonly sessionId: string;
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
    if (this.containerId && Date.now() - this.lastUsed > EXECUTION_TIMEOUT) {
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
      execSync(`docker stop ${containerId}`, { stdio: "ignore" });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("No such container") || message.includes("is not running")) {
        return;
      }
      throw new Error(`Failed to stop container ${containerId}: ${message}`);
    }
  }

  private ensureContainer(cwd: string): void {
    if (this.containerId && Date.now() - this.lastUsed <= EXECUTION_TIMEOUT) {
      return;
    }

    this.stopContainerNow();

    const containerName = `pi-ptc-${this.sessionId}-${Date.now()}`;
    const output = execSync(
      `docker run -d --rm --network none --name ${containerName} ` +
      `-v "${cwd}:${DOCKER_WORKSPACE_ROOT}:ro" ` +
      `-w ${DOCKER_WORKSPACE_ROOT} ` +
      `--memory 512m --cpus 1.0 ` +
      `python:3.12-slim tail -f /dev/null`,
      { encoding: "utf-8" }
    );
    this.containerId = output.trim();
  }

  spawn(code: string, cwd: string): import("child_process").ChildProcess {
    try {
      this.ensureContainer(cwd);
      this.lastUsed = Date.now();

      return spawn("docker", [
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
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to create/use Docker container: ${message}`);
    }
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
    execSync("docker --version", { stdio: "ignore" });
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
