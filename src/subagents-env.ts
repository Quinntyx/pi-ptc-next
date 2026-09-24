/**
 * pi_subagents runtime provisioning.
 *
 * pi installs this package as a git/npm clone and runs `npm install` — neither
 * touches Python. The `pi_subagents` module lives in its own repo (private
 * forge by default) and must be importable from the PTC interpreter's venv.
 *
 * This module provisions that venv and the library:
 *
 *   1. venv: create ~/.cache/pi-ptc/python-env when missing (uv when
 *      available, else `python3 -m venv`) — resolvePythonExecutable()
 *      prefers this venv for all python_exec sessions.
 *   2. source: PTC_SUBAGENTS_SOURCE (dev checkout, e.g. ~/docs/src/pi-subagents)
 *      when present, else a managed git clone at ~/.cache/pi-ptc/pi-subagents
 *      (cloned from PTC_SUBAGENTS_REPO_URL, fetched + reset on each sync).
 *   3. editable install of pi_subagents into the venv when first set up, when
 *      the editable path changes, or when pyproject.toml changed since the
 *      last sync; pure code updates only need the git pull/editable path.
 *
 * Sync trigger: the stamp file lives INSIDE this package's clone
 * (<extensionRoot>/.ptc-subagents-sync.json) — `pi update` resets and cleans
 * package clones, wiping the stamp, so updating extensions re-syncs
 * pi_subagents. Between updates the stamp throttles syncs to once per
 * PTC_SUBAGENTS_SYNC_INTERVAL_HOURS (default 24). Runs are serialized by a
 * lock file; failures are stamped too so a broken repo doesn't retry every
 * session start.
 */
import { execFile, execFileSync, spawn } from "child_process";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "fs";
import { dirname } from "path";
import { homedir } from "os";
import { createHash } from "crypto";
import { join } from "path";
import { debugLog, logWarning } from "./utils";

const DEFAULT_REPO_URL = "https://git.quinntyx.dev/quinntyx/pi-subagents";
const DEV_SOURCE_DEFAULT = join(homedir(), "docs", "src", "pi-subagents");
const LOCK_MAX_AGE_MS = 5 * 60 * 1000;

export interface SubagentsEnvOptions {
  /** Cache root holding python-env/ and the managed pi-subagents clone. */
  cacheRoot?: string;
  /** This package's clone dir — hosts the sync stamp; wiped by `pi update`. */
  extensionRoot?: string;
  repoUrl?: string;
  /** Dev checkout to install editable instead of the managed clone. */
  devSource?: string;
  syncIntervalMs?: number;
  now?: () => number;
}

export interface SubagentsEnvResult {
  status: "ok" | "skipped" | "failed";
  reason?: string;
  venvPython?: string;
  editablePath?: string;
  managed?: boolean;
  commit?: string;
}

interface Stamp {
  syncedAt: number;
  editablePath?: string;
  pyprojectHash?: string;
  ok?: boolean;
}

interface Paths {
  cacheRoot: string;
  venvDir: string;
  venvPython: string;
  cloneDir: string;
  lockFile: string;
  logFile: string;
  stampFile: string;
}

function resolvePaths(options: SubagentsEnvOptions): Paths {
  const cacheRoot = options.cacheRoot ?? join(homedir(), ".cache", "pi-ptc");
  const extensionRoot = options.extensionRoot ?? cacheRoot;
  return {
    cacheRoot,
    venvDir: join(cacheRoot, "python-env"),
    venvPython: join(cacheRoot, "python-env", "bin", "python"),
    cloneDir: join(cacheRoot, "pi-subagents"),
    lockFile: join(cacheRoot, "subagents-sync.lock"),
    logFile: join(cacheRoot, "subagents-sync.log"),
    stampFile: join(extensionRoot, ".ptc-subagents-sync.json"),
  };
}

/** Pure: where the pip package lives inside a pi-subagents checkout. */
export function resolvePackageDir(checkout: string): string {
  return existsSync(join(checkout, "main", "pyproject.toml")) ? join(checkout, "main") : checkout;
}

/** Pure: which source dir to install editable from (dev checkout wins). */
export function resolveSourceDir(
  devSource: string | undefined,
): string | undefined {
  const root = devSource ?? DEV_SOURCE_DEFAULT;
  if (existsSync(join(root, "main", "pyproject.toml"))) return join(root, "main");
  if (existsSync(join(root, "pyproject.toml"))) return root;
  return undefined;
}

/** Pure: stamps older than the interval (or missing) trigger a sync. */
export function isStampStale(
  stamp: Stamp | undefined,
  syncIntervalMs: number,
  now: number,
): boolean {
  if (!stamp || typeof stamp.syncedAt !== "number" || !Number.isFinite(stamp.syncedAt)) {
    return true;
  }
  return now - stamp.syncedAt > syncIntervalMs;
}

/** Where resolvePythonExecutable() should look (mirror of sandbox-manager). */
export function ptcVenvPythonPath(): string {
  return join(homedir(), ".cache", "pi-ptc", "python-env", "bin", "python");
}

// --- process helpers ------------------------------------------------------------

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

function run(cmd: string, args: string[], timeoutMs = 180_000): Promise<RunResult> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs, encoding: "utf8" }, (error, stdout, stderr) => {
      const code =
        error && typeof (error as { code?: number }).code === "number"
          ? (error as { code: number }).code
          : error
            ? 1
            : 0;
      resolve({ code, stdout: stdout ?? "", stderr: stderr ?? "" });
    });
  });
}

/** Run a command with stdout/stderr appended to the sync log; await exit. */
function runLogged(logFile: string, cmd: string, args: string[]): Promise<boolean> {
  return new Promise((resolve) => {
    const log = openSync(logFile, "a");
    const child = spawn(cmd, args, { stdio: ["ignore", log, log] });
    closeSync(log);
    child.on("exit", (code) => resolve(code === 0));
    child.on("error", () => resolve(false));
  });
}

function hasCommand(cmd: string): boolean {
  try {
    execFileSync(process.platform === "win32" ? "where" : "which", [cmd], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function sha256File(path: string): string | undefined {
  try {
    return createHash("sha256").update(readFileSync(path)).digest("hex").slice(0, 16);
  } catch {
    return undefined;
  }
}

function gitHead(pkgDir: string): string | undefined {
  try {
    return execFileSync("git", ["-C", pkgDir, "rev-parse", "--short", "HEAD"], {
      encoding: "utf8",
    }).trim();
  } catch {
    return undefined;
  }
}

function syncIntervalFromEnv(): number {
  const hours = Number(process.env.PTC_SUBAGENTS_SYNC_INTERVAL_HOURS ?? "24");
  return Number.isFinite(hours) && hours >= 0 ? hours * 3_600_000 : 24 * 3_600_000;
}

// --- sync -------------------------------------------------------------------------

export async function ensureSubagentsEnv(
  options: SubagentsEnvOptions = {},
): Promise<SubagentsEnvResult> {
  const paths = resolvePaths(options);
  mkdirSync(paths.cacheRoot, { recursive: true });

  // Serialize across concurrent pi processes; a stale lock (>5 min) is broken.
  try {
    if (existsSync(paths.lockFile)) {
      const age = Date.now() - Number(readFileSync(paths.lockFile, "utf8").trim() || 0);
      if (age >= 0 && age < LOCK_MAX_AGE_MS) {
        return { status: "skipped", reason: "another sync holds the lock" };
      }
      rmSync(paths.lockFile, { force: true });
    }
    writeFileSync(paths.lockFile, String(Date.now()));
  } catch {
    return { status: "skipped", reason: "lock unavailable" };
  }

  try {
    return await sync(options, paths);
  } finally {
    rmSync(paths.lockFile, { force: true });
  }
}

async function sync(options: SubagentsEnvOptions, paths: Paths): Promise<SubagentsEnvResult> {
  const finish = (result: SubagentsEnvResult, extra: Partial<Stamp> = {}): SubagentsEnvResult => {
    try {
      mkdirSync(dirname(paths.stampFile), { recursive: true });
      const stamp: Stamp = { syncedAt: options.now?.() ?? Date.now(), ok: result.status === "ok", ...extra };
      writeFileSync(paths.stampFile, JSON.stringify(stamp, null, 2));
    } catch {
      // the stamp is an optimization; never fail the sync over it
    }
    return result;
  };

  let stamp: Stamp | undefined;
  try {
    stamp = JSON.parse(readFileSync(paths.stampFile, "utf8")) as Stamp;
  } catch {
    stamp = undefined;
  }
  const intervalMs = syncIntervalFromEnv();
  if (!isStampStale(stamp, intervalMs, options.now?.() ?? Date.now())) {
    return { status: "skipped", reason: "recently synced", venvPython: paths.venvPython };
  }

  // 1. venv
  if (!existsSync(paths.venvPython)) {
    const ok = await createVenv(paths);
    if (!ok) {
      return finish({ status: "failed", reason: "could not create the PTC venv" });
    }
  }

  // 2. resolve the source dir (dev checkout wins, else managed clone)
  const devSource = options.devSource ?? process.env.PTC_SUBAGENTS_SOURCE ?? DEV_SOURCE_DEFAULT;
  let pkgDir = resolveSourceDir(devSource);
  let managed = false;
  if (!pkgDir) {
    managed = true;
    if (!existsSync(join(paths.cloneDir, ".git"))) {
      const cloned = await runLogged(paths.logFile, "git", [
        "clone",
        options.repoUrl ?? process.env.PTC_SUBAGENTS_REPO_URL ?? DEFAULT_REPO_URL,
        paths.cloneDir,
      ]);
      if (!cloned) {
        return finish({ status: "failed", reason: `git clone of the pi-subagents repo failed` });
      }
    } else if (!(await updateManagedClone(paths))) {
      // keep working with the existing checkout; the editable install is fine
      logWarning("pi-subagents env: managed clone update failed, using the existing checkout");
    }
    pkgDir = resolvePackageDir(paths.cloneDir);
  }

  // 3. editable install when needed
  const pyprojectHash = sha256File(join(pkgDir ?? "", "pyproject.toml"));
  const needsInstall =
    !stamp?.editablePath ||
    stamp.editablePath !== pkgDir ||
    !stamp.pyprojectHash ||
    stamp.pyprojectHash !== pyprojectHash;
  if (needsInstall) {
    const ok = await pipEditableInstall(paths, pkgDir as string);
    if (!ok) {
      return finish({ status: "failed", reason: `pip editable install of ${pkgDir} failed` });
    }
  }

  // 4. verify the import actually resolves
  const verify = await run(paths.venvPython, ["-c", "import pi_subagents"]);
  if (verify.code !== 0) {
    return finish(
      { status: "failed", reason: `import pi_subagents failed: ${verify.stderr.slice(-400)}` },
      { pyprojectHash, editablePath: pkgDir },
    );
  }

  return finish(
    { status: "ok", venvPython: paths.venvPython, editablePath: pkgDir, managed, commit: gitHead(pkgDir ?? "") },
    { pyprojectHash, editablePath: pkgDir },
  );
}

async function createVenv(paths: Paths): Promise<boolean> {
  if (hasCommand("uv")) {
    return runLogged(paths.logFile, "uv", ["venv", paths.venvDir]);
  }
  return runLogged(paths.logFile, "python3", ["-m", "venv", paths.venvDir]);
}

async function pipEditableInstall(paths: Paths, pkgDir: string): Promise<boolean> {
  if (hasCommand("uv")) {
    return runLogged(paths.logFile, "uv", [
      "pip", "install", "--python", paths.venvPython, "--editable", pkgDir,
    ]);
  }
  return runLogged(paths.logFile, paths.venvPython, ["-m", "pip", "install", "--editable", pkgDir]);
}

/** Fetch + hard-reset the managed clone onto the remote's default branch. */
async function updateManagedClone(paths: Paths): Promise<boolean> {
  if (!(await runLogged(paths.logFile, "git", ["-C", paths.cloneDir, "fetch", "origin"]))) {
    return false;
  }
  if (await runLogged(paths.logFile, "git", ["-C", paths.cloneDir, "reset", "--hard", "origin/HEAD"])) {
    return true;
  }
  return runLogged(paths.logFile, "git", ["-C", paths.cloneDir, "reset", "--hard", "origin/main"]);
}
