# pi-ptc-next

`pi-ptc-next` (package `@cegersdo/pi-ptc`) is a Programmatic Tool Calling (PTC) extension for [pi-coding-agent](https://github.com/mariozechner/pi-coding-agent): it gives the model a persistent, Jupyter-like Python kernel that can call pi's tools (`read`, `grep`, `glob`, …) as ordinary `async` Python functions, so repo-wide fan-out work happens inside Python cells and only compact final results reach the model's context.

Fork of [`cegersdoerfer/pi-ptc`](https://github.com/cegersdoerfer/pi-ptc) by Chris Egersdoerfer.

## Requirements

- **Node.js** + **pi-coding-agent** (the host).
- **Python ≥ 3.10** on PATH (or point `PTC_PYTHON_EXECUTABLE` at a suitable interpreter).
- **`uv`** — optional; used for the shared venv and `provision_dependency` installs (see below).
- **tmux + `pi-sock` + the `pi_subagents` module + a `subagents` pi profile** — required *only* for subagent orchestration; every other feature works without them.

## Install

Install the extension:

```bash
pi install git:github.com/edxeth/pi-ptc-next
```

(Or `pi install /path/to/repo` for a local checkout.) No `npm install`/`npm run build` is needed — pi compiles the TypeScript at load time. Start `pi` and the extension registers its tools on session start.

> **⚠️ No sandboxing yet — yolo mode only.** Kernels run as plain host Python subprocesses with your real filesystem, permissions, and environment. Sandboxing is planned (VM-based checkpointing) but not implemented — the implementation is complex. Tool gating (`PTC_ALLOW_MUTATIONS`/`PTC_ALLOW_BASH`) limits what the *model* can reach; it does not constrain the Python process itself. Don't use this in untrusted workspaces.

## What you get

- `provision_kernel` + `exec_cell`: a persistent Python kernel bound to a real `.ipynb` notebook (the durable record); variables, imports, and defs persist across cells and turns.
- Pi tools as plain `async` Python functions inside cells; intermediates stay local, only compact summaries return to chat.
- Auto-routing of PTC-shaped prompts to `exec_cell`, plus optional bounded auto-recovery.
- Live code view with an executing-line marker, approval popups for `confirm: true` cells, Esc/`/ptc interrupt` to stop a chunk (kernel survives).
- Custom tools: drop `.js` files in `tools/` and expose them to Python with a `ptc:` metadata block.
- Notebook library: promote a working notebook and reuse it later via `provision_kernel({ ..., source: "name" })`.

You never call the tools yourself — describe the work:

```text
> Count the TODO comments in every *.ts file under src/ and give me the top 5 files as compact JSON only.
```

```python
files = await glob('src/**/*.ts')
counts = {f: (await read(f)).count('TODO') for f in files}
sorted(counts.items(), key=lambda kv: -kv[1])[:5]
```

## Optional dependencies

| Dependency | What it provides | Without it |
|---|---|---|
| `uv` | Preferred for creating the shared venv (`~/.cache/pi-ptc/python-env`) and for `provision_dependency` installs. | Venv creation falls back to `python3 -m venv`; `provision_dependency` fails (no pip fallback) — pre-install packages into the venv yourself. |
| `pi_subagents` + tmux + `pi-sock` + a `subagents` pi profile | The subagent orchestration stack (`import pi_subagents` in cells; one tmux window per agent). `pi_subagents` is auto-provisioned at session start from git (see `PTC_SUBAGENTS_REPO_URL` / `PTC_SUBAGENTS_SOURCE`). | All core features work untouched; only `import pi_subagents` is unavailable (provisioning failure is a logged warning, never fatal). |
| pi-tool-tree | Nicer subagent activity display and tool-call activity labels. | Plain rendering; panels/footers still work. |

Note: once the shared venv exists, every kernel prefers it over `python3`; set `PTC_PYTHON_EXECUTABLE` to pin your own interpreter.

## Documentation

Full reference: [DOCS.md](DOCS.md). Per-feature docs:

- [docs/kernels.md](docs/kernels.md) — kernel lifecycle, timeouts, `exec_cell` semantics.
- [docs/tool-bridge.md](docs/tool-bridge.md) — calling pi tools from Python, `ptc.*` helpers, result normalization.
- [docs/output-and-code-view.md](docs/output-and-code-view.md) — output previewing, `read_cell_output`, the code view and approval popups.
- [docs/auto-routing-and-recovery.md](docs/auto-routing-and-recovery.md) — when prompts route to `exec_cell`, async-failure recovery.
- [docs/subagents.md](docs/subagents.md) — `pi_subagents` pools, tmux requirements, standalone notes.
- [docs/custom-tools.md](docs/custom-tools.md) — `tools/` directory, hot reload, `ptc` metadata.
- [docs/notebook-library.md](docs/notebook-library.md) — library promotion and `source:` semantics.
- [docs/sandboxing.md](docs/sandboxing.md) — subprocess policy and tool gating.
- [docs/benchmarks-and-evals.md](docs/benchmarks-and-evals.md) — the deterministic routing/recovery benchmark CLI.
- [docs/configuration.md](docs/configuration.md) — full `PTC_*` environment variable reference.
- [docs/FAQ.md](docs/FAQ.md) — install, standalone, and troubleshooting FAQ.

## License

MIT
