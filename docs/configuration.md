# Configuration reference

Everything `pi-ptc-next` does is configured through environment variables. There is no
settings file: the extension reads `process.env` once when it loads (`loadSettingsFromEnv`,
`src/utils.ts:63`), builds a `PtcSettings` object (`src/contracts/settings.ts`), and uses it
for the lifetime of the pi session. This page lists every variable, its type, its default,
and where it takes effect.

## What it does

One startup read turns your environment into the extension's entire configuration: execution
timeouts, output-preview sizing, which pi tools Python may call, auto-routing and recovery
behavior, kernel and library paths, and the optional pi-subagents integration. Kernels are
spawned with a copy of the extension's environment (`src/python-session-manager.ts` spawns
with `env: { ...process.env }`), so the same `PTC_*` variables are also visible inside
`exec_cell` cells, and the Python runtime reads some of them (`PTC_MAX_SPOOL_CHARS`) directly
as a fallback. Because settings are captured at extension load, changing a variable requires
starting a new pi session (or reloading the extension), not just setting it mid-session.

## How it works

- `loadSettingsFromEnv()` (`src/utils.ts:63-95`) maps each `PTC_*` variable to one
  `PtcSettings` field using three parsers:
  - **Booleans** (`parseBooleanEnv`): `1`, `true`, `yes`, `on` (case-insensitive) are truthy;
    everything else — including unset — falls back to the field's default.
  - **Positive integers** (`parsePositiveIntEnv`): invalid or non-positive values fall back
    to the default.
  - **Clamped integers** (`parseClampedIntEnv`): values outside the documented range are
    clamped, not rejected.
  - **Lists** (`parseListEnv`): comma-separated, trimmed; empty values are treated as unset.
- The resulting `PtcSettings` object is passed to the tool registry, session manager, sandbox
  manager, and panel code. No part of the extension reads a config file or pi settings store;
  environment variables are the only configuration surface.
- Two settings are additionally injected into each kernel as Python globals at spawn time:
  `PTC_MAX_PARALLEL_TOOL_CALLS` (from `settings.maxParallelToolCalls`,
  `src/execution/session-prelude.ts:49`) and the spool ceiling (`settings.maxSpoolChars` →
  `maxOutputChars`, `src/python-session-manager.ts:1139-1142`). The Python runtime's own env
  fallbacks (`src/python-runtime/runtime.py:20-22,232`) match the Node defaults, so both
  paths agree unless you set the env var only inside the kernel — the host-side value wins.

## Usage

Set variables in the shell that launches pi (or in your pi profile's environment):

```bash
# Allow Python to use mutating tools and bash; raise the per-cell timeout
export PTC_ALLOW_MUTATIONS=true
export PTC_ALLOW_BASH=true
export PTC_EXECUTION_TIMEOUT_MS=600000

# Give the model a larger head/tail preview of cell output
export PTC_OUTPUT_PREVIEW_CHARS=20000

# Keep reusable notebooks somewhere other than ~/.config/pi/ptc-library
export PTC_LIBRARY_DIR=~/notebooks/ptc-library

# Debug logging while troubleshooting tool policy
export PTC_DEBUG=1

pi
```

Since kernels inherit the environment, you can verify the live configuration from a cell:

```python
import os, json
return json.dumps({k: v for k, v in os.environ.items() if k.startswith("PTC_")}, indent=2)
```

Note the two `true` values above are required before anything works: without
`PTC_ALLOW_UNSANDBOXED_SUBPROCESS=true` the extension refuses to start Python at all
(`createSandbox` rejects with an explanatory error, `src/sandbox-manager.ts:112-119`), and
without `PTC_ALLOW_MUTATIONS`/`PTC_ALLOW_BASH` only read-only tools are callable from cells.

## Environment variables

Parsed by `loadSettingsFromEnv()` (`src/utils.ts`). Defaults are the constants at the top of
that file.

### Startup gate

| Variable | Type | Default | Effect |
|---|---|---|---|
| `PTC_ALLOW_UNSANDBOXED_SUBPROCESS` | bool | `false` | Must be `true`; the extension runs Python as a local subprocess and rejects startup otherwise. |

### Execution

| Variable | Type | Default | Effect |
|---|---|---|---|
| `PTC_EXECUTION_TIMEOUT_MS` | positive int | `270000` (4.5 min) | Hard timeout for a full cell execution (host-side, `src/python-session-manager.ts:1368`). |
| `PTC_OUTPUT_PREVIEW_CHARS` | positive int | `12000` | Model-visible preview size; output beyond this is collapsed to ~70% head / 30% tail with a `read_cell_output` pointer. `PTC_MAX_OUTPUT_CHARS` is accepted as a legacy alias. |
| `PTC_MAX_SPOOL_CHARS` | positive int | `10000000` | Emergency per-cell capture ceiling; anything below it is persisted in full to the notebook. Not a preview limit. Also enforced inside the Python runtime. |
| `PTC_MAX_PARALLEL_TOOL_CALLS` | positive int | `8` | Default concurrency for `ptc.gather_limit()` and the runtime's parallel tool-call cap. |

### Tool policy

Tool filtering happens in `ToolRegistry.getCallableTools` (`src/tool-registry.ts:222-254`):
`PTC_BLOCKED_TOOLS` is checked first (denylist always wins), then `PTC_CALLABLE_TOOLS`
(when set, only listed tools pass), then `bash` requires `PTC_ALLOW_BASH`, and when
`PTC_ALLOW_MUTATIONS` is off only read-only built-ins plus trusted read-only custom tools
are callable.

| Variable | Type | Default | Effect |
|---|---|---|---|
| `PTC_ALLOW_MUTATIONS` | bool | `false` | Allow mutating tools (`edit`, `write`, …) from Python. |
| `PTC_ALLOW_BASH` | bool | `false` | Allow the `bash` tool from Python. |
| `PTC_CALLABLE_TOOLS` | comma list | *(unset — all eligible tools)* | Explicit allowlist override. |
| `PTC_BLOCKED_TOOLS` | comma list | *(unset)* | Explicit denylist; wins over the allowlist. |
| `PTC_TRUSTED_READ_ONLY_TOOLS` | comma list | *(unset)* | Custom tools treated as read-only (and thus callable with mutations disabled) even though they are not marked read-only. |

### Routing, recovery, sessions

| Variable | Type | Default | Effect |
|---|---|---|---|
| `PTC_AUTO_ROUTE` | bool | `true` | Route qualifying prompts (repo-wide analysis, fan-out, "don't flood chat") to `exec_cell` automatically. |
| `PTC_AUTO_RECOVER` | bool | `false` | Enable one bounded async-only recovery hint after a qualifying failed first `exec_cell` attempt. |
| `PTC_AUTO_RECOVER_MAX_ATTEMPTS` | clamped int (0–4) | `1` | Cap on automatic recovery attempts per request. |
| `PTC_MAX_PYTHON_SESSIONS` | clamped int (1–32) | `4` | Parsed for compatibility but enforcement is currently disabled (`src/python-session-manager.ts:1123`). |
| `PTC_SCRIPTS_DIR` | path | *(unused)* | Parsed into settings but never read; script export hardcodes `./.pi/scripts` as its default directory. Setting it has no effect. |
| `PTC_DEBUG` | bool | `false` | Emit `[PTC]`-prefixed debug lines to stdout (routing decisions, provisioning, tool reloads). |
| `PTC_SUBAGENT_FOOTER` | bool | `true` | Show the live subagent status footer; set `false` if a custom footer consumes the `pi-ptc:subagent-runtime` API. |

### Paths and library

| Variable | Type | Default | Effect |
|---|---|---|---|
| `PTC_LIBRARY_DIR` | path (tilde-expanded) | `$PI_CODING_AGENT_DIR/ptc-library` | Reusable notebook library used by the notebook flows `/ptc` notebook flows (`resolveLibraryDir`, `src/python-session-manager.ts:992-1002`). `PI_CODING_AGENT_DIR` defaults to `~/.config/pi`. |
| `PTC_EVALS_PATH` | path | `.pi/evals/ptc` | Root of the JSON eval/benchmark cases (`src/benchmark-runner.ts:175`); read directly, not part of `PtcSettings`. |
| `PTC_PYTHON_EXECUTABLE` | path | *(unset)* | Interpreter used for every kernel, verbatim and with no existence check. Overrides the venv resolution below (`src/sandbox-manager.ts:35-38`). |

### pi-subagents provisioning

These configure the background provisioner that creates the shared venv and installs the
optional `pi_subagents` package (`src/subagents-env.ts`). Provisioning runs only when
`PI_SUBAGENT_DEPTH` is unset (i.e. not inside a subagent) and failures are logged, not fatal.

| Variable | Type | Default | Effect |
|---|---|---|---|
| `PTC_SUBAGENTS_REPO_URL` | URL | `https://git.quinntyx.dev/quinntyx/pi-subagents` | Where the provisioner clones pi-subagents from when no dev checkout is found. |
| `PTC_SUBAGENTS_SOURCE` | path | `~/docs/src/pi-subagents` (if it exists) | Dev checkout installed editable instead of the managed clone; only used when the directory actually contains a `pyproject.toml`. |
| `PTC_SUBAGENTS_SYNC_INTERVAL_HOURS` | number | `24` | Minimum interval between syncs; a younger sync stamp in the extension clone skips re-sync. |
| `PTC_SUBAGENTS_PROFILE` | path | *(unset)* | Forwarded to kernels as `PI_SUBAGENTS_PROFILE` around each spawn (`src/python-session-manager.ts:1077-1096`), telling `pi_subagents` which pi profile to launch subagent instances with. |

### Fixed limits (not configurable)

These are constants, not environment variables, listed so you know the hard edges:
`read_cell_output` returns at most 2,000 lines / 50 KB per call and truncates any single line
over 50 KB (`DEFAULT_CELL_OUTPUT_LINES` / `DEFAULT_CELL_OUTPUT_BYTES`, `src/utils.ts:11-13`);
the subagent context readout assumes a 200,000-token context limit when a snapshot carries
none (`PTC_CTX_LIMIT_FALLBACK`, `src/execution/subagent-panel.ts:8`).

## Standalone setup notes

Items that assume the author's machine layout, and the workaround for each:

- **Private forge as the pi-subagents source.** `PTC_SUBAGENTS_REPO_URL` defaults to
  `https://git.quinntyx.dev/quinntyx/pi-subagents`, which is inaccessible outside the
  author's network. On your machine the background provisioner fails with a logged warning
  and `import pi_subagents` is unavailable — nothing else breaks. To use subagents, set
  `PTC_SUBAGENTS_REPO_URL` to a URL you can clone (the provisioner shells out to plain
  `git`, so private repos need a working credential helper), or point `PTC_SUBAGENTS_SOURCE`
  at your own checkout.
- **Author's home-relative dev-checkout default.** `PTC_SUBAGENTS_SOURCE` defaults to
  `~/docs/src/pi-subagents` (`DEV_SOURCE_DEFAULT`, `src/subagents-env.ts:50`). On the
  author's machine this silently wins over the managed clone. If you happen to have a
  directory there it will be used too — set the variable explicitly (or leave it pointing at
  a path that doesn't exist) to control which source is installed.
- **`subagents` pi profile assumption.** When `PTC_SUBAGENTS_PROFILE` is set, subagents are
  launched with that pi profile directory; the pi-subagents package itself defaults to
  `~/.config/pi/profiles/subagents`, which assumes you created a pi profile named exactly
  `subagents` under `~/.config/pi/profiles/`. If you don't use pi profiles, leave
  `PTC_SUBAGENTS_PROFILE` unset — kernels spawn with your environment unchanged.
- **Venv and cache root under `~/.cache/pi-ptc`.** The provisioner creates
  `~/.cache/pi-ptc/python-env` (via `uv` if available, else `python3 -m venv`) and a managed
  `pi-subagents` clone there. Once that venv exists, every kernel prefers its interpreter
  over `python3` (`resolvePythonExecutable`, `src/sandbox-manager.ts:35-42`) — even if you
  never use subagents. Set `PTC_PYTHON_EXECUTABLE` to pin your own interpreter; the target
  must be Python ≥ 3.10 (kernels fail fast otherwise).
- **pi agent-dir convention.** `PTC_LIBRARY_DIR`'s default assumes pi's
  `$PI_CODING_AGENT_DIR`/`~/.config/pi` layout, and `PTC_EVALS_PATH`'s default `.pi/evals/ptc`
  assumes a pi project with that directory. Set either variable explicitly if your layout
  differs.
- **Sync stamp inside the extension clone.** The pi-subagents sync stamp lives at
  `<extensionRoot>/.ptc-subagents-sync.json`; because `pi update` resets package clones, each
  update triggers a fresh sync from whatever `PTC_SUBAGENTS_REPO_URL`/`PTC_SUBAGENTS_SOURCE`
  resolve to on your machine at that moment — keep those variables pointing somewhere you
  can reach.
