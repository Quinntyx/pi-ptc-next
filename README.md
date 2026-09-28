# pi-ptc-next

`pi-ptc-next` (package `@cegersdo/pi-ptc`) is an extension for [Pi](https://github.com/mariozechner/pi-coding-agent) that implements Programmatic Tool Calling (PTC): instead of streaming every tool result back into the model's context, the model writes Python cells against a persistent, Jupyter-like kernel and calls Pi's tools (`read`, `grep`, `glob`, …) as ordinary `async` Python functions. Only each cell's final output reaches the model, so multi-step work costs a fraction of the tokens. The same kernels double as launch pads for parallel subagent orchestration (optional; see below).

Fork of [`edxeth/pi-ptc-next`](https://github.com/edxeth/pi-ptc-next), which itself forked [`cegersdoerfer/pi-ptc`](https://github.com/cegersdoerfer/pi-ptc) by Chris Egersdoerfer.

## Install

1. **Install the extension into Pi:**

   ```bash
   pi install git:github.com/Quinntyx/pi-ptc-next
   ```

   Pi clones the repo into `<agent-dir>/git/github.com/Quinntyx/pi-ptc-next` and runs `npm install` for it (a few benign-looking npm warnings about unapproved install scripts are normal). For local development, `pi install /path/to/repo` loads a checkout in place instead of cloning.

2. **That's the whole install.** No `npm run build` is needed — Pi compiles the extension's TypeScript at load time — and no environment variables are required. On the next `pi` start, the extension registers `provision_kernel`, `exec_cell`, and friends.

3. **Verify it works.** Start `pi` and describe a PTC-shaped task, or check headless:

   ```bash
   pi -p "Use provision_kernel and exec_cell to print 1+1 in a Python cell."
   ```

4. **Optional — subagent orchestration.** To let cells spawn parallel Pi subagents, install the `pi_subagents` stack in a tmux-capable environment (see [Optional dependencies](#optional-dependencies)); everything else works without it. The Python half (`pi_subagents`) is auto-provisioned into `~/.cache/pi-ptc/python-env` at session start.

To remove: `pi remove git:github.com/Quinntyx/pi-ptc-next`.

> **⚠️ No sandboxing yet — yolo mode only.** Kernels run as plain host Python subprocesses with your real filesystem, permissions, and environment. Sandboxing is planned (VM-based checkpointing) but not implemented — the implementation is complex. `PTC_ALLOW_BASH` gates the bridged `bash` tool only; mutating tools are not gated at all — none of it constrains the Python process itself. Don't use this in untrusted workspaces.

## Requirements

- **Node.js** and **Pi** (the host agent).
- **Python ≥ 3.10** on PATH (or point `PTC_PYTHON_EXECUTABLE` at a suitable interpreter).
- **`uv`** — optional; used for the shared venv and `provision_dependency` installs (see below).
- **tmux + `pi-sock` + the `pi_subagents` module + a `subagents` Pi profile** — required *only* for subagent orchestration; every other feature works without them.

## Usage

### Python kernels with tool access

You never manage kernels by hand — describe the work and the model provisions a kernel and runs cells:

```text
> Count the TODO comments in every *.ts file under src/ and give me the
> top 5 files as compact JSON only.
```

```python
# the model writes this as an exec_cell call — note what's NOT in your context:
# none of the 200 file contents ever leave the kernel
files = await glob('src/**/*.ts')
counts = {f: (await read(f)).count('TODO') for f in files}
sorted(counts.items(), key=lambda kv: -kv[1])[:5]
```

The kernel is bound to a real `.ipynb` notebook (the durable record): variables, imports, and definitions persist across cells and conversation turns, output below a size cap is persisted in full but only summarized to the model, and host tools are gated by policy — with the defaults, cells get read-only access and no shell.

For simple requests the model still uses direct tools like `read` and `grep`; prompts shaped like the above (repo-wide scans, bulk conversions, aggregations, "compact JSON only") are auto-routed to a kernel, with optional bounded auto-recovery when a cell fails.

More: [docs/kernels.md](docs/kernels.md) (kernel lifecycle), [docs/tool-bridge.md](docs/tool-bridge.md) (calling tools from Python), [docs/auto-routing-and-recovery.md](docs/auto-routing-and-recovery.md).

### Subagent orchestration from a cell

When the optional `pi_subagents` stack is installed (see the table below), kernels can `import pi_subagents` and fan work out to real interactive Pi instances — one tmux window per agent, watchable and steerable by hand while the cell blocks:

```python
import pi_subagents as subagents

pool = subagents.AgentPool(concurrency=4)
audit = pool.stage("audit", slots=4)
audit.submit_all(subagents.Task(f"Audit {f} for bugs", model="provider/model")
                 for f in changed_files)
while (result := await pool.pop(timeout=3600)) is not None:
    if result.ok:
        print(result.task.name, "->", result.body[:80])
pool.close()   # tears down every spawned agent window
```

Results come back in completion order, sessions can be reused for follow-ups, and a live progress panel renders in the chat while the cell runs. Without the stack this is simply unavailable — everything above keeps working.

More: [docs/subagents.md](docs/subagents.md).

### Also in the box

- **Live code view** — executed cells render with syntax highlighting and an executing-line marker; `confirm: true` cells show an approval popup before running; Esc or `/ptc interrupt` stops a chunk without killing the kernel.
- **Custom tools** — drop `.js` files into `tools/` with a `ptc:` metadata block and they become callable from Python (hot-reloaded).
- **Notebook library** — promote a working notebook with `promote_to_skill_notebook({ name })`, then start future kernels from it via `provision_kernel({ notebook: ..., source: "name" })` for reusable, pre-seeded workflows.

More: [docs/output-and-code-view.md](docs/output-and-code-view.md), [docs/custom-tools.md](docs/custom-tools.md), [docs/notebook-library.md](docs/notebook-library.md).

## Optional dependencies

| Dependency | What it provides | Without it |
|---|---|---|
| `uv` | Preferred for creating the shared venv (`~/.cache/pi-ptc/python-env`) and for `provision_dependency` installs. | Venv creation falls back to `python3 -m venv`; `provision_dependency` fails (no pip fallback) — pre-install packages into the venv yourself. |
| `pi_subagents` + tmux + `pi-sock` + a `subagents` Pi profile | The subagent orchestration stack (`import pi_subagents` in cells; one tmux window per agent). `pi_subagents` is auto-provisioned at session start from git (see `PTC_SUBAGENTS_REPO_URL` / `PTC_SUBAGENTS_SOURCE`). | All core features work untouched; only `import pi_subagents` is unavailable (provisioning failure is a logged warning, never fatal). |
| pi-tool-tree *(experimental)* | Nicer subagent activity display and tool-call activity labels. Currently unstable — known rendering bugs. | Plain rendering; the subagent panel, timers, and the vendored shimmer animation all work without it — you only lose live agent activity labels. |

Note: once the shared venv exists, every kernel prefers it over `python3`; set `PTC_PYTHON_EXECUTABLE` to pin your own interpreter.

## Documentation

The docs above cover day-to-day use. For full detail:

- **[DOCS.md](DOCS.md)** — the complete reference: all features, configuration table, optional dependencies, standalone-setup notes.
- **[docs/](docs/)** — one deep-dive per feature: [kernels](docs/kernels.md) · [tool-bridge](docs/tool-bridge.md) · [custom-tools](docs/custom-tools.md) · [output-and-code-view](docs/output-and-code-view.md) · [sandboxing](docs/sandboxing.md) · [auto-routing-and-recovery](docs/auto-routing-and-recovery.md) · [notebook-library](docs/notebook-library.md) · [subagents](docs/subagents.md) · [configuration](docs/configuration.md) (every `PTC_*` env var) · [benchmarks-and-evals](docs/benchmarks-and-evals.md)
- **[docs/FAQ.md](docs/FAQ.md)** — verified install steps, standalone setups, and troubleshooting.

## License

MIT
