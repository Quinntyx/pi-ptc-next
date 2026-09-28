# Sandboxing and subprocess policy

## What it does

`pi-ptc-next` executes Python by spawning a real interpreter process on your host machine — there is no container, VM, or other isolation substrate. **There is currently no sandboxing at all: the extension only supports “yolo mode.”** Sandboxing is work-in-progress/planned — the intended direction is some form of VM-based checkpointing, but the implementation is complex and not started. There is no policy layer at all: gating the model's tools is futile enforcement when the Python process itself can run `os.system`, spawn `subprocess`, and write files natively. In short: the “sandbox” is plain host execution, not isolation.

## How it works

### Execution mode: plain host subprocess

- `createSandbox()` (`src/sandbox-manager.ts`) always returns the one implementation, `SubprocessSandbox`. There is no opt-in gate and no alternative backend — if you install the extension, Python runs on your host.
- The only implementation is `SubprocessSandbox`. Each kernel is spawned as `python -u -c <code>` with `cwd` set to the session's working directory and `env: { ...process.env }` — the host environment is inherited wholesale (`src/sandbox-manager.ts:56-66`).
- `getRuntimeWorkspaceRoot(cwd)` returns `cwd` unchanged (`src/sandbox-manager.ts:79-81`): there is no path-mapping or filesystem boundary. Python sees your real filesystem with your real permissions.

### Python interpreter selection

`resolvePythonExecutable()` (`src/sandbox-manager.ts:35-42`) resolves in this order:

1. `PTC_PYTHON_EXECUTABLE` if set (used verbatim, no existence check).
2. The shared venv at `~/.cache/pi-ptc/python-env/bin/python` (POSIX) or `...\python-env\Scripts\python.exe` (Windows) — via `venvPythonPath()` in `src/subagents-env.ts:163-170` — but only if that file exists.
3. `python3` from `PATH`.

The shared venv is the same one the pi_subagents provisioner creates (`uv venv --python 3.14`; uv is required), so subagent support is available to every kernel without extra setup.

### Process-group lifecycle and cleanup

- On non-Windows platforms, kernels are spawned as a **detached process group** (`detected: true` / `detached: true` in `spawn`). This lets cleanup signal the whole group — including grandchild processes user code spawned (e.g. subagent instances holding RPC pipes) — instead of leaving orphans behind.
- `terminate()` signals `-pid` (the group) on non-Windows; on Windows, or if the group is already gone (`ESRCH`), it falls back to `proc.kill(signal)` (`src/sandbox-manager.ts:68-82`).
- `cleanup()` sends `SIGTERM` to all tracked children, waits up to 1 s (`PROCESS_TERMINATION_GRACE_MS`), then `SIGKILL`s survivors and waits again (`src/sandbox-manager.ts:84-102`).
- The `SandboxManager` contract is evolving; `python-session-manager.ts` keeps a compatibility shim for older manager implementations whose `spawn` takes a single options object (detected via `fn.length`). Subagent agent-dir selection is purely env-driven (`PI_CODING_SUBAGENT_DIR` / `PI_CODING_AGENT_DIR`, inherited by kernels).

### What's blocked by default (tool policy)

Independently of the subprocess gate, the tool registry (`src/tool-registry.ts:236-250`) gates which pi tools are callable:

- All bridged tools — builtins, `bash`, mutating tools like `edit`/`write` — are callable by default; custom tools must opt in via `ptc: { enabled: true, ... }`. Only `PTC_CALLABLE_TOOLS`/`PTC_BLOCKED_TOOLS` reshape the set.

So a fresh install out of the box gives Python read-only access to your repo through the pi tool helpers — no shell, no file writes from the model. The subprocess itself, however, runs unsandboxed on your host.

## Usage

Optional interpreter pinning:

```bash
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

A cell calling `bash()` gets the bridged tool with no opt-in required — and remember the Python process is unsandboxed anyway: `os.system` and `subprocess.Popen` reach the same places, which is why no gate exists.

## Options / Configuration

| Env var | Default | Effect |
| --- | --- | --- |
| `PTC_PYTHON_EXECUTABLE` | *(unset)* | Interpreter used for all kernels; overrides the `~/.cache/pi-ptc/python-env` venv and `python3` fallback |
| `PTC_EXECUTION_TIMEOUT_MS` | `270000` | Hard idle timeout for a Python execution (activity re-arms it) |
| `PTC_DEBUG` | `false` | Debug logging; emits e.g. `Using subprocess runtime (no sandboxing substrate yet)` |

There are no sandbox-specific settings beyond these — no container image, network policy, or filesystem allowlist exists because no isolation substrate is implemented. VM-based kernel checkpointing is the planned direction (see the yolo-mode note at the top); until it lands, treat every kernel as your own host Python.

## Standalone setup notes

Several defaults encode the author's machine layout. None break execution — kernels fall back to `python3` — but subagent support and reproducibility depend on the following:

- **Hardcoded cache root `~/.cache/pi-ptc`** (`src/subagents-env.ts` `defaultCacheRoot()`). The venv `~/.cache/pi-ptc/python-env` is created by the subagents provisioner and preferred over `python3` by every kernel. If you don't want your kernels to silently switch interpreters when that venv appears, set `PTC_PYTHON_EXECUTABLE` explicitly.
- **`pi_subagents` source**: the managed clone defaults to the public GitHub mirror `https://github.com/Quinntyx/pi-subagents` (`DEFAULT_REPO_URL`, `src/subagents-env.ts`) and clones anonymously. Point `PTC_SUBAGENTS_REPO_URL` at your own fork, or `PTC_SUBAGENTS_SOURCE` at a local checkout to install editable instead of cloning.
- **Author-specific dev-checkout default**: when `PTC_SUBAGENTS_SOURCE` is unset, the provisioner probes `~/docs/src/pi-subagents` (`DEV_SOURCE_DEFAULT`) and installs it editable if it exists. On the author's machine this silently shadows the managed clone; elsewhere it just doesn't exist and the managed clone is used.
- **Subagent agent-dir selection**: subagents run under the orchestrator's own agent dir by default (`PI_CODING_AGENT_DIR` else `~/.pi/agent`); `PI_CODING_SUBAGENT_DIR` points them at any other directory with a pi config. No pi-profiles dependency either way.
- **Sync stamp inside the extension clone**: `.ptc-subagents-sync.json` lives in the extension's own directory and is re-synced after every `pi update` (the stamp is wiped by the update). This only matters if you rely on the managed pi-subagents clone; the venv itself is untouched.
- **No isolation to lean on**: execution is a plain host subprocess — no barrier exists between the Python process and your system, and no model-facing gate exists either. Don't use this extension in untrusted workspaces.
