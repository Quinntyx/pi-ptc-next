# pi-pycells

`pi-pycells` is an extension for [Pi](https://github.com/earendil-works/pi) that implements Programmatic Tool Calling (PTC): instead of streaming every tool result back into the model's context, the model writes Python cells against a persistent, Jupyter-like kernel and calls Pi's tools (`read`, `grep`, `glob`, …) as ordinary `async` Python functions. Only each cell's final output reaches the model, so multi-step work costs a fraction of the tokens. The same kernels double as launch pads for parallel subagent orchestration (optional; see below).

Fork of [`edxeth/pi-ptc-next`](https://github.com/edxeth/pi-ptc-next), which itself forked [`cegersdoerfer/pi-ptc`](https://github.com/cegersdoerfer/pi-ptc) by Chris Egersdoerfer.

## Install


> **⚠️ Yolo mode — no sandbox.** Pi itself runs tools with your full permissions, and so do these Python kernels: plain processes with full file/network access, nothing sandboxed or gated (cells can even run shell commands natively). Sandboxing is planned (VM-based checkpointing) but not implemented. Don't point it at untrusted code.

**Before you start:** make sure plain `pi` answers a normal prompt (run `pi -p "hi"` once; if it errors with auth/quota JSON, run `/login` in `pi` and get a working model first — nothing here works until that does). You'll also need **[`uv`](https://docs.astral.sh/uv/)** — required; it provisions the Python environment (CPython 3.14 by default, downloaded for you if missing) — and `git`.

1. **Install the extension into Pi:**

   ```bash
   pi install git:github.com/Quinntyx/pi-pycells
   ```

   Pi downloads the extension into its own folder (`~/.pi/agent/git/github.com/Quinntyx/pi-pycells` by default) and runs `npm install` there; it usually takes under a minute. For local development, `pi install /path/to/repo` loads a checkout in place instead of cloning.

> **Skills installed by the plugin:** the extension bundles two pi skills — `pycells-library` (teaches the agent to discover, run, and contribute notebook-library workflows) and `pi-subagents` (the full subagent-orchestration reference). They land in your agent dir with the plugin and are listed by pi's skill discovery.

> Paths: this documentation writes `~/.pi/agent` (pi's default agent dir) everywhere. Pi honors `PI_CODING_AGENT_DIR`; if you (or pi-profiles) set it, every path below that lives in the agent dir moves with it.

2. **Verify it works.** Start `pi` and describe a PTC-shaped task, or run once non-interactively (`-p`):

   ```bash
   pi -p "Use provision_kernel and exec_cell to print 1+1 in a Python cell."
   ```

   Success looks like the cell returning `Out[2]: 2` (or similar) in a few seconds.

3. **Optional — subagent orchestration.** To let cells spawn parallel Pi subagents, install the `pi_subagents` stack in a tmux-capable environment (see [Optional dependencies](#optional-dependencies) for the pieces); everything else works without it. Subagents share your Pi configuration by default, and can get their own via `PI_CODING_SUBAGENT_DIR` (see the subagents section below). The Python half (`pi_subagents`) is provisioned automatically: **every time pi starts** with the extension loaded, a background job installs it into the shared Python venv (from the public GitHub mirror) — whether or not you ever use subagents. It's a one-time setup (re-checked daily after that), problems are logged to `~/.cache/pi-pycells/subagents-sync.log` with a single `[PTC]` startup warning, and they never block the core extension.

To remove: `pi remove git:github.com/Quinntyx/pi-pycells`.

## Requirements

- **Node.js** and **Pi** (the host agent; tested with pi ≥ 0.87 and Node ≥ 20).
- **[`uv`](https://docs.astral.sh/uv/) — required.** It provisions the Python environment (default CPython 3.14, downloaded automatically if missing) and powers on-demand package installs. You do not need Python on PATH; `PTC_PYTHON_EXECUTABLE` pins a specific interpreter if you want one.
- **Subagent orchestration only:** [tmux](https://github.com/tmux/tmux) (the terminal multiplexer; `tmux -V` to check), [pi-sock](https://github.com/Quinntyx/pi-sock) — a small relay helper installed in your normal pi config — and the [pi_subagents](https://github.com/Quinntyx/pi-subagents) Python module (installed for you at session start). By default, subagents are additional pi instances that run under your own Pi configuration. To give subagents their own pi agent directory, set `PI_CODING_SUBAGENT_DIR` — [`pi-profiles`](https://github.com/chaychoong/pi-profiles) is the easiest way to create and manage those — one command per profile, each an isolated pi config.

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

The kernel is bound to a real `.ipynb` notebook — the durable record of the session. By default the notebook is created under `/tmp/pi-pycells/notebooks/` — throwaway kernels shouldn't litter your project. Any notebook can be promoted to the library later, regardless of where it lives; pass an explicit notebook path when you want the file itself kept with the project. Variables, imports, and definitions persist across cells and conversation turns. Long cell output is always saved in full in the notebook — the model just sees the start and end with the middle cut out, and can page through the full version with `read_cell_output`.

The model picks between its normal tools and a kernel on its own: a one-off lookup stays an ordinary `read`/`grep` call, while anything that means many tool calls in a row (repo-wide scans, bulk conversions, aggregations, "compact JSON only") makes a cell the obvious move. If a cell fails, bounded auto-recovery can retry it with a fix.

More: [docs/kernels.md](docs/kernels.md) (kernel lifecycle), [docs/tool-bridge.md](docs/tool-bridge.md) (calling tools from Python), [docs/auto-routing-and-recovery.md](docs/auto-routing-and-recovery.md).

### Subagent orchestration from a cell

When the optional `pi_subagents` stack is installed (see the table below), kernels can `import pi_subagents` and fan work out to real interactive Pi instances — one tmux window per agent, watchable live while the cell blocks — and steerable mid-run, by you in the window or by the orchestrating model over the pool API:

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

Results come back in completion order, sessions can be reused for follow-ups, and a live progress panel renders in the chat while the cell runs.

**Separate configuration for subagents (optional).** By default, subagents are full pi instances sharing your configuration — same extensions, same tools, same auth. That's the zero-setup path, and for most work it's what you want. You might want a dedicated subagent config when you want subagents to run *less* than you do: a leaner extension set (e.g. pi-sock plus pi-tool-tree only), a different default model, or simply a scratch config you can break freely without touching your daily driver. To do it, set `PI_CODING_SUBAGENT_DIR` to any directory with a pi configuration — [`pi-profiles`](https://github.com/chaychoong/pi-profiles) creates and manages those directories for you (`ppi create subagents`, `ppi use subagents`), and one of its profiles is exactly what `PI_CODING_SUBAGENT_DIR` points at.

More: [docs/subagents.md](docs/subagents.md).

### The notebook library

> [!WARNING]
> **Experimental.** The library and promotion flow is new; expect interface changes.

Every kernel you run is a complete, self-documenting artifact — code, interleaved markdown, captured outputs, and the Python version it ran on. When a workflow works, promote it:

```text
> promote_to_skill_notebook({ name: "todo-scan" })
```

Promoted notebooks land in the library (`~/.pi/agent/pycells-library/`), and any future kernel can start from one:

```python
# provision_kernel({ notebook: "/tmp/work.ipynb", source: "todo-scan" })
# — the sourced setup runs up front; the new kernel inherits the namespace,
# and the first new exec_cell continues where the workflow left off (Out[8], not Out[1])
```

Why this is the good part:

- **Reuse without re-prompting.** A workflow you tuned once (paths, filters, output shapes) becomes a named asset the model starts from instead of rediscovering.
- **Version-pinned recipes.** Each notebook records the Python it ran on; promoted workflows keep running on that interpreter even after you bump defaults.
- **Markdown travels with the code.** Sourced setup executes before your first cell, and the notebook's own notes guide the model through the workflow it contains.
- **The source is never modified.** The new kernel gets a copy whose cells run as prefix cells; the original stays untouched.

More: [docs/notebook-library.md](docs/notebook-library.md).

### Also in the box

- **Live code view** — executed cells render with syntax highlighting and an executing-line marker; `confirm: true` cells show an approval popup before running; Esc or `/ptc interrupt` stops a chunk without killing the kernel.
- **Custom tools** — drop `.js` files into `tools/` with a `ptc:` metadata block and they become callable from Python (hot-reloaded).

More: [docs/output-and-code-view.md](docs/output-and-code-view.md), [docs/custom-tools.md](docs/custom-tools.md).

## Optional dependencies

| Dependency | What it provides | Without it |
|---|---|---|
| [pi_subagents](https://github.com/Quinntyx/pi-subagents) + tmux + [pi-sock](https://github.com/Quinntyx/pi-sock) | The subagent orchestration stack (`import pi_subagents` in cells; one tmux window per agent). The `pi_subagents` module is installed into the shared Python venv automatically at every session start (see `PTC_SUBAGENTS_REPO_URL` / `PTC_SUBAGENTS_SOURCE`). By default, subagents are additional pi instances running under your own Pi configuration; `PI_CODING_SUBAGENT_DIR` gives them a separate pi agent directory. | Everything else works; you just don't get subagents. |
| [pi-tool-tree](https://github.com/Quinntyx/pi-tool-tree) *(experimental)* | Nicer subagent activity display and tool-call activity labels. Currently unstable — known rendering bugs. | Plain rendering; the subagent panel, timers, and the vendored shimmer animation all work without it — you only lose live agent activity labels. |

Note: kernels always run on the shared venv's interpreter; set `PTC_PYTHON_EXECUTABLE` to pin your own.

## Documentation

The docs above cover day-to-day use. For full detail:

- **[DOCS.md](DOCS.md)** — the complete reference: all features, configuration table, optional dependencies, standalone-setup notes.
- **[docs/](docs/)** — one deep-dive per feature: [kernels](docs/kernels.md) · [tool-bridge](docs/tool-bridge.md) · [custom-tools](docs/custom-tools.md) · [output-and-code-view](docs/output-and-code-view.md) · [sandboxing](docs/sandboxing.md) · [auto-routing-and-recovery](docs/auto-routing-and-recovery.md) · [notebook-library](docs/notebook-library.md) · [subagents](docs/subagents.md) · [configuration](docs/configuration.md) (every `PTC_*` env var) · [benchmarks-and-evals](docs/benchmarks-and-evals.md)
- **[docs/FAQ.md](docs/FAQ.md)** — verified install steps, standalone setups, and troubleshooting.

## Roadmap

Done since the fork from [pi-ptc-next](https://github.com/edxeth/pi-ptc-next):

- [x] Persistent notebook-backed kernels with `provision_kernel` / `exec_cell`
- [x] Pi tools callable from Python via the RPC bridge (`read`, `grep`, `find`, …)
- [x] Custom tools from `tools/` with a `ptc:` metadata block
- [x] Subagent orchestration from cells (`pi_subagents`), auto-provisioned
- [x] Notebook library: promote, reuse, and Python-version pinning for promoted workflows
- [x] uv-managed runtime (pinned CPython, on-demand package installs)
- [x] `provision_kernel(version=...)` for explicit interpreter selection
- [x] No-gating yolo mode (removed `PTC_ALLOW_UNSANDBOXED_SUBPROCESS` / `PTC_ALLOW_MUTATIONS` / `PTC_ALLOW_BASH`)
- [x] Subagent agent-dir selection via `PI_CODING_SUBAGENT_DIR` (no pi-profiles dependency)
- [x] Vendored shimmer renderer; theme-aware Shiki highlighting
- [x] `/workflow` command for orchestrated subagent runs

Planned:

- [ ] Sandboxing (VM-based checkpointing)
- [ ] Background / foreground `exec_cell` runs (`/ptc background|foreground`)
- [ ] Bridging third-party extension tools into cells (needs an upstream pi API)
- [ ] `provision_dependency` pip fallback (uv-less environments)
- [ ] Atomic multi-stage `AgentPool.submit_all` (upstream, pi-subagents)

## License

MIT
