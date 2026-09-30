"""Persistent PTC session runtime — a headless Jupyter-like kernel.

Unlike the one-shot combined script (rpc + wrappers + runtime + user_main), a
persistent session keeps one interpreter alive for many cells. The host sends
JSONL frames on stdin:

    {"type": "exec", "id": "exec_1", "code": "...", "user_code_line_count": N,
     "notebook": "/path/to/notebook.ipynb",          # live notebook artifact
     "source_path": "/path/to/cell.py",                # optional file mode
     "target_cell_index": 2,                            # run_cell: replace this cell
     "append": true,                                    # false for scratch_run
     "source_cell_index": 1}                            # sourcing: position-based
    {"type": "inspect", "id": "inspect_1"}
    {"type": "doc", "id": "doc_1", "op": "write_cell", "at": 2, "source": "...",
     "cell_type": "code"}                              # or delete_cell/read_cells/read_cell
    {"type": "export_script", "id": "export_1", "path": "...", "cells": ["..."]}

and the runtime answers:

    {"type": "exec_done", "id": ..., "output": ..., "images": [...],
     "total_output_chars": N, "cell": N, "digest": {...}}
    {"type": "exec_error", "id": ..., "message": ..., "traceback": "..."}
    {"type": "kernel_inspected", "id": ..., "digest": {...}}
    {"type": "doc_done", "id": ..., "op": ..., "total": N, "cells": [...]}
    {"type": "doc_error", "id": ..., "op": ..., "message": ...}
    {"type": "script_exported", "id": ..., "path": ..., "cells": N, "wrapped_async": bool}

interspersed with the usual execution_progress / stdout frames, plus
{"type": "subagent_state", "snapshot": {...}} frames emitted by the
pi_subagents bridge and {"type": "session_ready"} once the loop is live.

Kernel semantics:

- Cells run on one embedded IPython ``InteractiveShell`` whose user namespace
  IS this script's globals: one persistent namespace, native top-level ``await``,
  ``In[n]``/``Out[n]`` history, and real magics. There is no per-cell function
  wrapper, no locals merge, and no trailing-expression rewrite.
- A trailing bare expression is echoed by IPython's displayhook and travels as
  the frame's ``echo`` field; its ``Out[n]`` lines up with the notebook's
  execution_count.
- Top-level ``return`` is kept for compatibility via a small AST transformer: it
  becomes a private ``_PtcReturn`` signal that stops the cell early without
  copying the namespace.
- Magics (``%time``, ``%%capture``, ``%pip`` ...) and ``!`` shell escapes are
  executed by IPython instead of being rejected.
- Completed cells — including errored and interrupted ones — are appended to the
  live .ipynb artifact and the file is rewritten atomically.
- File mode executes a file's contents inside this kernel (IPython %run
  semantics); tracebacks map to the real file path.
"""

import ast as _ptc_ast
import builtins as _ptc_builtins

# The subagent bridge: pi_subagents detects PTC_STATE_EMIT in builtins and
# forwards its runtime snapshots through the RPC pipe as subagent_state frames.
_ptc_builtins.PTC_STATE_EMIT = lambda snapshot: _emit_protocol({
    "type": "subagent_state",
    "snapshot": snapshot,
})

_cell_counter = 0
# Live notebook artifact: provision_kernel passes the .ipynb path on every exec
# frame; completed cells (including errored ones) are appended and the file is
# rewritten atomically. Magic-rejected and approval-rejected cells never reach
# the runtime, so they never pollute the notebook.
_ptc_notebook_path = None
# Per-cell JSON fragments (serialized once at append time). The notebook file is
# rebuilt by concatenating these cached fragments instead of re-serializing the
# whole cells list on every completed cell, which was O(n^2) CPU over a session.
_ptc_notebook_cell_fragments = []
# The document text last written to disk: a rebuild that yields identical bytes
# (e.g. a duplicate completion for the same cell) skips the file rewrite.
_ptc_notebook_last_document = None
# (mtime_ns, size) of the notebook as this kernel last saw it; a mismatch means
# another writer (Jupyter, an editor) changed the file and it must be re-read.
_ptc_notebook_stat_value = None
# Preserve source notebook-level metadata/version while cells are re-rendered.
_ptc_notebook_metadata = {}
_ptc_notebook_nbformat = 4
_ptc_notebook_nbformat_minor = 5
# Pre-first-cell namespace fingerprint: the baseline that separates runtime
# plumbing from user-created state in digests and inspect_kernel.
_ptc_baseline = None
# Names injected by the runtime/prelude that are plumbing, not user state.
# IPython adds its own namespace entries (In/Out/exit/quit/get_ipython/open) when
# the shell is created; they are also captured by the pre-first-cell baseline, but
# listing them here keeps digests clean even if the baseline is missing.
_PTC_DIGEST_SKIP_NAMES = {
    "ptc", "PTC_MODE", "subagents_autoimport_note",
    "In", "Out", "exit", "quit", "get_ipython", "open", "input",
}
# The embedded IPython shell (created lazily by _ptc_setup_ipython).
_PTC_SHELL = None
# The filename the shell should compile the current cell as (set per exec; the
# runtime tracer matches this to report progress for user frames only).
_PTC_ACTIVE_FILENAME = None
_PTC_PENDING_FILENAME = None
# The chunk currently executing, so a SIGINT can cancel it without killing the
# session (Ctrl-C semantics: stop the chunk, keep the interpreter interactive).
_ptc_current_chunk_task = None
_ptc_loop = None


def _ptc_blocked_input(*_args, **_kwargs):
    """Replace builtin ``input`` inside the kernel: stdin is the RPC pipe, so a
    read would steal protocol frames and hang. Fail fast with a clear hint."""
    raise RuntimeError(
        "input() is not available in the PTC kernel: stdin carries the host RPC "
        "protocol. Pass data as function arguments, or read it with "
        "read(path=...) / ptc.read_text(...)."
    )


class _PtcReturn(BaseException):
    """Signal raised by a rewritten top-level ``return`` to stop the cell early.

    Subclasses BaseException so user ``except Exception`` handlers do not swallow
    it. IPython's run_code catches it via ``shell.custom_exceptions`` and stores
    it on the ExecutionResult, so _ptc_exec_chunk can recover the value.
    """

    def __init__(self, value=None):
        self.value = value
        super().__init__(value)


class _PtcReturnTransformer(_ptc_ast.NodeTransformer):
    """Rewrite cell-level ``return`` into ``raise _PtcReturn(...)``.

    Only returns outside any function/lambda scope are touched, so the
    compatibility shim never changes ordinary function bodies. Raising rather
    than merging locals keeps the single shared namespace intact: nothing is
    copied or restored.
    """

    def __init__(self):
        self._depth = 0

    def _visit_scope(self, node):
        self._depth += 1
        try:
            return self.generic_visit(node)
        finally:
            self._depth -= 1

    visit_FunctionDef = _visit_scope
    visit_AsyncFunctionDef = _visit_scope
    visit_Lambda = _visit_scope

    def visit_Return(self, node):
        if self._depth:
            return node
        value = node.value if node.value is not None else _ptc_ast.Constant(value=None)
        raised = _ptc_ast.Raise(
            exc=_ptc_ast.Call(
                func=_ptc_ast.Name(id="_PtcReturn", ctx=_ptc_ast.Load()),
                args=[value],
                keywords=[],
            ),
            cause=None,
        )
        _ptc_ast.copy_location(raised, node)
        _ptc_ast.fix_missing_locations(raised)
        return raised


def _ptc_setup_ipython():
    """Create (once) the embedded IPython shell that executes cells.

    The shell's user namespace is this module's globals, so tool wrappers, the
    ``ptc`` helpers and the lazy ``np``/``pd``/``plt`` proxies are visible to
    cells and everything a cell defines persists for the next one. The display
    hook is silenced (the host owns the output sections); tracebacks and syntax
    errors are formatted by the runtime, not printed by IPython; history is
    disabled so a long-lived daemon never touches ~/.ipython.
    """
    global _PTC_SHELL
    if _PTC_SHELL is not None:
        return _PTC_SHELL

    import linecache as _ptc_linecache
    from IPython.core.display_trap import DisplayTrap
    from IPython.core.displayhook import DisplayHook
    from IPython.core.interactiveshell import InteractiveShell

    # __name__ is "__main__" for the -c combined script; fall back to the
    # globals' own module if the script is executed from a file.
    user_module = _ptc_sys.modules.get(__name__)
    shell = InteractiveShell.instance(user_module=user_module, user_ns=globals())
    shell.autocall = 0
    try:
        shell.history_manager.enabled = False
    except Exception:
        pass
    # IPython would otherwise print tracebacks/syntax errors on their own; the
    # runtime formats them into the exec_error frame instead.
    shell.showtraceback = lambda *a, **k: None
    shell.showsyntaxerror = lambda *a, **k: None
    shell.showindentationerror = lambda *a, **k: None
    shell.CustomTB = lambda *a, **k: None

    # Top-level return (compatibility shim): the transformer emits _PtcReturn and
    # IPython's run_code hands it back on the result instead of erroring.
    shell.custom_exceptions = tuple(shell.custom_exceptions) + (_PtcReturn,)
    shell.ast_transformers.append(_PtcReturnTransformer())

    class _PtcDisplayHook(DisplayHook):
        """Silence the printed ``Out[n]:`` prompt; keep the computed text/plain
        bundle so the frame can carry the echo (no string rewriting here)."""

        last_format = None

        def write_output_prompt(self):
            return None

        def write_format_data(self, format_dict, md_dict=None):
            self.last_format = dict(format_dict or {})

    shell.displayhook = _PtcDisplayHook(shell=shell)
    # init_displayhook() built the trap around the ORIGINAL hook, so rebuild it.
    shell.display_trap = DisplayTrap(hook=shell.displayhook)

    # A cell that calls sys.exit()/exit() is a normal cell error; IPython's
    # interactive hint is noise on the host's stderr in a daemon kernel.
    import warnings as _ptc_warnings

    _ptc_warnings.filterwarnings("ignore", message=r"To exit: use 'exit'")

    # Give every cell the filename the runtime wants (file mode: the real path)
    # and register its source with linecache so tracebacks can show it.
    original_cache = shell.compile.cache

    def _ptc_cache(code, number=0, raw_code=None):
        name = _PTC_PENDING_FILENAME
        if name is None:
            return original_cache(code, number, raw_code=raw_code)
        _ptc_linecache.cache[name] = (len(code), None, code.splitlines(True), name)
        return name

    shell.compile.cache = _ptc_cache

    # input() must not consume RPC frames.
    shell.user_ns["input"] = _ptc_blocked_input

    _PTC_SHELL = shell
    return shell


async def _ptc_run_shell_cell(shell, code: str, cell_name: str, exec_count: int):
    """Run one cell on the embedded shell with capture_output.

    Returns ``(result, cap.outputs, echo_text)``. stdout is intentionally NOT
    captured here: the session keeps ``_stdout_proxy`` installed so complete
    lines still stream to the host, while capture_output collects the rich
    display outputs (e.g. ``display(...)`` calls). The trailing expression's
    text/plain comes from the silenced displayhook.
    """
    global _PTC_PENDING_FILENAME, _PTC_ACTIVE_FILENAME

    from IPython.utils.capture import capture_output

    try:
        transformed = shell.transform_cell(code)
        preprocessing = None
    except Exception:
        transformed = code
        preprocessing = _ptc_sys.exc_info()

    _PTC_PENDING_FILENAME = cell_name
    _PTC_ACTIVE_FILENAME = cell_name
    # run_cell_async increments execution_count when store_history=True; seed it
    # so In[n]/Out[n] equal the notebook's execution_count.
    shell.execution_count = max(0, exec_count - 1)
    shell.displayhook.last_format = None
    try:
        with capture_output(stdout=False, stderr=False, display=True) as captured:
            result = await shell.run_cell_async(
                code,
                store_history=True,
                transformed_cell=transformed,
                preprocessing_exc_tuple=preprocessing,
            )
        outputs = list(captured.outputs)
    finally:
        _PTC_PENDING_FILENAME = None
        _PTC_ACTIVE_FILENAME = None
        shell.execution_count = exec_count
    fmt = getattr(shell.displayhook, "last_format", None) or {}
    echo_text = fmt.get("text/plain")
    return result, outputs, (str(echo_text) if echo_text is not None else None)


def _ptc_stmt_has_top_level_await(node) -> bool:
    """True when the statement contains await/async-for/async-with outside any
    nested function or lambda scope. Used by script export to decide the
    async-def wrapping of the standalone script (the live kernel defers to
    IPython's own await handling)."""
    if isinstance(node, (_ptc_ast.Await, _ptc_ast.AsyncFor, _ptc_ast.AsyncWith)):
        return True
    for child in _ptc_ast.iter_child_nodes(node):
        if isinstance(child, (_ptc_ast.FunctionDef, _ptc_ast.AsyncFunctionDef, _ptc_ast.Lambda)):
            continue
        if _ptc_stmt_has_top_level_await(child):
            return True
    return False


def _ptc_preview_value(value) -> str:
    """Short type/shape summary for inspect_kernel's var list, e.g.
    "DataFrame 10×3" or "list(42)"; falls back to the bare type name."""
    kind = type(value).__name__
    try:
        shape = getattr(value, "shape", None)
        if shape is not None:
            dims = "×".join(str(int(d)) for d in shape)
            return f"{kind} {dims}" if dims else kind
        if isinstance(value, (str, list, tuple, set, frozenset, dict, bytes)):
            return f"{kind}({len(value)})"
    except Exception:
        pass
    return kind


def _ptc_namespace_fingerprint() -> dict:
    """name -> id(value) for user-visible namespace bindings (plumbing skipped)."""
    return {
        key: id(value)
        for key, value in globals().items()
        if not key.startswith("_")
        and not key.startswith("PTC_")
        and key not in _PTC_DIGEST_SKIP_NAMES
    }


def _ptc_kernel_state(baseline: dict | None) -> dict:
    """Structured snapshot of the user-created namespace (inspect_kernel).

    ``baseline`` is the pre-first-cell fingerprint: everything it contains is
    runtime plumbing (tool wrappers, lazy module proxies), not user state. A
    baseline name whose value was rebound counts as user state.
    """
    import types as _ptc_types

    def _is_user(key: str, value) -> bool:
        if baseline is None:
            return True
        return key not in baseline or baseline[key] != id(value)

    imports, defs, classes, variables = [], [], [], []
    for key, value in sorted(globals().items()):
        if (
            key.startswith("_")
            or key.startswith("PTC_")
            or key in _PTC_DIGEST_SKIP_NAMES
        ):
            continue
        if not _is_user(key, value):
            continue
        if isinstance(value, _ptc_types.ModuleType):
            imports.append({"name": key, "module": getattr(value, "__name__", key)})
        elif isinstance(value, _ptc_types.FunctionType):
            defs.append(key)
        elif isinstance(value, type):
            classes.append(key)
        else:
            variables.append({"name": key, "type": _ptc_preview_value(value)})
    return {
        "cells": _cell_counter,
        "imports": imports,
        "defs": sorted(defs),
        "classes": sorted(classes),
        "vars": variables,
    }


def _ptc_kernel_digest(before: dict | None = None) -> dict:
    """Totals for permanence plus this cell's namespace delta. ``before`` is the
    pre-cell fingerprint; None means everything counts as added (unused: the
    prelude seeds the namespace before the first cell)."""
    state = _ptc_kernel_state(_ptc_baseline)
    digest = {
        "cells": _cell_counter,
        "defs": state["defs"],
        "classes": state["classes"],
        "imports": state["imports"],
        "vars": state["vars"],
        "changed": [],
    }
    if before is not None:
        after = _ptc_namespace_fingerprint()
        for key, value_id in after.items():
            if key not in before:
                digest["changed"].append(("+", key))
            elif before[key] != value_id:
                digest["changed"].append(("~", key))
    return digest


def _ptc_format_digest(digest: dict) -> str:
    """Render a digest as a one-line summary ("cell 3 · 2 defs · +x ~y …").
    Changed-name entries are truncated to +3/+2 with an overflow count."""
    parts = [f"cell {digest['cells']}"]
    if digest["defs"]:
        parts.append(f"{len(digest['defs'])} defs")
    if digest["classes"]:
        parts.append(f"{len(digest['classes'])} classes")
    if digest["imports"]:
        parts.append(f"{len(digest['imports'])} imports")
    if digest["changed"]:
        by_kind = {"+": [], "~": []}
        for kind, name in digest["changed"]:
            by_kind[kind].append(name)
        shown = [f"+{name}" for name in by_kind["+"][:3]] + [f"~{name}" for name in by_kind["~"][:2]]
        extra = len(digest["changed"]) - len(shown)
        if extra > 0:
            shown.append(f"…+{extra}")
        parts.append(" ".join(shown))
    # No "[kernel]" prefix: the host owns section markers now; this text is the
    # indented body of the host's `kernel:` section.
    return " · ".join(parts)


def _ptc_tools_summary() -> str | None:
    """One-line summary of the Pi tools this cell called, for the model-facing
    `tools:` section (e.g. `read ×12 · grep ×3 · 15 calls`). Defensive: the
    ledger lives in the RPC module and must never break cell reporting."""
    try:
        ledger = globals().get("cell_tool_calls")
        if not ledger:
            return None
        counts: dict[str, int] = {}
        for name in ledger:
            counts[name] = counts.get(name, 0) + 1
        bits = [f"{name} ×{n}" if n > 1 else name for name, n in counts.items()]
        bits.append(f"{len(ledger)} call" + ("s" if len(ledger) != 1 else ""))
        return " · ".join(bits)
    except Exception:
        return None


def _ptc_subagents_summary() -> str | None:
    """One line per open subagent pool with submitted work, for the model-facing
    `subagents:` section. Defensive: the pool registry is an optional runtime
    feature and must never break cell reporting."""
    try:
        mod = _ptc_sys.modules.get("pi_subagents")
        registry = getattr(mod, "REGISTRY", None) if mod is not None else None
        if registry is None:
            return None
        snapshot = registry.snapshot()
        lines = []
        for pool in snapshot.get("pools", []):
            stages = pool.get("stages", []) or []
            submitted = sum(int(s.get("submitted", 0) or 0) for s in stages)
            if not submitted:
                continue
            settled = sum(int(s.get("settled", 0) or 0) for s in stages)
            failed = sum(int(s.get("failed", 0) or 0) for s in stages)
            stage_bits = " · ".join(
                f"{s.get('name', '?')} {int(s.get('settled', 0) or 0)}/{int(s.get('submitted', 0) or 0)}"
                for s in stages
            )
            if failed:
                glyph = "!"
            elif settled >= submitted:
                glyph = "✓"
            else:
                glyph = "●"
            lines.append(f"{glyph} {pool.get('name', 'pool')}: {settled}/{submitted} done · {stage_bits}")
        return "\n".join(lines) if lines else None
    except Exception:
        return None


def _ptc_indent_block(text: str, amount: int, skip_first_line: bool = False) -> str:
    """Indent a top-level json.dumps block by `amount` levels (the document
    renders with indent=1, so each level adds a single space)."""
    lines = text.split("\n")
    pad = " " * amount
    if skip_first_line:
        return "\n".join([lines[0]] + [pad + line for line in lines[1:]])
    return "\n".join(pad + line for line in lines)


def _ptc_notebook_fragment(cell: dict) -> str:
    """Serialize one notebook cell to the cached JSON fragment form."""
    import json as _nb_json

    return _nb_json.dumps(cell, ensure_ascii=False, indent=1)


def _ptc_notebook_stat():
    """(mtime_ns, size) of the bound notebook, or None when it cannot be stat'd."""
    import os as _nb_os

    if not _ptc_notebook_path:
        return None
    try:
        stat = _nb_os.stat(_ptc_notebook_path)
    except OSError:
        return None
    return (stat.st_mtime_ns, stat.st_size)


def _ptc_bind_notebook(notebook_path: str, force: bool = False) -> None:
    """Bind an artifact and preserve its existing cells/execution numbering.

    ``force`` re-reads the file even when the path is already bound; used to
    pick up cells another writer (Jupyter, an editor, the host) changed since
    our last write.
    """
    global _ptc_notebook_path, _ptc_notebook_cell_fragments
    global _ptc_notebook_last_document, _ptc_notebook_metadata, _ptc_notebook_stat_value
    global _ptc_notebook_nbformat, _ptc_notebook_nbformat_minor, _cell_counter

    if notebook_path == _ptc_notebook_path and not force:
        return
    _ptc_notebook_path = notebook_path
    _ptc_notebook_cell_fragments = []
    _ptc_notebook_last_document = None
    _ptc_notebook_metadata = {}
    _ptc_notebook_stat_value = _ptc_notebook_stat()
    _ptc_notebook_nbformat = 4
    _ptc_notebook_nbformat_minor = 5
    _cell_counter = 0
    try:
        import json as _nb_json
        import os as _nb_os

        if not _nb_os.path.exists(notebook_path):
            return
        with open(notebook_path, "r", encoding="utf-8") as handle:
            existing = _nb_json.load(handle)
        cells = existing.get("cells", []) if isinstance(existing, dict) else []
        if isinstance(existing, dict):
            metadata = existing.get("metadata")
            _ptc_notebook_metadata = metadata if isinstance(metadata, dict) else {}
            nbformat = existing.get("nbformat")
            nbformat_minor = existing.get("nbformat_minor")
            if isinstance(nbformat, int):
                _ptc_notebook_nbformat = nbformat
            if isinstance(nbformat_minor, int):
                _ptc_notebook_nbformat_minor = nbformat_minor
        for cell in cells:
            if not isinstance(cell, dict):
                continue
            _ptc_notebook_cell_fragments.append(_ptc_notebook_fragment(cell))
            execution_count = cell.get("execution_count")
            if isinstance(execution_count, int):
                _cell_counter = max(_cell_counter, execution_count)
    except Exception:
        # A malformed/unreadable artifact must not prevent the kernel from
        # running; the next completed cell will produce a fresh valid notebook.
        _ptc_notebook_cell_fragments = []
        _cell_counter = 0
        _ptc_notebook_stat_value = None


def _ptc_notebook_reload() -> None:
    """Re-read the bound notebook when it changed on disk (external edits).

    The stat guard keeps the cached fragments when this kernel is the only
    writer. The execution counter never regresses: a scratch run that advanced
    it but recorded nothing is still remembered.
    """
    global _cell_counter

    if not _ptc_notebook_path:
        return
    if _ptc_notebook_stat_value == _ptc_notebook_stat():
        return
    saved_counter = _cell_counter
    _ptc_bind_notebook(_ptc_notebook_path, force=True)
    _cell_counter = max(saved_counter, _cell_counter)


def _ptc_notebook_store_fragment(fragment: str, target_cell_index: int | None) -> None:
    """Replace the cell at ``target_cell_index`` (0-based) or append a new one."""
    if target_cell_index is not None and 0 <= target_cell_index < len(_ptc_notebook_cell_fragments):
        _ptc_notebook_cell_fragments[target_cell_index] = fragment
    else:
        _ptc_notebook_cell_fragments.append(fragment)


def _ptc_notebook_write_document() -> bool:
    """Render the cached fragments and atomically rewrite the .ipynb.

    Skips the write when the rendered bytes are unchanged. Returns whether the
    file was (re)written. Best-effort: a write failure never fails the cell.
    """
    global _ptc_notebook_last_document, _ptc_notebook_stat_value

    if not _ptc_notebook_path:
        return False
    import os as _nb_os

    document = _ptc_render_notebook_document()
    if document == _ptc_notebook_last_document:
        return False
    directory = _nb_os.path.dirname(_ptc_notebook_path) or "."
    _nb_os.makedirs(directory, exist_ok=True)
    tmp_path = _ptc_notebook_path + ".tmp"
    with open(tmp_path, "w", encoding="utf-8") as handle:
        handle.write(document)
    _nb_os.replace(tmp_path, _ptc_notebook_path)
    _ptc_notebook_last_document = document
    _ptc_notebook_stat_value = _ptc_notebook_stat()
    return True


def _ptc_render_notebook_document() -> str:
    """Assemble the notebook document from cached per-cell JSON fragments.

    Equivalent to json.dumps of the whole notebook with indent=1, but each cell
    is serialized exactly once (when it completes) instead of the whole cells
    list being re-serialized on every completed cell.
    """
    import json as _nb_json

    # Pin the interpreter version into the notebook (standard
    # language_info.version) — FIRST RUN ONLY. The pin records the version the
    # notebook was born on (its "original/intended" version); later runs on a
    # different explicit version never overwrite it, so promoted workflows
    # keep their pin and provision_kernel(version=...) stays non-destructive.
    import platform as _nb_platform
    metadata_value = dict(_ptc_notebook_metadata) if _ptc_notebook_metadata else {
        "kernelspec": {"display_name": "Python 3 (ptc kernel)", "language": "python", "name": "python3"},
    }
    language_info = dict(metadata_value.get("language_info") or {})
    language_info.setdefault("name", "python")
    language_info.setdefault("version", _nb_platform.python_version())
    metadata_value["language_info"] = language_info
    metadata = _nb_json.dumps(metadata_value, ensure_ascii=False, indent=1)
    cells = ",\n".join(_ptc_indent_block(fragment, 2) for fragment in _ptc_notebook_cell_fragments)
    return (
        "{\n"
        " \"cells\": ["
        + ("\n" + cells if cells else "")
        + "\n ],\n"
        " \"metadata\": " + _ptc_indent_block(metadata, 1, skip_first_line=True) + ",\n"
        f" \"nbformat\": {_ptc_notebook_nbformat},\n"
        f" \"nbformat_minor\": {_ptc_notebook_nbformat_minor}\n"
        "}\n"
    )


def _ptc_notebook_write(exec_count: int, code: str, *, stdout_text: str, echo_text: str | None,
                        full_output: str, images: list | None, error: dict | None = None,
                        source_path: str | None = None,
                        target_cell_index: int | None = None,
                        append: bool = True,
                        rich_outputs: list | None = None) -> None:
    """Record the completed cell and atomically rewrite the .ipynb.

    Appends a new cell, or replaces the one at ``target_cell_index`` (0-based)
    for run_cell/sourcing. ``append=False`` (scratch runs) records nothing.
    Best-effort host artifact plumbing: a write failure never fails the cell.
    Each cell is serialized to a JSON fragment exactly once; the document is
    reassembled from fragments and only rewritten when its bytes change.

    The file is re-read first when it changed underneath us, so cells edited in
    Jupyter while the session runs are preserved rather than clobbered.
    """
    if not _ptc_notebook_path or not append:
        return
    try:
        import json as _nb_json
        import uuid as _nb_uuid

        _ptc_notebook_reload()
        outputs = []
        if stdout_text:
            outputs.append({"output_type": "stream", "name": "stdout", "text": stdout_text.splitlines(True)})
        # Rich display(...) outputs (IPython mime bundles), in capture order.
        for rich in (rich_outputs or []):
            data = getattr(rich, "data", None) or {}
            if not data:
                continue
            outputs.append({
                "output_type": "display_data",
                "data": data,
                "metadata": getattr(rich, "metadata", None) or {},
            })
        if echo_text is not None:
            outputs.append({
                "output_type": "execute_result",
                "execution_count": exec_count,
                "data": {"text/plain": echo_text.splitlines(True)},
                "metadata": {},
            })
        for image in (images or [])[:4]:
            outputs.append({
                "output_type": "display_data",
                "data": {"image/png": image.get("data", "")},
                "metadata": {},
            })
        if error is not None:
            outputs.append({
                "output_type": "error",
                "ename": str(error.get("ename", "Error")),
                "evalue": str(error.get("evalue", ""))[:500],
                "traceback": str(error.get("traceback", "")).splitlines(),
            })
        metadata = {"ptc_full_output": full_output}
        if source_path:
            metadata["ptc_file"] = source_path
        cell_record = {
            "cell_type": "code",
            "execution_count": exec_count,
            "id": _nb_uuid.uuid4().hex[:8],
            "metadata": metadata,
            "outputs": outputs,
            "source": code.splitlines(True),
        }
        fragment = _nb_json.dumps(cell_record, ensure_ascii=False, indent=1)
        _ptc_notebook_store_fragment(fragment, target_cell_index)
        _ptc_notebook_write_document()
    except Exception:
        pass  # artifact plumbing must never break the kernel


def _ptc_join_text(value) -> str:
    """NBFormat text fields are either a string or a list of string chunks."""
    if isinstance(value, list):
        return "".join(str(part) for part in value)
    return value if isinstance(value, str) else ""


def _ptc_output_text(outputs, execution_count) -> str:
    """Human-readable preview of a cell's outputs for read_cells (not the
    durable record; metadata.ptc_full_output remains canonical)."""
    parts: list[str] = []
    for output in outputs or []:
        if not isinstance(output, dict):
            continue
        kind = output.get("output_type")
        if kind == "stream":
            parts.append(_ptc_join_text(output.get("text")))
        elif kind == "execute_result":
            text = _ptc_join_text((output.get("data") or {}).get("text/plain"))
            if text:
                count = output.get("execution_count", execution_count)
                parts.append(f"Out[{count}]: {text}")
        elif kind == "display_data":
            text = _ptc_join_text((output.get("data") or {}).get("text/plain"))
            if text:
                parts.append(text)
        elif kind == "error":
            traceback_text = _ptc_join_text(output.get("traceback"))
            parts.append(traceback_text or f"{output.get('ename', 'Error')}: {output.get('evalue', '')}")
    return "\n".join(part for part in parts if part).rstrip()


def _ptc_cell_summary(cell: dict, index: int) -> dict:
    """One read_cells entry: position, type, source, and an output preview."""
    source = _ptc_join_text(cell.get("source"))
    outputs = cell.get("outputs") if isinstance(cell.get("outputs"), list) else []
    execution_count = cell.get("execution_count")
    return {
        "index": index,
        "cell_type": cell.get("cell_type") or "code",
        "execution_count": execution_count if isinstance(execution_count, int) else None,
        "source": source,
        "output_count": len(outputs),
        "output_text": _ptc_output_text(outputs, execution_count),
    }


def _ptc_doc_write(frame: dict) -> None:
    """write_cell: upsert a code/markdown cell at a 1-based position (no execution)."""
    import uuid as _nb_uuid

    at = frame.get("at")
    if not isinstance(at, int) or at < 1:
        raise RuntimeError("write_cell needs a 1-based position (at >= 1)")
    source = frame.get("source")
    if not isinstance(source, str):
        source = "" if source is None else str(source)
    cell_type = frame.get("cell_type") or "code"
    if cell_type not in ("code", "markdown"):
        raise RuntimeError("cell type must be 'code' or 'markdown'")

    index = at - 1
    existing_id = None
    if 0 <= index < len(_ptc_notebook_cell_fragments):
        try:
            import json as _nb_json
            existing = _nb_json.loads(_ptc_notebook_cell_fragments[index])
            if isinstance(existing, dict):
                existing_id = existing.get("id")
        except Exception:
            existing_id = None
    cell_id = existing_id or _nb_uuid.uuid4().hex[:8]
    source_lines = source.splitlines(True)
    if cell_type == "markdown":
        cell = {"cell_type": "markdown", "id": cell_id, "metadata": {}, "source": source_lines}
    else:
        cell = {
            "cell_type": "code",
            "execution_count": None,
            "id": cell_id,
            "metadata": {},
            "outputs": [],
            "source": source_lines,
        }
    _ptc_notebook_store_fragment(_ptc_notebook_fragment(cell), index)
    _ptc_notebook_write_document()


def _ptc_doc_delete(frame: dict) -> None:
    """delete_cell: remove a 1-based position from the notebook."""
    n = frame.get("n")
    total = len(_ptc_notebook_cell_fragments)
    if not isinstance(n, int) or n < 1:
        raise RuntimeError("delete_cell needs a 1-based position (n >= 1)")
    if n > total:
        raise RuntimeError(f"cell {n} does not exist (the notebook has {total} cell{'s' if total != 1 else ''})")
    del _ptc_notebook_cell_fragments[n - 1]
    _ptc_notebook_write_document()


def _ptc_doc_read(frame: dict) -> list:
    """read_cells/read_cell: return cell sources and current output previews."""
    import json as _nb_json

    total = len(_ptc_notebook_cell_fragments)
    if frame.get("op") == "read_cell":
        n = frame.get("n")
        if not isinstance(n, int) or n < 1 or n > total:
            raise RuntimeError(f"cell {n} does not exist (the notebook has {total} cell{'s' if total != 1 else ''})")
        indices = [n]
    else:
        offset = frame.get("offset")
        limit = frame.get("limit")
        if not isinstance(offset, int) or offset < 1:
            offset = 1
        if not isinstance(limit, int) or limit < 1:
            limit = max(total, 1)
        indices = list(range(offset, min(total, offset + limit - 1) + 1))
    cells = []
    for n in indices:
        try:
            cell = _nb_json.loads(_ptc_notebook_cell_fragments[n - 1])
        except Exception:
            continue
        if isinstance(cell, dict):
            cells.append(_ptc_cell_summary(cell, n))
    return cells


def _ptc_doc_op(frame: dict) -> None:
    """Handle a document frame (write_cell/delete_cell/read_cells/read_cell).

    Document ops never execute code and never touch the kernel namespace; they
    mutate the notebook model and persist it immediately.
    """
    exec_id = frame.get("id") or "unknown"
    op = frame.get("op")
    try:
        if not _ptc_notebook_path:
            raise RuntimeError("this kernel has no bound notebook")
        _ptc_notebook_reload()
        if op == "write_cell":
            _ptc_doc_write(frame)
        elif op == "delete_cell":
            _ptc_doc_delete(frame)
        elif op in ("read_cells", "read_cell"):
            cells = _ptc_doc_read(frame)
            _emit_protocol({
                "type": "doc_done",
                "id": exec_id,
                "op": op,
                "total": len(_ptc_notebook_cell_fragments),
                "cells": cells,
            })
            return
        else:
            raise RuntimeError(f"unknown document op: {op!r}")
        _emit_protocol({
            "type": "doc_done",
            "id": exec_id,
            "op": op,
            "total": len(_ptc_notebook_cell_fragments),
            "cells": [],
        })
    except Exception as error:
        _emit_protocol({
            "type": "doc_error",
            "id": exec_id,
            "op": op,
            "message": str(error) or type(error).__name__,
        })


def _ptc_emit_kernel_inspect(frame: dict) -> None:
    """Answer an "inspect" frame with kernel_inspected carrying the user-created
    namespace snapshot (runtime plumbing excluded via the baseline fingerprint)."""
    _emit_protocol({
        "type": "kernel_inspected",
        "id": frame.get("id") or "unknown",
        "digest": _ptc_kernel_state(_ptc_baseline),
    })


def _ptc_error_location(error, cell_name: str, code: str, fallback_line: int = 0):
    """Best-effort (1-based line, source text) for where a cell failed.

    SyntaxErrors carry a lineno directly; runtime errors are located by walking
    the traceback for the frame compiled under the cell's filename.
    """
    line = 0
    if isinstance(error, SyntaxError) and getattr(error, "lineno", None):
        line = int(error.lineno)
    if not line:
        tb = getattr(error, "__traceback__", None)
        if tb is not None:
            for frame in reversed(_ptc_traceback.extract_tb(tb)):
                if frame.filename == cell_name:
                    line = frame.lineno or 0
                    break
    if not line:
        line = fallback_line or 0
    source_lines = code.split("\n")
    source = source_lines[line - 1].strip() if 0 < line <= len(source_lines) else ""
    return line, source


def _ptc_cell_error_record(error):
    """(ename, evalue, model_message) for a cell-raising exception."""
    if isinstance(error, SystemExit):
        message = str(error) or "SystemExit"
        return "SystemExit", message, (f"SystemExit: {message}" if message else "SystemExit")
    message = str(error) or type(error).__name__
    return type(error).__name__, message, message


def _ptc_report_cell_error(exec_id: str, exec_count: int, code: str, cell_name: str,
                           source_path, target_cell_index, error, append: bool = True) -> None:
    """Persist an errored/interrupted cell and emit the terminal exec_error frame.

    Errored cells executed, so they are recorded (Jupyter-faithful) before the
    terminal frame lets the host/model continue; the kernel stays alive. A
    scratch run (``append=False``) records nothing.
    """
    interrupted = isinstance(error, (_ptc_asyncio.CancelledError, KeyboardInterrupt))
    ename, evalue, message = _ptc_cell_error_record(error)
    if interrupted:
        ename = "CancelledError" if isinstance(error, _ptc_asyncio.CancelledError) else "KeyboardInterrupt"
        evalue = "chunk execution was interrupted"
        message = f"{ename}: chunk execution was interrupted"
    traceback_text = _format_exception_with_help(error)
    stdout_text = _stdout_proxy.cell_text
    full_output = (stdout_text + traceback_text).strip() if stdout_text else traceback_text
    _ptc_notebook_write(
        exec_count,
        code,
        stdout_text=stdout_text,
        echo_text=None,
        full_output=full_output,
        images=None,
        error={"ename": ename, "evalue": evalue, "traceback": traceback_text},
        source_path=source_path,
        target_cell_index=target_cell_index,
        append=append,
    )
    _stdout_proxy.cell_text = ""
    frame = {"type": "exec_error", "id": exec_id, "message": message, "traceback": traceback_text}
    if interrupted:
        line, source = _ptc_error_location(error, cell_name, code, _current_line)
        frame["interrupted"] = True
        frame["line"] = line
        frame["source"] = source
    _emit_protocol(frame)


async def _ptc_exec_chunk(frame: dict) -> None:
    """Execute one "exec" frame end to end and emit the terminal frame.

    Handles file mode (source_path), runs the cell on the embedded IPython shell
    (single shared namespace; magics allowed; native top-level await), and
    records the cell — errored and interrupted included — in the notebook. On
    success emits exec_done whose `output`/`echo` are spool-capped cell text;
    the kernel/subagent/tool sections travel as separate fields (`kernel_text`,
    `subagents_text`, `tools_text`) that the host composes into the model text.
    Cell errors emit exec_error and keep the kernel alive; only host teardown
    re-raises."""
    global _cell_counter, _last_reported_line, _last_progress_at, _current_line, _PTC_USER_CODE_LINE_COUNT

    global _ptc_notebook_path, _ptc_baseline
    exec_id = frame.get("id") or "unknown"
    code = frame.get("code") or ""
    # Fresh per-cell tool-call ledger (see rpc.cell_tool_calls).
    globals().get("cell_tool_calls", []).clear()
    source_path = frame.get("source_path") or None
    notebook_path = frame.get("notebook") or None
    # Sourcing uses source_cell_index (position-based execution counts);
    # run_cell uses target_cell_index (position) with execution-order counts.
    source_cell_index = frame.get("source_cell_index")
    target_cell_index = frame.get("target_cell_index")
    append = frame.get("append") is not False
    if isinstance(source_cell_index, int) and source_cell_index >= 0:
        if target_cell_index is None:
            target_cell_index = source_cell_index
        source_exec_count = source_cell_index + 1
    else:
        source_exec_count = None
    initial_cell_count = frame.get("initial_cell_count")
    if notebook_path:
        _ptc_bind_notebook(notebook_path)
    if isinstance(initial_cell_count, int) and initial_cell_count >= 0:
        _cell_counter = initial_cell_count

    if source_path:
        try:
            with open(source_path, "r", encoding="utf-8") as handle:
                code = handle.read()
        except OSError as error:
            message = f"could not read cell file {source_path}: {error}"
            if source_exec_count is not None:
                _ptc_notebook_write(
                    source_exec_count,
                    code,
                    stdout_text="",
                    echo_text=None,
                    full_output=message,
                    images=None,
                    error={"ename": type(error).__name__, "evalue": str(error), "traceback": message},
                    source_path=source_path,
                    target_cell_index=target_cell_index,
                    append=append,
                )
            _emit_protocol({
                "type": "exec_error",
                "id": exec_id,
                "message": message,
            })
            return

    if source_exec_count is not None:
        exec_count = source_exec_count
    else:
        _cell_counter += 1
        exec_count = _cell_counter
    _stdout_proxy.reset_cell()
    # Tracebacks map to the real file in file mode; synthetic cell name inline.
    cell_name = source_path or f"<ptc-cell-{exec_count}>"

    # Reset per-cell progress tracking (shared with runtime.py's tracer).
    _last_reported_line = 0
    _last_progress_at = 0.0
    _current_line = 0
    _PTC_USER_CODE_LINE_COUNT = len(code.splitlines())

    _setup_matplotlib()
    shell = _ptc_setup_ipython()
    before_fingerprint = _ptc_namespace_fingerprint()
    if _ptc_baseline is None:
        _ptc_baseline = dict(before_fingerprint)

    _ptc_sys.stdout = _stdout_proxy
    _ptc_sys.settrace(_trace_lines)
    try:
        result, rich_outputs, echo_text = await _ptc_run_shell_cell(shell, code, cell_name, exec_count)
    except BaseException as error:
        if isinstance(error, GeneratorExit):
            raise
        # A signal landing outside the user code (teardown, transform, capture)
        # reaches us directly rather than through IPython's ExecutionResult.
        _ptc_report_cell_error(exec_id, exec_count, code, cell_name, source_path, target_cell_index, error, append)
        return
    finally:
        _ptc_sys.settrace(None)
        _stdout_proxy.flush()
        _ptc_sys.stdout = _ORIGINAL_STDOUT

    error = result.error_before_exec or result.error_in_exec
    return_value = None
    if isinstance(result.error_in_exec, _PtcReturn):
        # Compatibility shim: a top-level `return` surfaced as our private
        # BaseException; it is a successful cell whose `output` is the value.
        return_value = result.error_in_exec.value
        error = None
    if error is not None:
        _ptc_report_cell_error(exec_id, exec_count, code, cell_name, source_path, target_cell_index, error, append)
        return

    try:
        if _current_line:
            _report_execution_progress(_current_line, force=True)
        _cancel_progress_flush()
        images = _capture_figures()
        stdout_text = _stdout_proxy.cell_text
        result_text = _stringify_output(return_value)

        # Segments travel as separate frame fields; the HOST composes the
        # sectioned model text (column-0 markers, cell content indented), so
        # provenance is structural. `output` carries only the cell's own produced
        # result text (the top-level return value).
        digest = _ptc_kernel_digest(before_fingerprint)
        kernel_text = _ptc_format_digest(digest)
        subagents_text = _ptc_subagents_summary()
        tools_text = _ptc_tools_summary()
        record_parts = []
        if result_text:
            record_parts.append(result_text)
        if echo_text is not None:
            record_parts.append(f"Out[{exec_count}]: {echo_text}")
        record_tail = "\n\n".join(part for part in record_parts if part)
        total_output_chars = _stdout_proxy.total_chars + len(record_tail)
        remaining = max(0, _PTC_MAX_SPOOL_CHARS - _stdout_proxy.accepted_chars)
        response_output = result_text[:remaining] if result_text else ""
        echo_remaining = max(0, remaining - len(response_output))
        response_echo = echo_text[:echo_remaining] if echo_text is not None else None
        full_output = (
            (stdout_text + record_tail).strip()
            if stdout_text else record_tail
        )

        # Persist the canonical full capture before notifying the host. The
        # model may call read_cell_output immediately after exec_done.
        _ptc_notebook_write(
            exec_count,
            code,
            stdout_text=stdout_text,
            echo_text=echo_text[:_PTC_MAX_SPOOL_CHARS] if echo_text is not None else None,
            full_output=full_output,
            images=images,
            rich_outputs=rich_outputs,
            source_path=source_path,
            target_cell_index=target_cell_index,
            append=append,
        )
        _stdout_proxy.cell_text = ""
        _emit_protocol({
            "type": "exec_done",
            "id": exec_id,
            "output": response_output,
            "echo": response_echo,
            "kernel_text": kernel_text,
            "subagents_text": subagents_text,
            "tools_text": tools_text,
            "images": images,
            "total_output_chars": total_output_chars,
            "cell": exec_count,
            "digest": digest,
        })
    except Exception as report_error:
        # Formatting the result is host plumbing: a failure here must not take
        # the whole session down (an unserializable return value used to).
        _emit_protocol({
            "type": "exec_error",
            "id": exec_id,
            "message": f"failed to report the chunk result: {report_error}",
            "traceback": _ptc_traceback.format_exc(),
        })
        return


def _ptc_export_script(frame: dict) -> None:
    """Write the session's cumulative chunks to a durable script on disk.

    Top-level ``return`` statements (legal inside the session's per-chunk
    function wrapper) become print() calls in the export (re-parsed and
    unparsed for the affected cell); clean cells keep their raw text. Cells
    that used top-level await wrap the whole script in async def main().
    """
    exec_id = frame.get("id") or "unknown"
    path = frame.get("path") or ""
    cells = frame.get("cells") or []

    def _fail(message: str) -> None:
        _emit_protocol({
            "type": "script_exported",
            "id": exec_id,
            "path": path,
            "cells": 0,
            "wrapped_async": False,
            "error": message,
        })

    if not path or not cells:
        _fail("empty export request")
        return

    try:
        import os as _export_os

        rendered: list[str] = []
        needs_async = False
        for cell in cells:
            try:
                tree = _ptc_ast.parse(cell, "<ptc-export>", mode="exec")
            except SyntaxError:
                rendered.append(cell)
                continue

            cell_uses_async = any(_ptc_stmt_has_top_level_await(stmt) for stmt in tree.body)
            if cell_uses_async:
                needs_async = True

            top_level_returns = [stmt for stmt in tree.body if isinstance(stmt, _ptc_ast.Return)]
            if not top_level_returns:
                rendered.append(cell)
                continue

            for stmt in top_level_returns:
                value = stmt.value
                index = tree.body.index(stmt)
                if value is None:
                    tree.body[index] = _ptc_ast.Pass()
                else:
                    tree.body[index] = _ptc_ast.Expr(
                        value=_ptc_ast.Call(
                            func=_ptc_ast.Name(id="print", ctx=_ptc_ast.Load()),
                            args=[value],
                            keywords=[],
                        )
                    )
            _ptc_ast.fix_missing_locations(tree)
            rendered.append(_ptc_ast.unparse(tree))

        parts: list[str] = [
            "#!/usr/bin/env python3",
            '"""Exported from a pi PTC kernel.',
            "",
            f"Cells:   {len(cells)}",
            f"Wrapped: {'async def main() + asyncio.run' if needs_async else 'no'}",
            "",
            "Cells executed in one persistent interpreter namespace; here they run",
            "sequentially (module scope, or function scope when wrapped). Top-level",
            "return expressions from cells print their value instead.",
            '"""',
            "",
        ]
        if needs_async:
            parts += ["import asyncio", "", "", "async def main():"]
            for index, cell in enumerate(rendered):
                parts.append(f"    # ── cell {index + 1} ──")
                parts.extend(f"    {line}" if line.strip() else "" for line in cell.split("\n"))
                parts.append("")
            parts += ["", "", 'if __name__ == "__main__":', "    asyncio.run(main())", ""]
        else:
            for index, cell in enumerate(rendered):
                parts.append(f"# ── cell {index + 1} ──")
                parts.append(cell)
                parts.append("")

        directory = _export_os.path.dirname(path) or "."
        _export_os.makedirs(directory, exist_ok=True)
        with open(path, "w", encoding="utf-8") as handle:
            handle.write("\n".join(parts))

        _emit_protocol({
            "type": "script_exported",
            "id": exec_id,
            "path": path,
            "cells": len(cells),
            "wrapped_async": needs_async,
        })
    except Exception as error:
        _fail(str(error))


def _ptc_interrupt_chunk() -> None:
    """Cancel the chunk that is executing right now (Ctrl-C semantics).

    Called when a SIGINT arrives while the event loop was parked in select() with
    the chunk suspended at an await; the cancellation surfaces inside the chunk as
    CancelledError, which _ptc_exec_chunk reports as an interrupted exec.
    """
    task = _ptc_current_chunk_task
    if task is not None and not task.done():
        task.cancel()


async def _ptc_session_entry() -> None:
    """Persistent exec loop; driven by _ptc_session_bootstrap() when
    PTC_MODE == "session"."""
    global _ptc_current_chunk_task

    await _rpc.start_reader()
    _setup_matplotlib()
    # Fail loudly and early if the core dependency is missing: cells cannot run
    # without it, and a clear stderr beats an opaque failure on the first cell.
    try:
        _ptc_setup_ipython()
    except Exception as error:
        print(
            f"PTC: could not start the embedded IPython shell ({error}). Install it "
            f"into the kernel environment, e.g. `uv pip install ipython --python "
            f"{_ptc_sys.executable}` or provision_dependency('ipython').",
            file=_ptc_sys.stderr,
        )
        raise

    frame_queue: "_ptc_asyncio.Queue[dict]" = _ptc_asyncio.Queue()
    _rpc.set_exec_handler(lambda frame: frame_queue.put_nowait(frame))

    _emit_protocol({"type": "session_ready"})
    _ptc_sys.stdout = _stdout_proxy

    disconnect_wait = _ptc_asyncio.ensure_future(_rpc.disconnected.wait())
    # One persistent getter: an interrupt must never strand a queue read, or the
    # next frame would be delivered to a forgotten task.
    get_frame: "_ptc_asyncio.Task[dict]" = _ptc_asyncio.ensure_future(frame_queue.get())
    while True:
        done, _pending = await _ptc_asyncio.wait(
            {get_frame, disconnect_wait}, return_when=_ptc_asyncio.FIRST_COMPLETED
        )
        if disconnect_wait in done or _rpc.disconnected.is_set():
            get_frame.cancel()
            break
        frame = get_frame.result()
        get_frame = _ptc_asyncio.ensure_future(frame_queue.get())
        if frame.get("type") == "export_script":
            _ptc_export_script(frame)
            _stdout_proxy.flush()
            continue
        if frame.get("type") == "inspect":
            _ptc_emit_kernel_inspect(frame)
            continue
        if frame.get("type") == "doc":
            # Document ops never run code; the loop is otherwise parked awaiting
            # the (single) in-flight exec, so they serialize naturally.
            _ptc_doc_op(frame)
            _stdout_proxy.flush()
            continue
        task = _ptc_asyncio.ensure_future(_ptc_exec_chunk(frame))
        _ptc_current_chunk_task = task
        # Attribute agents spawned during this chunk to it: the viewer only
        # renders rows whose exec scope matches the exec being streamed.
        _ptc_builtins.PTC_EXEC_SCOPE = frame.get("id") or ""
        try:
            await task
        except _ptc_asyncio.CancelledError:
            pass  # _ptc_exec_chunk already reported the interruption
        except (KeyboardInterrupt, SystemExit, GeneratorExit):
            _ptc_current_chunk_task = None
            break
        finally:
            _ptc_current_chunk_task = None
        _stdout_proxy.flush()

    await _rpc.cleanup()


def _ptc_session_bootstrap() -> None:
    """Run the session loop on our own event loop so SIGINT can interrupt a chunk
    without asyncio.run()'s Runner cancelling everything and exiting the process."""
    global _ptc_loop

    loop = _ptc_asyncio.new_event_loop()
    _ptc_asyncio.set_event_loop(loop)
    _ptc_loop = loop
    main_task = loop.create_task(_ptc_session_entry())
    try:
        while True:
            try:
                loop.run_until_complete(main_task)
                break
            except KeyboardInterrupt:
                # The signal landed while the loop was parked in select(): cancel
                # the running chunk and keep serving frames.
                _ptc_interrupt_chunk()
                continue
    finally:
        _ptc_loop = None
        try:
            try:
                loop.run_until_complete(loop.shutdown_asyncgens())
            except (KeyboardInterrupt, SystemExit):
                # A second SIGINT landing during teardown must not skip
                # loop.close() below (leaked loop/fd's on the way out).
                pass
            except Exception:
                pass
        finally:
            try:
                loop.close()
            except Exception:
                pass
