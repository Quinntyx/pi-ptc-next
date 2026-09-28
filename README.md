# pi-pycells

`pi-pycells` is an extension for [Pi](https://github.com/earendil-works/pi) that implements Programmatic Tool Calling (PTC): instead of streaming every tool result back into the model's context, the model writes Python cells against a persistent, Jupyter-like kernel and calls Pi's tools (`read`, `grep`, `glob`, …) as ordinary `async` Python functions. Only each cell's final output reaches the model, so multi-step work costs a fraction of the tokens. The same kernels double as launch pads for parallel subagent orchestration (optional; see below).

Fork of [`edxeth/pi-ptc-next`](https://github.com/edxeth/pi-ptc-next), which itself forked [`cegersdoerfer/pi-ptc`](https://github.com/cegersdoerfer/pi-ptc) by Chris Egersdoerfer.

## Install

**⚠️ Yolo mode — no sandbox.** Pi itself runs tools with your full permissions, and so do these Python kernels: plain processes with full file/network access, nothing sandboxed or gated (cells can even run shell commands natively). Sandboxing is planned (VM-based checkpointing) but not implemented. Don't point it at untrusted code.

**Before you start:** make sure plain `pi` answers a normal prompt (run `pi -p "hi"` once; if it errors with auth/quota JSON, run `/login` in `pi` and get a working model first — nothing here works until that does). You'll also need **[`uv`](https://docs.astral.sh/uv/)** — required; it provisions the Python environment (CPython 3.14 by default, downloaded for you if missing) — and `git`.

1. **Install the extension into Pi:**

   ```bash
   pi install git:github.com/Quinntyx/pi-pycells
   ```

   Pi downloads the extension into its own folder (`~/.pi/agent/git/github.com/Quinntyx/pi-pycells` by default) and runs `npm install` there; it usually takes under a minute. For local development, `pi install /path/to/repo` loads a checkout in place instead of cloning.

2. **Verify it works.** Start `pi` and describe a PTC-shaped task, or run once non-interactively (`-p`):

   ```bash
   pi -p "Use provision_kernel and exec_cell to print 1+1 in a Python cell."
   ```

   Success looks like the cell returning `Out[2]: 2` (or similar) in a few seconds.

3. **Optional — subagent orchestration.** To let cells spawn parallel Pi subagents, install the `pi_subagents` stack in a tmux-capable environment (see [Optional dependencies](#optional-dependencies)); everything else works without it. The Python half (`pi_subagents`) is provisioned automatically in the background on first use — provisioning problems are logged to `~/.cache/pi-pycells/subagents-sync.log` and never block the core extension.

To remove: `pi remove git:github.com/Quinntyx/pi-pycells`.

## Requirements

- **Node.js** and **Pi** (the host agent; tested with pi ≥ 0.87 and Node ≥ 20).
- **[`uv`](https://docs.astral.sh/uv/) — required.** It provisions the Python environment (default CPython 3.14, downloaded automatically if missing) and powers on-demand package installs. You do not need Python on PATH; `PTC_PYTHON_EXECUTABLE` pins a specific interpreter if you want one.
- **Subagent orchestration only:** the terminal multiplexer **tmux** (`tmux -V` to check), a small relay helper called **pi-sock** installed in your normal pi config, and the **pi_subagents** Python module (installed for you at session start). By default, subagents are additional pi instances that run under your own Pi configuration. To use a separate pi agent directory for subagents, set `PI_CODING_SUBAGENT_DIR`.

## Usage

### Python kernels with tool access

Describe the work; the model provisions a kernel and writes the cells:

```text
> Count the TODO comments in every *.ts file under src/ and give me the
> top 5 files as compact JSON only.
```

```python
# the model writes this as an exec_cell call — note what's NOT in your context:
# none of the 200 file contents ever leave the kernel
files = await find('src/**/*.ts')
counts = {f: (await read(f)).count('TODO') for f in files}
sorted(counts.items(), key=lambda kv: -kv[1])[:5]
```

The kernel is bound to a real `.ipynb` notebook — the durable record of the session. The model picks its location (usually your working directory); tell it where to put the notebook if you'd rather have it somewhere else, e.g. "provision the kernel with its notebook in /tmp" for throwaway work. Variables, imports, and definitions persist across cells and conversation turns, and output below a size cap is persisted in full but only summarized to the model.

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

> Paths: this documentation writes `~/.pi/agent` (pi's default agent dir) everywhere. pi honors `PI_CODING_AGENT_DIR`; if you (or pi-profiles) set it, every path below that lives in the agent dir moves with it.

## Optional dependencies

| Dependency | What it provides | Without it |
|---|---|---|
| `uv` | Preferred for creating the shared venv (`~/.cache/pi-pycells/python-env`) and for `provision_dependency` installs. | Venv creation falls back to `python3 -m venv`; `provision_dependency` fails (no pip fallback) — pre-install packages into the venv yourself. |
| `pi_subagents` + tmux + `pi-sock` | The subagent orchestration stack (`import pi_subagents` in cells; one tmux window per agent). `pi_subagents` is auto-provisioned at session start from git (see `PTC_SUBAGENTS_REPO_URL` / `PTC_SUBAGENTS_SOURCE`). By default, subagents run under your own Pi configuration; `PI_CODING_SUBAGENT_DIR` gives them a separate pi agent directory. | All core features work untouched; only `import pi_subagents` is unavailable (provisioning failure is a logged warning, never fatal). |
| pi-tool-tree *(experimental)* | Nicer subagent activity display and tool-call activity labels. Currently unstable — known rendering bugs. | Plain rendering; the subagent panel, timers, and the vendored shimmer animation all work without it — you only lose live agent activity labels. |

Note: once the shared venv exists, every kernel prefers it over `python3`; set `PTC_PYTHON_EXECUTABLE` to pin your own interpreter.

## Documentation

The docs above cover day-to-day use. For full detail:

- **[DOCS.md](DOCS.md)** — the complete reference: all features, configuration table, optional dependencies, standalone-setup notes.
- **[docs/](docs/)** — one deep-dive per feature: [kernels](docs/kernels.md) · [tool-bridge](docs/tool-bridge.md) · [custom-tools](docs/custom-tools.md) · [output-and-code-view](docs/output-and-code-view.md) · [sandboxing](docs/sandboxing.md) · [auto-routing-and-recovery](docs/auto-routing-and-recovery.md) · [notebook-library](docs/notebook-library.md) · [subagents](docs/subagents.md) · [configuration](docs/configuration.md) (every `PTC_*` env var) · [benchmarks-and-evals](docs/benchmarks-and-evals.md)
- **[docs/FAQ.md](docs/FAQ.md)** — verified install steps, standalone setups, and troubleshooting.

## License

MIT
