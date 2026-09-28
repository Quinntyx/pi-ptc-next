# Sandboxing and subprocess policy

## What it does

`pi-ptc-next` executes Python by spawning a real interpreter process on your host machine — there is no container, VM, or other isolation substrate. Because that is a significant trust decision, the extension refuses to run Python at all until you explicitly opt in with `PTC_ALLOW_UNSANDBOXED_SUBPROCESS=true`. Once opted in, each Python session runs `python -u -c <code>` in your current working directory with the full host environment inherited, and a separate policy layer (`PTC_ALLOW_BASH`, `PTC_ALLOW_MUTATIONS`) controls which mutating pi tools the model can reach from inside Python. In short: the "sandbox" is opt-in host execution plus tool-call gating, not isolation.

## How it works

### Execution mode: explicit local subprocess

- `createSandbox()` (`src/sandbox-manager.ts:111`) rejects startup unless `settings.allowUnsandboxedSubprocess` is true, which is parsed from `PTC_ALLOW_UNSANDBOXED_SUBPROCESS` (default `false`, values `1/true/yes/on` accepted — `src/utils.ts:80`):
  > `PTC runs Python as a local subprocess. Set PTC_ALLOW_UNSANDBOXED_SUBPROCESS=true to opt in.`
- The only implementation is `SubprocessSandbox`. Each kernel is spawned as `python -u -c <code>` with `cwd` set to the session's working directory and `env: { ...process.env }` — the host environment is inherited wholesale (`src/sandbox-manager.ts:56-66`).
- `getRuntimeWorkspaceRoot(cwd)` returns `cwd` unchanged (`src/sandbox-manager.ts:79-81`): there is no path-mapping or filesystem boundary. Python sees your real filesystem with your real permissions.

### Python interpreter selection

`resolvePythonExecutable()` (`src/sandbox-manager.ts:35-42`) resolves in this order:

1. `PTC_PYTHON_EXECUTABLE` if set (used verbatim, no existence check).
2. The shared venv at `~/.cache/pi-ptc/python-env/bin/python` (POSIX) or `...\python-env\Scripts\python.exe` (Windows) — via `venvPythonPath()` in `src/subagents-env.ts:163-170` — but only if that file exists.
3. `python3` from `PATH`.

The shared venv is the same one the pi_subagents provisioner creates (`uv venv` if `uv` is available, else `python3 -m venv`), so subagent support is available to every kernel without extra setup when it exists.

### Process-group lifecycle and cleanup

- On non-Windows platforms, kernels are spawned as a **detached process group** (`detected: true` / `detached: true` in `spawn`). This lets cleanup signal the whole group — including grandchild processes user code spawned (e.g. subagent instances holding RPC pipes) — instead of leaving orphans behind.
- `terminate()` signals `-pid` (the group) on non-Windows; on Windows, or if the group is already gone (`ESRCH`), it falls back to `proc.kill(signal)` (`src/sandbox-manager.ts:68-82`).
- `cleanup()` sends `SIGTERM` to all tracked children, waits up to 1 s (`PROCESS_TERMINATION_GRACE_MS`), then `SIGKILL`s survivors and waits again (`src/sandbox-manager.ts:84-102`).
- The `SandboxManager` contract is evolving; `python-session-manager.ts:1075-1105` keeps a compatibility shim for older manager implementations whose `spawn` takes a single options object (detected via `fn.length`), and temporarily sets `PI_SUBAGENTS_PROFILE` on `process.env` around synchronous spawns when `PTC_SUBAGENTS_PROFILE` is configured.

### What's blocked by default (tool policy)

Independently of the subprocess gate, the tool registry (`src/tool-registry.ts:236-250`) gates which pi tools are callable:

- `bash` is blocked unless `PTC_ALLOW_BASH=true`.
- All mutating tools (built-in `bash`, `edit`, `write`, and non-read-only custom tools) are blocked unless `PTC_ALLOW_MUTATIONS=true`. Read-only built-ins are callable by default; custom tools must opt in via `ptc: { enabled: true, readOnly: true, ... }`.

So a fresh install with only `PTC_ALLOW_UNSANDBOXED_SUBPROCESS=true` gives Python read-only access to your repo through the pi tool helpers — no shell, no file writes from the model.

## Usage

Opt in once per shell (or in your pi profile setup):

```bash
export PTC_ALLOW_UNSANDBOXED_SUBPROCESS=true
# optional: pin the interpreter instead of the ~/.cache/pi-ptc venv fallback
export PTC_PYTHON_EXECUTABLE=/usr/bin/python3.12
```

Then a typical cell (executed via the `exec_cell` tool) reads files through the pi tool helpers without ever touching the shell:

```python
# inside exec_cell — Python runs as a host subprocess in the workspace cwd
files = ptc.read_many(glob("src/**/*.ts"))

lines = sum(f.count("\n") for f in files)
print(f"{len(files)} files, {lines} lines")

# system-level access works, because this is your host Python:
import platform, os
print(platform.python_version(), os.getcwd())
```

Without `PTC_ALLOW_UNSANDBOXED_SUBPROCESS=true`, the extension fails at startup with the error quoted above — Python never runs, so there is no partial execution to clean up. With the flag set but `PTC_ALLOW_MUTATIONS`/`PTC_ALLOW_BASH` unset, a cell calling `bash()` or `write()` gets a policy rejection from the tool registry rather than executing the mutation.

## Options / Configuration

| Env var | Default | Effect |
| --- | --- | --- |
| `PTC_ALLOW_UNSANDBOXED_SUBPROCESS` | `false` | Master gate; must be `true` (or `1/yes/on`) or Python execution is refused entirely |
| `PTC_PYTHON_EXECUTABLE` | *(unset)* | Interpreter used for all kernels; overrides the `~/.cache/pi-ptc/python-env` venv and `python3` fallback |
| `PTC_ALLOW_BASH` | `false` | Allow the `bash` tool from Python |
| `PTC_ALLOW_MUTATIONS` | `false` | Allow mutating tools (`bash`, `edit`, `write`, non-read-only custom tools) from Python |
| `PTC_EXECUTION_TIMEOUT_MS` | `270000` | Hard idle timeout for a Python execution (activity re-arms it) |
| `PTC_DEBUG` | `false` | Debug logging; emits e.g. `Using subprocess runtime (PTC_ALLOW_UNSANDBOXED_SUBPROCESS=true)` |
| `PTC_SUBAGENTS_PROFILE` | *(unset)* | pi profile directory passed to subagent instances as `PI_SUBAGENTS_PROFILE` around each spawn |

There are no sandbox-specific settings beyond these — no container image, network policy, or filesystem allowlist exists because no isolation substrate is implemented. Container/VM-based kernel snapshotting (e.g. E2B/Daytona) is deferred in `notes/BACK-BURNER.md`.

## Standalone setup notes

Several defaults encode the author's machine layout. None break execution — kernels fall back to `python3` — but subagent support and reproducibility depend on the following:

- **Hardcoded cache root `~/.cache/pi-ptc`** (`src/subagents-env.ts` `defaultCacheRoot()`). The venv `~/.cache/pi-ptc/python-env` is created by the subagents provisioner and preferred over `python3` by every kernel. If you don't want your kernels to silently switch interpreters when that venv appears, set `PTC_PYTHON_EXECUTABLE` explicitly.
- **Private forge URL for pi-subagents**: the managed clone defaults to `https://git.quinntyx.dev/quinntyx/pi-subagents` (`DEFAULT_REPO_URL`, `src/subagents-env.ts`), which is a private forge by default and may be unreachable on your machine. Workarounds: set `PTC_SUBAGENTS_REPO_URL` to a fork you can reach, or point `PTC_SUBAGENTS_SOURCE` at a local checkout to install editable instead of cloning.
- **Author-specific dev-checkout default**: when `PTC_SUBAGENTS_SOURCE` is unset, the provisioner probes `~/docs/src/pi-subagents` (`DEV_SOURCE_DEFAULT`) and installs it editable if it exists. On the author's machine this silently shadows the managed clone; elsewhere it just doesn't exist and the managed clone is used.
- **pi profile assumptions**: `PTC_SUBAGENTS_PROFILE` / `PI_SUBAGENTS_PROFILE` assume a pi profiles layout like `~/.config/pi/profiles/subagents`. If you don't use pi profiles, leave it unset — kernels spawn with the host environment unchanged and subagents use their own defaults.
- **Sync stamp inside the extension clone**: `.ptc-subagents-sync.json` lives in the extension's own directory and is re-synced after every `pi update` (the stamp is wiped by the update). This only matters if you rely on the managed pi-subagents clone; the venv itself is untouched.
- **No isolation to lean on**: since execution is a plain host subprocess, `PTC_ALLOW_MUTATIONS`/`PTC_ALLOW_BASH` are the only write/execute barriers between the model and your system. Don't enable the subprocess flag in untrusted workspaces, and don't enable both flags together unless you intend the model to be able to run shell commands and edit files.
