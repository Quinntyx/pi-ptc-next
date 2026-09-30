/**
 * pi_subagents runtime provisioning.
 *
 * pi installs this package as a git/npm clone and runs `npm install` — neither
 * touches Python. The `pi_subagents` module lives in its own repo (private
 * forge by default) and must be importable from the PTC interpreter's venv.
 *
 * This module provisions that venv and the library:
 *
 *   1. venv: create ~/.cache/pi-pycells/python-env-<ver> when missing (uv when
 *      available, else `python3 -m venv`) — resolvePythonExecutable()
 *      prefers this venv for all provision_kernel interpreters.
 *   2. source: PTC_SUBAGENTS_SOURCE (dev checkout, e.g. ~/docs/src/pi-subagents)
 *      when present, else a managed git clone at ~/.cache/pi-pycells/pi-subagents
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
 * pid-tagged lock file (atomic O_CREAT|O_EXCL acquire; a lock whose holder has
 * died is broken). Successes are stamped; failures are stamped too but retry
 * immediately while the runtime is still missing, so a failed initial
 * clone/install doesn't block for the whole interval.
 */
import { execFile, execFileSync, spawn } from "child_process";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from "fs";
import { dirname } from "path";
import { homedir } from "os";
import { createHash } from "crypto";
import { join } from "path";
import { debugLog, logWarning } from "./utils";

const DEFAULT_REPO_URL = "https://github.com/Quinntyx/pi-subagents";
const DEV_SOURCE_DEFAULT = join(homedir(), "docs", "src", "pi-subagents");
const LOCK_MAX_AGE_MS = 5 * 60 * 1000;
/** Rotate subagents-sync.log once it exceeds this size (keeps one .1 backup). */
const MAX_LOG_BYTES = 1_000_000;

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
  /** `ok` (installed and import verified), `skipped` (lock/throttle), or `failed`. */
  status: "ok" | "skipped" | "failed";
  /** Machine-readable-ish failure or skip reason; set unless status is "ok". */
  reason?: string;
  /** Interpreter inside the PTC venv (present when the venv exists). */
  venvPython?: string;
  /** Directory the editable install points at. */
  editablePath?: string;
  /** True when pi_subagents came from the managed clone, not a dev checkout. */
  managed?: boolean;
  /** Short git HEAD of the installed pi-subagents checkout. */
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
  const cacheRoot = options.cacheRoot ?? defaultCacheRoot();
  const extensionRoot = options.extensionRoot ?? cacheRoot;
  return {
    cacheRoot,
    venvDir: join(cacheRoot, "python-env"),
    venvPython: venvPythonPath(cacheRoot),
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

/**
 * Pure: whether a sync should run given the current stamp.
 *
 * Beyond the usual staleness throttle, a fresh stamp that recorded a *failure*
 * (`ok: false`) while the runtime is still missing retries immediately instead
 * of blocking for the whole interval — a failed initial clone/install used to
 * leave pi_subagents unavailable for up to 24h.
 */
export function shouldAttemptSync(
  stamp: Stamp | undefined,
  syncIntervalMs: number,
  now: number,
  runtimeReady: boolean,
): boolean {
  if (isStampStale(stamp, syncIntervalMs, now)) return true;
  return stamp?.ok === false && !runtimeReady;
}

/** Pure: is a usable pi_subagents source available (dev checkout or managed clone)? */
export function sourceAvailable(devSource: string | undefined, cloneDir: string): boolean {
  return resolveSourceDir(devSource) !== undefined || existsSync(join(cloneDir, ".git"));
}

/** Pure: default cache root shared with sandbox-manager's venv lookup. */
export function defaultCacheRoot(): string {
  return join(homedir(), ".cache", "pi-pycells");
}

/**
 * Pure: path of the python interpreter inside the PTC venv.
 *
 * Shared single source of truth for venv layout (see review C5):
 * `sandbox-manager.ts resolvePythonExecutable` should consume this instead of
 * re-deriving the path. Both historically hardcoded `bin/python` (the POSIX
 * layout); Windows venvs use `Scripts\python.exe`, so this is platform-aware.
 */
export function venvPythonPath(cacheRoot: string = defaultCacheRoot()): string {
  return sharedVenvPythonPath(cacheRoot);
}

/**
 * Interpreter of the shared venv, preferring the current version-pinned layout
 * (python-env-<X.Y>) and falling back to the pre-pinning layout (python-env)
 * for existing installs. Both are venvs this extension created — the legacy
 * path is a managed artifact, not a system-python fallback. Never falls back
 * to system python.
 */
export function sharedVenvPythonPath(cacheRoot: string = defaultCacheRoot()): string {
  const versioned = versionedVenvPythonPath(DEFAULT_PYTHON_VERSION, cacheRoot);
  if (existsSync(versioned)) return versioned;
  const legacy = process.platform === "win32"
    ? join(cacheRoot, "python-env", "Scripts", "python.exe")
    : join(cacheRoot, "python-env", "bin", "python");
  if (existsSync(legacy)) return legacy;
  return versioned;
}

/** Python interpreter inside the per-version venv `python-env-<X.Y>`. */
export function versionedVenvPythonPath(version: string, cacheRoot: string = defaultCacheRoot()): string {
  return process.platform === "win32"
    ? join(cacheRoot, `python-env-${version}`, "Scripts", "python.exe")
    : join(cacheRoot, `python-env-${version}`, "bin", "python");
}

/**
 * Ensure a venv exists for the given Python X.Y version and return its
 * interpreter path. uv is required (it also fetches the managed CPython when
 * the host lacks that version). Used to honor .ipynb python pins.
 */
export async function ensurePythonForVersion(version: string): Promise<string> {
  const cacheRoot = defaultCacheRoot();
  const python = versionedVenvPythonPath(version, cacheRoot);
  if (existsSync(python)) return python;
  if (!hasCommand("uv")) {
    throw new Error("uv is required (https://docs.astral.sh/uv/) to provision Python environments");
  }
  mkdirSync(cacheRoot, { recursive: true });
  const ok = await runLogged(join(cacheRoot, "subagents-sync.log"), "uv",
    ["venv", "--python", version, join(cacheRoot, `python-env-${version}`)]);
  if (!ok || !existsSync(python)) {
    throw new Error(`could not create a Python ${version} venv via uv (see ~/.cache/pi-pycells/subagents-sync.log)`);
  }
  // The embedded-IPython runtime hard-requires IPython; a bare `uv venv` would
  // produce a kernel that cannot start. Unpinned: uv resolves the newest
  // IPython compatible with the requested interpreter (9.x for modern
  // CPythons, 8.x for older pins).
  await installRuntimeDependencies(python, join(cacheRoot, "subagents-sync.log"));
  return python;
}

/** Install the Python runtime's hard third-party dependency into a venv. */
async function installRuntimeDependencies(venvPython: string, logFile: string): Promise<boolean> {
  return runLogged(logFile, "uv", ["pip", "install", "--python", venvPython, "ipython"]);
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
  rotateLogIfNeeded(logFile);
  return new Promise((resolve) => {
    const log = openSync(logFile, "a");
    const child = spawn(cmd, args, { stdio: ["ignore", log, log] });
    closeSync(log);
    child.on("exit", (code) => resolve(code === 0));
    child.on("error", () => resolve(false));
  });
}

/** Size-cap the sync log: keep one generation as `<logFile>.1`. */
function rotateLogIfNeeded(logFile: string): void {
  try {
    if (statSync(logFile).size > MAX_LOG_BYTES) {
      rmSync(`${logFile}.1`, { force: true });
      renameSync(logFile, `${logFile}.1`);
    }
  } catch {
    // no log yet (ENOENT) or rotation failed — appending still works
  }
}

function hasCommand(cmd: string): boolean {
  try {
    // Probe the command directly rather than shelling to `which`/`where`:
    // minimal containers and some Nix setups lack `which`, which used to make
    // uv detection silently fail and push venv creation onto the python3 path.
    execFileSync(cmd, ["--version"], { stdio: "ignore" });
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

// --- lock ------------------------------------------------------------------------

/**
 * Atomically create the lock file (O_CREAT|O_EXCL via "wx") and stamp it with
 * the holder's pid. Returns false when another process won the race — there is
 * no check-then-write window, so two concurrent pi processes can never both
 * hold the lock (M9).
 */
function acquireLock(paths: Paths): boolean {
  try {
    const fd = openSync(paths.lockFile, "wx");
    try {
      writeSync(fd, String(process.pid));
    } finally {
      closeSync(fd);
    }
    return true;
  } catch {
    return false; // EEXIST (lost the race) or the filesystem refused
  }
}

/**
 * Pure-ish: the pid recorded in the lock file, or undefined for legacy content.
 *
 * Legacy locks (pre-M9) held a Date.now() timestamp instead of a pid; those are
 * always >= 2^31 while real pids are < 2^31 (pid_t is int32), so values in the
 * timestamp range are treated as legacy and handled by the age heuristic.
 */
export function readLockPid(lockFile: string): number | undefined {
  try {
    const pid = Number(readFileSync(lockFile, "utf8").trim());
    return Number.isInteger(pid) && pid > 0 && pid < 2 ** 31 ? pid : undefined;
  } catch {
    return undefined;
  }
}

/** Whether a process with this pid is (probably) still running. */
export function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: alive but owned by another user; anything else: gone
    return (error as NodeJS.ErrnoException)?.code === "EPERM";
  }
}

/**
 * Drop the lock only if it still holds OUR pid (M9/L18): a stale-lock breaker
 * or a later holder may have replaced the file since we acquired it, and our
 * cleanup must never delete a live sync's lock.
 */
function releaseLock(paths: Paths): void {
  try {
    if (readLockPid(paths.lockFile) === process.pid) {
      rmSync(paths.lockFile, { force: true });
    }
  } catch {
    // best-effort; a leftover lock with a dead pid is broken on next run
  }
}

// --- readiness gate ---------------------------------------------------------------

/**
 * In-flight provisioning promise, memoized so the session manager and the
 * entry point share one run. Settled results stay memoized: a failed sync
 * must not trigger retry storms from every kernel start.
 */
let envPromise: Promise<SubagentsEnvResult> | undefined;

/**
 * Venv-only provisioning: create the shared CPython venv if missing, skipping
 * the pi_subagents clone/install. Used in spawned subagent windows
 * (PI_SUBAGENT_DEPTH set), where the full sync is skipped but kernels still
 * need their interpreter — no system-python fallback exists anymore.
 */
export async function ensurePtcVenv(): Promise<boolean> {
  const paths = resolvePaths({});
  if (existsSync(paths.venvPython)) return true;
  if (!hasCommand("uv")) return false;
  mkdirSync(paths.cacheRoot, { recursive: true });
  return createVenv(paths);
}

/**
 * Kick off provisioning once per process and share the promise. Returns the
 * same result for every caller; rejections are normalized to a failed result.
 */
export function startSubagentsEnv(options: SubagentsEnvOptions = {}): Promise<SubagentsEnvResult> {
  envPromise ??= ensureSubagentsEnv(options).catch((error): SubagentsEnvResult => ({
    status: "failed",
    reason: error instanceof Error ? error.message : String(error),
  }));
  return envPromise;
}

/**
 * Resolve once provisioning has settled (or `timeoutMs` elapsed, whichever is
 * first). Callers spawn kernels after this so interpreter resolution sees the
 * venv when provisioning managed to create it — without this gate, a
 * first-install kernel can start on system `python3` while provisioned
 * packages land in the venv it never picked.
 */
export async function waitForSubagentsEnv(timeoutMs = 120_000): Promise<void> {
  if (!envPromise) return;
  await Promise.race([
    envPromise.then(() => undefined, () => undefined),
    new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, timeoutMs);
      timer.unref?.();
    }),
  ]);
}

// --- sync -------------------------------------------------------------------------

/**
 * Run a full provisioning pass (venv, source, editable install, import check)
 * under the pid-tagged lock file: skips when another live process holds the
 * lock, breaks locks left by dead pids, and honors the stamp-file throttle
 * (see shouldAttemptSync). Returns the outcome; never throws.
 */
export async function ensureSubagentsEnv(
  options: SubagentsEnvOptions = {},
): Promise<SubagentsEnvResult> {
  const paths = resolvePaths(options);
  mkdirSync(paths.cacheRoot, { recursive: true });
  const nowMs = options.now?.() ?? Date.now();

  if (!acquireLock(paths)) {
    // Lock exists: held by a live process, or left behind by a crashed one.
    const pid = readLockPid(paths.lockFile);
    let stale: boolean;
    if (pid !== undefined) {
      // Pid-tagged lock: stale iff the holder is dead, regardless of age.
      stale = !pidAlive(pid);
    } else {
      // Legacy timestamp-only lock: fall back to the age heuristic.
      let age: number;
      try {
        age = nowMs - Number(readFileSync(paths.lockFile, "utf8").trim() || 0);
      } catch {
        age = 0;
      }
      stale = !(age >= 0 && age < LOCK_MAX_AGE_MS);
    }
    if (!stale) {
      return { status: "skipped", reason: "another sync holds the lock" };
    }
    // Break the stale lock (its holder is provably gone) and retry once.
    try {
      rmSync(paths.lockFile, { force: true });
    } catch {
      // ignore; the re-acquire below will surface contention
    }
    if (!acquireLock(paths)) {
      return { status: "skipped", reason: "another sync holds the lock" };
    }
  }

  try {
    return await sync(options, paths);
  } finally {
    releaseLock(paths);
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
  const devSource = options.devSource ?? process.env.PTC_SUBAGENTS_SOURCE ?? DEV_SOURCE_DEFAULT;
  const runtimeReady =
    existsSync(paths.venvPython) && sourceAvailable(devSource, paths.cloneDir);
  if (!shouldAttemptSync(stamp, intervalMs, options.now?.() ?? Date.now(), runtimeReady)) {
    return { status: "skipped", reason: "recently synced", venvPython: paths.venvPython };
  }

  // 1. venv
  if (!existsSync(paths.venvPython)) {
    if (!hasCommand("uv")) {
      return finish({
        status: "failed",
        reason: "uv is required (https://docs.astral.sh/uv/) — install it and restart pi",
      });
    }
    const ok = await createVenv(paths);
    if (!ok) {
      return finish({ status: "failed", reason: `could not create the PTC venv (uv venv --python ${DEFAULT_PYTHON_VERSION})` });
    }
  }

  // 2. resolve the source dir (dev checkout wins, else managed clone)
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

/** The CPython version the shared venv pins. uv fetches it if the host lacks it. */
export const DEFAULT_PYTHON_VERSION = "3.14";

async function createVenv(paths: Paths, pythonVersion: string = DEFAULT_PYTHON_VERSION): Promise<boolean> {
  // uv is REQUIRED, deliberately: a silent python3 -m venv fallback made first
  // installs slower and differently-broken (no uv => no provision_dependency
  // either), and users blamed the plugin for degraded runtime instead of their
  // missing dependency. Fail loudly instead.
  const ok = await runLogged(paths.logFile, "uv", ["venv", "--python", pythonVersion, paths.venvDir]);
  if (!ok) return false;
  // The runtime hard-requires IPython (embedded shell); without this a fresh
  // install provisions venvs whose kernels die on first start.
  return installRuntimeDependencies(paths.venvPython, paths.logFile);
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
