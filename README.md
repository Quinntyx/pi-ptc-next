# pi-pycells

A persistent Python notebook runtime for [Pi](https://github.com/earendil-works/pi), with **optional parallel subagent orchestration**. Explore data, author code and markdown cells, rerun a notebook from a clean kernel, and save working notebooks as reusable workflows. Enable the subagent integration to coordinate multiple Pi agents from a cell, with each agent visible in its own tmux window.

Cells run on embedded IPython: imports, variables, and definitions survive across cells and conversation turns, with top-level `await`, Jupyter-style expression output, magics, and rich display output.

> **No sandbox.** Kernels run with your user permissions and full file, network, and subprocess access. Only execute code you trust. An approval prompt is not a security boundary.

## Install

First, make sure Pi can answer a normal prompt and that [`uv`](https://docs.astral.sh/uv/) is on your PATH.

```bash
pi install git:github.com/Quinntyx/pi-pycells
```

For local development, use `pi install /path/to/pi-pycells` instead. Restart Pi after installing, then try:

```bash
pi -p "Create a Python kernel, execute a cell containing 1 + 1, and show the result."
```

To remove the package:

```bash
pi remove git:github.com/Quinntyx/pi-pycells
```

### Requirements

- **Pi and a compatible Node.js runtime.** Follow Pi's current runtime requirements.
- **uv.** Provisions Python environments and installs dependencies. The default interpreter is CPython 3.14; it is downloaded automatically if needed. IPython is provisioned into kernel environments.
- **Subagents only:** `git` and [tmux](https://github.com/tmux/tmux). `pi install` installs and loads [pi-sock](https://github.com/Quinntyx/pi-sock) with pi-pycells; agents using the same Pi configuration inherit it. A separate subagents configuration needs pi-sock installed there too (see below). The `pi_subagents` Python module is provisioned when subagents are enabled.

The package includes three skills: **notebook-workflow** for authoring and handover, **pycells-library** for reusable notebooks, and **pi-subagents** for orchestration.

## Notebook workflow

Describe the artifact you need:

```text
Analyze data/events.json and create analysis.ipynb with a summary chart,
markdown explaining the findings, and cells that run top-to-bottom.
```

Pi provisions a kernel once, explores with scratch cells, then writes and runs notebook cells individually. A typical tool sequence is:

```text
provision_kernel({ notebook: "analysis.ipynb" })
# Use the session_id returned by provision_kernel in subsequent calls.

write_cell({ session_id, at: 1, type: "markdown", source: "# Event analysis" })
write_cell({ session_id, at: 2, source: "from pathlib import Path\nimport json\nrows = json.loads(Path('data/events.json').read_text())\nlen(rows)" })
run_cell({ session_id, n: 2 })
```

Use ordinary Python libraries inside cells. For example, `pathlib` handles files, pandas handles tabular data, and matplotlib produces plots. Use Pi's normal tools separately for host-side work.

### Choosing an operation

| Tool | Purpose |
|---|---|
| `provision_kernel` | Start a persistent kernel bound to a notebook. Accepts an optional source workflow and Python version. |
| `scratch_run` | Explore in the live namespace without recording a notebook cell. |
| `write_cell` | Add or replace a code or markdown cell without executing it. Replacing a cell clears its stored outputs. |
| `run_cell` | Execute an existing code cell and refresh its outputs. The usual loop is **write one cell, run one cell**. |
| `exec_cell` | Execute proven code and append it as a new cell; also accepts a Python file. |
| `request_cell_review` | Preview code, a file, or a saved cell for user review without executing it. |
| `read_cells` / `read_cell` / `delete_cell` | Inspect and curate the notebook document. |
| `reset_kernel` | Restart the interpreter with an empty namespace, leaving the notebook intact. |
| `run_to` / `run_all` | Execute through a chosen position or the whole notebook, stopping at the first error. |
| `list_kernels` / `inspect_kernel` | Discover live kernels and inspect their namespaces. |
| `read_cell_output` | Page through a cell's full persisted output. |
| `provision_dependency` | Install a Python distribution into a kernel's environment. |

**Notebook positions and execution counts are different.** Editing a cell does not update the live namespace or rerun dependent cells. Before handing over a notebook, reset the kernel and run all cells to check it from a clean state.

Every recorded execution updates the standard `.ipynb` on disk, including outputs and errors. Open it in Jupyter or an editor at any time. Omit `notebook` for throwaway work: the destination is reported under `/tmp/pi-pycells/notebooks/`. Use an explicit project path for an artifact worth keeping.

### Output and rendering

- Syntax-highlighted **In** boxes and numbered **Out** boxes render cells in the terminal.
- Live output streams below the executing cell; long output shows a preview while the full result stays in the notebook.
- Rich display output, including images, is captured in the notebook.
- `request_cell_review` asks the user to review an operation; execution is a separate call. **Esc** interrupts a running cell without disposing the kernel.

More: [kernels and document operations](docs/kernels.md).

## Reusable notebook library

> **Experimental:** the library and promotion interface may change.

Promote a finished notebook with `promote_to_skill_notebook({ name: "event-analysis" })`. Promotion copies code, markdown, outputs, and metadata into the library; it does not modify the source notebook. Existing entries are only replaced with explicit overwrite permission.

Start future work with `provision_kernel({ source: "event-analysis", notebook: "next-analysis.ipynb" })`. The source is copied and its code cells run before new work begins. Notebooks retain their recorded Python version, with an explicit `version` override available when provisioning.

The default library is `~/.pi/agent/pycells-library/`. Pi honors `PI_CODING_AGENT_DIR`, so the agent-directory path follows your configuration.

More: [notebook library](docs/notebook-library.md).

## Optional subagent orchestration

Enable subagents before starting Pi:

```bash
export PI_SUBAGENTS_MAX_CONCURRENT=8
pi
```

The positive value caps concurrency and enables background provisioning of `pi_subagents` into the shared Python environment. Without it, notebook work still functions and no subagent module is downloaded.

Cells can import `pi_subagents`, create an `AgentPool`, submit tasks to stages, and collect results in completion order. Each agent is a real Pi instance in a tmux window, visible and steerable while it works. Keep constants/prompts, task construction/data flow, and teardown in separate recorded cells. Failures raise at handle waits or `pool.pop()`; inspect the surviving pool before continuing. A dedicated `pool.close()` cell disposes the agent windows and reports the pool summary.

### Default configuration

Agents share your current Pi configuration by default. Installing pi-pycells also installs and loads **pi-sock** (agent communication) and **pi-activity** (activity tracking API). No separate installation is needed in this case, and **pi-tool-tree is not required**. If your configuration already loads standalone copies of these extensions, disable those copies with `pi config` to avoid duplicate loading; keep the copies supplied by pi-pycells enabled.

### Separate subagents configuration

Set `PI_CODING_SUBAGENT_DIR` to a separate Pi agent directory for a leaner extension set or a different default model. **That configuration must load pi-sock and pi-activity** to provide agent communication and activity snapshots: installing pi-pycells in the main configuration does not install extensions into a separate profile. For an existing standalone subagents configuration, install both there:

```bash
# Replace this path with your subagents profile's Pi agent directory.
PI_CODING_AGENT_DIR=/path/to/subagents pi install git:github.com/Quinntyx/pi-sock
PI_CODING_AGENT_DIR=/path/to/subagents pi install git:git.quinntyx.dev/quinntyx/pi-activity
export PI_CODING_SUBAGENT_DIR=/path/to/subagents
```

If pi-pycells is installed in that configuration too, it already supplies both extensions; you do not need the separate installs. Make sure the selected configuration has working model credentials. Unless you explicitly select a model, agents use that configuration's default; [pi-profiles](https://github.com/chaychoong/pi-profiles) can manage these directories but is not required.

### Activity API

[pi-activity](https://git.quinntyx.dev/quinntyx/pi-activity) is a bundled, API-only dependency: it does not replace Pi's renderers. Pi-pycells loads it before registering its tools. Other extensions can query the stable API directly:

```js
const activity = globalThis[Symbol.for("pi-activity:api")];
const snapshot = activity?.getActivity();
```

For a subagent, `handle.activity()` retrieves its activity snapshot through pi-sock. Activity snapshots expose the current phase, label, running calls, and timing data. Label assignment is owned by pi-activity and may evolve; consumers should use the API rather than infer activities from tool names, prose, or rendering. See the [activity API reference](https://git.quinntyx.dev/quinntyx/pi-activity/src/branch/main/API.md).

More: [subagent setup](docs/subagents.md) and the bundled [pi-subagents skill](skills/pi-subagents/SKILL.md).

## Documentation

- [Notebook workflow skill](skills/notebook-workflow/SKILL.md): cell discipline, markdown narrative, and clean-kernel handover.
- [Kernels](docs/kernels.md): lifecycle, IPython semantics, document operations, and interrupts.
- [Notebook library](docs/notebook-library.md): promotion, sourcing, and version pinning.
- [Subagents](docs/subagents.md): provisioning and orchestration setup.
- [Configuration](docs/configuration.md): runtime and environment settings.

Some configuration names and older reference pages retain terminology from the original tool-calling extension. This README describes the notebook-focused workflow.

## Credits and license

Derived from [edxeth/pi-ptc-next](https://github.com/edxeth/pi-ptc-next), itself a fork of [cegersdoerfer/pi-ptc](https://github.com/cegersdoerfer/pi-ptc) by Chris Egersdoerfer.

MIT
