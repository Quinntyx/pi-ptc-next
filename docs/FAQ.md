# FAQ

Answers grounded in clean-environment install tests (fresh `PI_CODING_AGENT_DIR`, no tmux, no pi-profiles) and failure-mode probes of this extension. File references point into this repo.

## Minimum working setup

Distilled from a verified clean install (pi 0.87.1, node v26, python 3.14, no `pi-profiles`, no `pi-tool-tree`):

1. **Install the extension:** `pi install /path/to/repo` (local path, loads in place, no copy) or `pi install git:github.com/Quinntyx/pi-ptc-next` (clones to `<agent-dir>/git/github.com/Quinntyx/pi-ptc-next` and runs npm install — expect benign-looking npm warnings about unapproved install scripts for `koffi` and `protobufjs`).
2. **Have `python3` on PATH.** `uv` is optional (the venv falls back to `python3 -m venv`); no `npm install`/`npm run build` is needed for the extension itself — pi compiles the TypeScript at load and supplies its own runtime deps. `shiki` is only a dynamic import with a plain-text fallback, so its absence is invisible.
3. **Run pi** (TUI or `pi -p`) and ask the model to provision a kernel and run a cell. Verified headless: `provision_kernel({notebook: "..."})` → kernel id; `exec_cell("print(1+1)")` → `2`. Fresh-cache full session (install → kernel → cell, incl. LLM call) took ~7.7s; warm cache ~5.6s; no-uv fallback ~7.0s.

No environment variables are required — but note there is **no sandboxing**: kernels run as plain host Python subprocesses (yolo mode only; VM-based checkpointing is planned).

---

## General

### Do I need pi-profiles?

No. There is no pi-profiles *package* dependency anywhere in pi-ptc-next. Kernels don't need profiles at all. Subagent spawning (via `pi_subagents`) needs a pi *profile directory* named `subagents` (`$PI_SUBAGENTS_PROFILE` or `~/.config/pi/profiles/subagents`), which is resolved by pi-subagents itself, not by pi-profiles. The host only forwards `PI_SUBAGENTS_PROFILE` into the kernel env when `PTC_SUBAGENTS_PROFILE` is set (`src/python-session-manager.ts:1077-1104`); otherwise the child inherits the ambient env and pi-subagents uses its default path.

### Does it work without tmux?

Kernels and cells: yes, fully. The extension loads and `provision_kernel`/`exec_cell` work with `TMUX` unset — including nested tool calls and `ptc.*` helpers.

Subagent orchestration: no, and it degrades gracefully. Per the `envcheck.py` contract in pi-subagents, `import pi_subagents` emits a one-time stderr warning (`ENV_OK = False`) and every API call raises `NotImplementedError`:

```
result: ✗ demo-1 (demo) · NotImplementedError: pi_subagents: not running inside a tmux session —
subagent spawning is unavailable here. Run this script inside tmux to spawn subagents.
```

This surfaces as a failed per-agent pool result, not a cell crash — the cell completes normally, and the subagent footer/panels simply never activate.

### What happens without pi-tool-tree?

Everything functional works; only cosmetics degrade. `withActivityLabel()` looks up `globalThis[Symbol.for("pi-tool-tree:activity-api")]` and returns the tool unchanged if the wrapper is absent (`src/utils.ts:382-400`); the subagent-panel shimmer falls back to `theme.fg("muted", word)` (`src/execution/subagent-panel.ts:27-31`). Verified in both directions — without pi-tool-tree everything worked; with it installed, `ptc.read_tree(...)` ran fine with no conflicts. The only cost is the `activity` label on tool calls and the shimmer animation.

### Do I need to run `npm install` or `npm run build` before installing?

No. `package.json` declares `pi.extensions: ["./src/index.ts"]` and pi compiles the TypeScript itself at load time. A copied repo with **no `node_modules`** installed and ran fine — pi supplies `@mariozechner/pi-coding-agent`, `@mariozechner/pi-tui`, and typebox to extensions. `npm run build` is dev-only (and would fail without `npm i`, since `typescript` is a devDependency). Note: local-path installs load the package in place (settings.json stores the relative path, e.g. `"../repo"`); they do **not** copy it or run npm install. Git installs *do* run npm install inside the clone.

---

## First-run failures

### Why won't Python run after I install the extension?

The old `PTC_ALLOW_UNSANDBOXED_SUBPROCESS` startup gate was removed — there is no required opt-in anymore, and the extension starts out of the box. If Python still fails to run, check `python3` is on PATH (see the ENOENT question below) and set `PTC_DEBUG=1` to see the `[PTC] Using subprocess runtime (no sandboxing substrate yet)` line at load.

### Is there any sandboxing or cell-level confinement?

No. Python cells run as a local subprocess and can spawn arbitrary child processes freely — `subprocess.run(['touch', ...])` inside a cell succeeds (rc 0). The extension currently only supports "yolo mode"; VM-based checkpointing is planned but complex and not implemented. No tools are gated — raw `subprocess`/`os.system` work (which is why gating the bridged `bash` tool was dropped as futile), and mutating tools are bridged too.

### Why does calling `bash(...)` in a cell raise `NameError: name 'bash' is not defined`?

`bash` and mutating tools (`edit`/`write`) are bridged with no opt-in. Filtering them was dropped as futile — cells can run `os.system`/`subprocess` and edit files natively (yolo mode). Use `PTC_CALLABLE_TOOLS` / `PTC_BLOCKED_TOOLS` if you want to reshape the callable set.

### `provision_kernel` fails with `spawn python3 ENOENT` — what's wrong?

`python3` isn't on PATH. With both python3 and uv stripped from PATH, the background pi_subagents venv provisioning fails silently, and the first kernel fails with:

```
Failed to provision kernel: python session interpreter failed: spawn python3 ENOENT.
```

Once `~/.cache/pi-ptc/python-env` exists, system python3 is no longer needed on PATH (the venv python wins); `uv` is additionally needed by `provision_dependency` (it shells out to `uv pip install --python <exe>`). `PTC_PYTHON_EXECUTABLE` overrides the whole resolution — but note it's used verbatim with no existence check, so a bad value gives a crisp `spawn /nonexistent/python-xyz ENOENT` on kernel provisioning.

### Why does installing pi_subagents fail with a git auth error?

On first session start the extension creates `~/.cache/pi-ptc/python-env` (with `uv venv`, or `python3 -m venv` if uv is absent — the fallback is verified working, just slower) and clones pi-subagents from the default `https://git.quinntyx.dev/quinntyx/pi-subagents` into `~/.cache/pi-ptc/pi-subagents`, then editable-installs it. That host is anonymously clonable today, but if it ever isn't (or you point `PTC_SUBAGENTS_REPO_URL` at a private repo), non-interactive git can't prompt for credentials and the clone logs:

```
fatal: could not read Username for 'https://git.quinntyx.dev': No such device or address
```

in `~/.cache/pi-ptc/subagents-sync.log`. The stamp `<pkg>/src/.ptc-subagents-sync.json` gets `"ok": false` and sync retries next session. **You will see nothing in chat** — the initial-clone failure is fire-and-forget and silent (`src/index.ts:1641`; only the clone-*update* path logs a warning, `src/subagents-env.ts:416`). Kernels and sessions work fine; the first symptom is a later cell dying with `ModuleNotFoundError: No module named 'pi_subagents'`. Check `~/.cache/pi-ptc/subagents-sync.log` when that happens. The README's advice applies: if you use a private pi-subagents repo, make sure your git credential helper can read it.

A dev checkout at `~/docs/src/pi-subagents` (or `PTC_SUBAGENTS_SOURCE`) is preferred over the managed clone and skips git entirely.

### Why do I get `ModuleNotFoundError: No module named 'pi_subagents'`, and why doesn't the hint fix it?

See the previous two answers: provisioning failed (no python3/uv, clone failure, or the 24h sync stamp says "recently ok" so it was skipped). The error's built-in hint —

```
help: install it with provision_dependency('pi_subagents') then re-run
```

— is a dead end: **pi-subagents is not on PyPI** (pypi.org 404s), and `provision_dependency` just runs `uv pip install <name>` (`src/index.ts:540`). Instead, fix the sync: check `~/.cache/pi-ptc/subagents-sync.log`, fix git access or set `PTC_SUBAGENTS_REPO_URL`/`PTC_SUBAGENTS_SOURCE`, and start a new session (or delete the sync stamp to force a retry).

### What's the `.ptc-subagents-sync.json` stamp, and where does it live?

It throttles the pi_subagents sync to once per 24h (`PTC_SUBAGENTS_SYNC_INTERVAL_HOURS`). When pi loads the manifest-declared `src/index.ts`, `getExtensionRoot()` returns `__dirname`, so the stamp lands at `<pkg>/src/.ptc-subagents-sync.json` — *not* `<pkg>/` where the tracked file and comments assume. A recent `ok:true` stamp silently skips provisioning, which can make it look like nothing ran (empty cache dir) even though the code is fine. A stale, git-tracked root-level stamp with a machine-specific `editablePath` ships with non-git copies of the repo and can suppress provisioning or point at a nonexistent path — deleting it forces a fresh sync.

### Why do I get 429 provider errors on first run?

Not extension-related. With a fresh `PI_CODING_AGENT_DIR` and no model auth, pi falls back to a default provider and 429s. One tested gotcha: with `PI_CODING_AGENT_DIR` set, custom providers must go in `$PI_CODING_AGENT_DIR/models.json` (root) — a copy to `agent/models.json` is silently ignored; `auth.json` is picked up from either place.

---

## Runtime behavior

### Which environment variables does it read?

All `PTC_*` vars (from `src/utils.ts:10-95` and `docs/configuration.md`):

**Required:** none — all variables are optional. (The former mandatory `PTC_ALLOW_UNSANDBOXED_SUBPROCESS` gate was removed; kernels run unsandboxed.)

**Tools/policy:** `PTC_CALLABLE_TOOLS`, `PTC_BLOCKED_TOOLS`.

**Routing/recovery/sessions:** `PTC_AUTO_ROUTE` (true), `PTC_AUTO_RECOVER` (false), `PTC_AUTO_RECOVER_MAX_ATTEMPTS` (1, parsed 0–4), `PTC_MAX_PYTHON_SESSIONS` (4, clamped 1–32; enforcement currently disabled), `PTC_DEBUG` (false — `[PTC]` debug lines), `PTC_SUBAGENT_FOOTER` (true).

**Output/limits:** `PTC_OUTPUT_PREVIEW_CHARS` (12 000), `PTC_MAX_OUTPUT_CHARS` (legacy alias), `PTC_MAX_SPOOL_CHARS` (10 000 000), `PTC_EXECUTION_TIMEOUT_MS` (270 000), `PTC_MAX_PARALLEL_TOOL_CALLS` (8).

**Paths:** `PTC_LIBRARY_DIR` (default `$PI_CODING_AGENT_DIR/ptc-library`), `PTC_PYTHON_EXECUTABLE`, `PTC_EVALS_PATH` (`.pi/evals/ptc`), `PTC_SCRIPTS_DIR` (**parsed but never used** — no effect; script export hardcodes `./.pi/scripts`).

**Subagents:** `PTC_SUBAGENTS_REPO_URL`, `PTC_SUBAGENTS_SOURCE`, `PTC_SUBAGENTS_SYNC_INTERVAL_HOURS` (24), `PTC_SUBAGENTS_PROFILE`.

**Non-`PTC_` vars:** `PI_CODING_AGENT_DIR` (moves `ptc-library` and pi's own config), `PI_SUBAGENT_DEPTH` (set by pi on spawned subagents — skips provisioning and the `pi_subagents` autoimport; spawned agents can't spawn agents), and `PI_SUBAGENTS_PROFILE` (read by pi-subagents itself).

### What happens if I set a nonsense value for a `PTC_*` variable?

Nothing — silently. Garbage values are swallowed by lenient parsing (`src/utils.ts:10-58`): booleans are true only for `1/true/yes/on`; `parseInt` semantics mean `12abc` → 12 (so `PTC_EXECUTION_TIMEOUT_MS=270_000` becomes 270); `0` fails the `> 0` check and falls back to the default (8 for parallel calls); `999` sessions clamps to 32. Nothing is ever reported. A run with `PTC_AUTO_ROUTE=banana PTC_MAX_PARALLEL_TOOL_CALLS=0 PTC_MAX_PYTHON_SESSIONS=999 PTC_MAX_OUTPUT_CHARS=-5 PTC_MAX_SPOOL_CHARS=oink PTC_EXECUTION_TIMEOUT_MS=hotdog` loaded, ran a kernel, and produced normal output.

### Why does my cell keep getting interrupted with `KeyboardInterrupt`?

`PTC_EXECUTION_TIMEOUT_MS` is an **idle/silence** timeout that re-arms on every interpreter frame (`src/python-session-manager.ts:443-467`) — not a wall-clock cap, despite the README's "hard execution timeout" claim. Tiny values fire almost immediately: `PTC_EXECUTION_TIMEOUT_MS=1` made `time.sleep(2)` die instantly with `KeyboardInterrupt: chunk execution was interrupted`, and the model then retried for 4 minutes, dragging a 3-second question out to 4m07s. Keep it at or above the 270 000 ms default.

### Why is my cell output truncated?

Cells producing more than `PTC_OUTPUT_PREVIEW_CHARS`/`PTC_MAX_OUTPUT_CHARS` (default **12 000** chars) come back as a head/tail preview with a pointer, e.g.:

```
... 1 lines hidden (50004 of 50048 chars) — full output: read_cell_output(cellIdx=1)
```

Full output is persisted in the notebook and readable via `read_cell_output(cellIdx, offset?, limit?)` (max 2 000 lines / 50 KB per call; `PTC_MAX_SPOOL_CHARS` = 10 M chars is only an emergency capture valve). Other fixed limits: 4 Python sessions max, 8 parallel nested tool calls, 270 s idle timeout, `PTC_AUTO_ROUTE=true`, `PTC_AUTO_RECOVER=false`.

### Do kernel variables survive between pi sessions?

No. A second pi session on the same notebook got `NameError: name 'persistent_value' is not defined`. The `.ipynb` notebook (with outputs) does persist on disk, so history is recoverable via `read_cell_output`. Kernel processes die with the session (`handleSessionShutdown` → disposeAll + cleanup, SIGTERM→SIGKILL on detached process groups; verified no orphan python processes after headless runs).

### My kernel hangs when I use `subprocess` in a cell — why?

Children spawned from a cell inherit the interpreter's RPC pipes. Any child that reads stdin or writes to stdout can corrupt the protocol and hang the kernel. Always pass `stdin=subprocess.DEVNULL, capture_output=True` (README, "Kernel footgun"; also `docs/tool-bridge.md`).

### Which host tools can my Python code call, and how do I get more?

By default a safe built-in subset is bridged (`read`, `glob`/`find`, `grep`, `ls`, and more — see README "Available Python functions" and `docs/tool-bridge.md`). Nothing is gated. (Historical note: tools excluded via `PTC_BLOCKED_TOOLS`/`PTC_CALLABLE_TOOLS` show up as bare `NameError`s — see above.)

### Where does the notebook library live?

`$PI_CODING_AGENT_DIR/ptc-library` (override with `PTC_LIBRARY_DIR`). Gotcha: a nonstandard `PI_CODING_AGENT_DIR` silently moves it. Note the directory is **not** created at startup — nothing appears there until you use the promote/flow features.

---

## Housekeeping

### How do I clean up kernels?

- **From the TUI:** `/ptc kill [session_id]` (also `/ptc interrupt`, and `stop` is accepted as a synonym for interrupt). Session end kills kernels automatically.
- **Manually:** stray kernels run as `<cache>/python-env/bin/python -u -c ...` in their own process group — `pkill -f 'python-env/bin/python'`.
- **Subagent leftovers:** kill tmux windows (`tmux kill-window`) or, for an isolated test server, `tmux -L <name> kill-server`.

### How do I fully uninstall / clean up a test environment?

Remove all of these (tested paths):

- The extension: `pi remove <pkg>` (e.g. `pi remove git:github.com/Quinntyx/pi-ptc-next`, ~0.3s), and the `"packages"` entry it wrote in `settings.json` for local-path installs.
- `PI_CODING_AGENT_DIR` tree (e.g. `/tmp/.../pi-home`) if you used a throwaway one.
- `$HOME/.cache/pi-ptc` — the venv, the managed pi-subagents clone, `subagents-sync.log`, and the lock file.
- `$HOME/.config/pi/profiles/subagents` if you created a subagents profile.
- The repo copy, test notebooks, and `$HOME/.pi/pi-sock` sockets.

Verified no orphans remained after cleanup (`ps aux` for `python-env/bin/python` came back empty).

---

### Known documentation/behavior mismatches

For the record (tracked in `BUGS.md`): the README claims a "hard execution timeout" where the implementation is an idle timeout; the `ModuleNotFoundError` recovery hint recommends a PyPI package that doesn't exist; blocked tools surface as bare `NameError`s with no policy hint; nonsense env values are silently accepted; and the sync stamp lands in `<pkg>/src/` under production loading, not `<pkg>/` as the tracked file assumes.
