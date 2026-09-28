# The PTC notebook library

The PTC notebook library is a directory of reusable, self-documenting Python workflow notebooks that the extension maintains for you. After a successful nontrivial workflow you can promote the kernel's live `.ipynb` — with its interleaved markdown, code, and captured outputs — into the library, and later start a new kernel from any library workflow by passing `source` to `provision_kernel`. The sourced cells are copied to your working notebook and executed up front, so the new kernel inherits the workflow's setup and its markdown guidance without the original file ever being modified.

## How it works

**Library location.** `resolveLibraryDir()` (`src/python-session-manager.ts:991-1005`) resolves the library directory in this order:

1. The `libraryDir` field of `PtcSettings` — but note that this field is never populated from a settings file; the extension's settings are loaded purely from environment variables (`loadSettingsFromEnv()`, `src/utils.ts:63`), and it does not set `libraryDir`. It only matters for programmatic/SDK callers. For interactive use, the effective user-facing override is the next item.
2. The `PTC_LIBRARY_DIR` environment variable (a leading `~` is expanded to your home directory).
3. Otherwise: `<PI_CODING_AGENT_DIR>/ptc-library`, where `PI_CODING_AGENT_DIR` defaults to `~/.pi/agent` — i.e. `~/.pi/agent/ptc-library` on a default install.

The directory does not need to exist in advance; promotion creates it with `mkdir -p` semantics (`src/python-session-manager.ts:1437`).

**Starting from a workflow (`source` in `provision_kernel`).** `resolveSourcePath()` (`src/python-session-manager.ts:1007-1027`) resolves the `source` argument:

- A **bare name** (no path separators) is looked up in the library directory: `<name>.ipynb` is tried before `<name>.py`. If the name already has an extension, only that exact filename is tried. If nothing matches in the library, the name falls back to a path relative to the kernel's cwd.
- A **relative path** resolves against the cwd; an **absolute path** passes through unchanged.

`prepareSource()` (`src/python-session-manager.ts:1029-1077`) then:

- Rejects anything that is not `.ipynb` or `.py`.
- Rejects a source identical to the destination notebook — the source is only ever read and copied, never modified.
- For a `.ipynb` source: copies the file verbatim to the destination notebook (so interleaved markdown, code, and prior outputs all carry over) and records every cell in the prefix numbering range. Markdown cells are *not* executed; the source's code cells are executed in order as prefix cells, each recorded in the copy with fresh outputs. With a 7-cell source (any cell type), the first new `exec_cell` you run is cell 8 (`prefixCellCount`/`prefixChunkCount`, `src/python-session-manager.ts:893-905`, `1160-1180`).
- For a `.py` source: writes an empty notebook to the destination and executes the whole file as one virtual prefix cell (`prefixCellCount: 1`).

If a source cell fails during provisioning, the error is recorded on that prefix cell (with traceback when available) and the kernel remains usable — you can fix and continue in the live namespace (`src/index.ts:1059-1063`). Because sourced setup has already run, the model is instructed to build on the inherited namespace rather than re-import or redefine it (`skills/ptc-library/SKILL.md:10`).

**Contributing back (`promote_to_skill_notebook`).** The host tool (`src/index.ts:349-355`, `425-461`; `promoteToSkillNotebook` at `src/python-session-manager.ts:1378-1454`):

- Picks the source notebook: an explicit `notebookPath`, or by default the most recently used, still-alive notebook-backed session's notebook. With no notebook-backed session it errors instead of guessing.
- Waits on that session's exec queue first, so an in-flight cell finishes before the copy is taken.
- Re-parses the notebook on disk to confirm it is a valid notebook document.
- Sanitizes the `name`: `.ipynb` suffix stripped, NFKD-normalized, lowercased, non-`[a-z0-9]` runs collapsed to `-`, leading/trailing hyphens trimmed (`sanitizeSkillNotebookName`, `src/python-session-manager.ts:817-825`). The result is copied to `<libraryDir>/<name>.ipynb`.
- Refuses to overwrite: an existing target raises an error unless you pass `overwrite: true`. The refusal is enforced twice — a host-side pre-check and a `COPYFILE_EXCL` copy, so an existing library notebook is never silently replaced even under a race.

The copy is complete: markdown, code cells, and outputs all survive, which is what makes the promoted notebook a self-describing recipe for the next run.

**Python version pinning.** A kernel stamps the interpreter version into its notebook's `metadata.language_info.version` (standard Jupyter field) **on first run only** — the pin records the version the notebook was born on, its "original/intended" version. Later runs on a different version never overwrite it.

- `provision_kernel({ source })` honors the pin: if it differs from the shared venv, a dedicated uv venv (`~/.cache/pi-pycells/python-env-<X.Y>`) is provisioned and the kernel runs on it. When the default bumps (say 3.14 → 3.15), older promoted workflows keep running on the interpreter they were recorded with instead of silently breaking.
- `provision_kernel({ version: "3.15" })` overrides the pin **without mutating metadata** — ideal for "verify my ptc skills work on 3.15" style runs. The explicit version must be a plain Python version string (3.14, 3.14.4, 3.15.0b1); anything else is rejected before it reaches uv.

**Legacy export.** `PythonSessionManager.toScript()` (`src/python-session-manager.ts:1457-1516`) still exists as an AST-aware `.py` export with a host-side overwrite guard that appends `-2`, `-3`, … to avoid collisions (default directory `.pi/scripts`, relative to the caller's cwd). For library reuse, notebook promotion is preferred.

## Usage

Discover what is available, then start a kernel from a workflow:

```bash
ls ~/.pi/agent/ptc-library/
# code-review.ipynb  tmux-orchestration.ipynb  fetch-and-chart.py
```

```text
provision_kernel({ notebook: "/tmp/work.ipynb", source: "code-review" })
# Sourced from /home/you/.pi/agent/ptc-library/code-review.ipynb.
# The copied markdown guidance and already-executed setup are in the notebook;
# continue with exec_cell in the inherited namespace.
```

After a successful run worth keeping, polish the notebook's markdown and promote it:

```text
promote_to_skill_notebook({ name: "My Review Workflow!" })
# Promoted /tmp/work.ipynb to library notebook my-review-workflow at
# /home/you/.pi/agent/ptc-library/my-review-workflow.ipynb.
```

Re-promoting over an existing name requires explicit consent:

```text
promote_to_skill_notebook({ name: "my-review-workflow", overwrite: true })
# without overwrite: true → "library notebook already exists: …; pass overwrite: true to replace it"
```

Policy (from `skills/ptc-library/SKILL.md`): promote reusable, pre-approved approaches — not one-off scratch work, and never notebooks containing secrets. Promoted notebooks persist in a directory you control and may contain data from your sessions.

## Options / Configuration

| Setting | Meaning | Default |
|---|---|---|
| `PTC_LIBRARY_DIR` (env) | Library directory; `~` is expanded. Takes precedence over the agent-dir default. | unset |
| `PI_CODING_AGENT_DIR` (env) | pi's agent directory; the library lives at `<agentDir>/ptc-library` when `PTC_LIBRARY_DIR` is unset. | `~/.pi/agent` |
| `libraryDir` (`PtcSettings` field, `src/contracts/settings.ts:21`) | Programmatic-only override; *not* read from any settings file, so interactive users should use `PTC_LIBRARY_DIR`. | unset |
| `promote_to_skill_notebook.overwrite` | Allow replacing an existing library notebook of the same sanitized name. | `false` |

There is no dedicated settings file for this feature: the extension loads its settings from environment variables only (`src/utils.ts:63-97`).

## Standalone setup notes

Everything in the library feature itself resolves from environment variables and pi's agent-dir convention — the source contains no author-specific absolute paths, private URLs, or profile names for this feature. Things to know on a machine without the author's setup:

- **Library defaults to `~/.pi/agent/ptc-library`.** This assumes pi's standard agent-dir layout (`$PI_CODING_AGENT_DIR` else `~/.pi/agent`). If your pi data lives elsewhere, set `PI_CODING_AGENT_DIR`, or point `PTC_LIBRARY_DIR` directly at whatever directory you want (any path; `~` expansion supported). Bare-name `source` lookups only see files sitting directly in that resolved directory.
- **No env var set and non-standard pi install?** The library is simply `~/.pi/agent/ptc-library`; create it and drop `.ipynb` (or `.py`) files in, or set `PTC_LIBRARY_DIR` per-shell. The bundled `ptc-library` skill teaches the model to `ls` these same locations, so keeping the directory in one of the default spots makes discovery automatic.
- **Empty library = bare names don't resolve.** A bare `source` that matches nothing in the library silently falls back to being treated as a cwd-relative path (`src/python-session-manager.ts:1022-1024`), which will then fail as a missing file. If you get "could not read source", check whether the name actually exists in your resolved library directory.
- **Promotion needs a notebook-backed kernel.** `promote_to_skill_notebook` without `notebookPath` uses the most recently used live notebook-backed session. Since `provision_kernel` *requires* a `.ipynb` destination, this is normally satisfied — but if the notebook-backed session was killed, pass `notebookPath` explicitly. The source must be a `.ipynb`; `.py` sessions cannot be promoted as notebooks.
- **Multi-kernel caveat.** `read_cell_output` reads from the most recently used notebook-backed kernel's `.ipynb` (`src/index.ts:392-399`); with several kernels alive, a `cellIdx` may belong to a different kernel's notebook than the one you just executed in. Prefer one notebook-backed kernel per workflow.
- **Related but separate hardcoding.** The library code is clean, but other parts of this extension do carry machine-specific defaults (e.g. the `pi-subagents` integration assumes a tmux session with a profile named `subagents`, a private default git repo URL, and a `~/docs/src/pi-subagents` dev-checkout layout — see `README.md`'s "pi-subagents" section). Workflows you promote that *use* `pi_subagents` will embed those assumptions in the notebook, so review a sourced workflow's cells before running it on a machine without that setup.
