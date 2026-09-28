"""Persistent PTC session runtime — a headless Jupyter-like kernel.

Unlike the one-shot combined script (rpc + wrappers + runtime + user_main), a
persistent session keeps one interpreter alive for many cells. The host sends
JSONL frames on stdin:

    {"type": "exec", "id": "exec_1", "code": "...", "user_code_line_count": N,
     "notebook": "/path/to/notebook.ipynb",          # live notebook artifact
     "source_path": "/path/to/cell.py"}              # optional file mode
    {"type": "inspect", "id": "inspect_1"}
    {"type": "export_script", "id": "export_1", "path": "...", "cells": ["..."]}

and the runtime answers:

    {"type": "exec_done", "id": ..., "output": ..., "images": [...],
     "total_output_chars": N, "cell": N, "digest": {...}}
    {"type": "exec_error", "id": ..., "message": ..., "traceback": "..."}
    {"type": "kernel_inspected", "id": ..., "digest": {...}}
    {"type": "script_exported", "id": ..., "path": ..., "cells": N, "wrapped_async": bool}

interspersed with the usual execution_progress / stdout frames, plus
{"type": "subagent_state", "snapshot": {...}} frames emitted by the
pi_subagents bridge and {"type": "session_ready"} once the loop is live.

Kernel semantics:

- Each cell compiles as a function body (sync `def` or `async def` when it uses
  top-level await), so `return` keeps working, and the function's locals are
  merged back into the shared namespace afterwards so imports and definitions
  persist across cells.
- A trailing bare expression is echoed automatically (Out[n] semantics) via
  str() so libraries opt into readable display through __str__.
- Line-leading `%`/`!` (IPython magics) are rejected before execution: the cell
  neither runs nor reaches the notebook. The magic scan only runs when the cell
  fails to parse, so a leading `%`/`!` (which can never be valid Python) gets a
  MagicError while valid Python that merely contains `%` or `!` inside
  triple-quoted strings or after backslash joins is executed normally.
- Completed cells — including errored and interrupted ones — are appended to the
  live .ipynb artifact and the file is rewritten atomically.
- File mode executes a file's contents inside this kernel (IPython %run
  semantics); tracebacks map to the real file path.
"""

import ast as _ptc_ast
import builtins as _ptc_builtins
import re as _ptc_re

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
# Preserve source notebook-level metadata/version while cells are re-rendered.
_ptc_notebook_metadata = {}
_ptc_notebook_nbformat = 4
_ptc_notebook_nbformat_minor = 5
# Pre-first-cell namespace fingerprint: the baseline that separates runtime
# plumbing from user-created state in digests and inspect_kernel.
_ptc_baseline = None
# Names injected by the runtime/prelude that are plumbing, not user state.
_PTC_DIGEST_SKIP_NAMES = {"ptc", "PTC_MODE", "subagents_autoimport_note"}
# Line-leading % or ! is never valid Python: it is an IPython magic trying to
# sneak in. Caught before execution so hallucinated magics cost one cheap turn
# and never touch the notebook.
_PTC_MAGIC_RE = _ptc_re.compile(r"\s*[%!]")
_PTC_MAGIC_EQUIVALENTS = (
    ("%timeit", "time.perf_counter() around a loop, or the timeit module"),
    ("%%time", "time.perf_counter() before and after the work"),
    ("%time", "time.perf_counter()"),
    ("%pip", 'provision_dependency("<distribution>")'),
    ("%who", "inspect_kernel"),
    ("%whos", "inspect_kernel"),
    ("%%capture", "contextlib.redirect_stdout"),
    ("%matplotlib", "figures are captured automatically; no setup needed"),
    ("%load_ext", "no equivalent — this runtime needs no extensions"),
    ("%run", "exec_cell(file=...) runs a file inside this kernel"),
    ("!", "the bash tool"),
)
# The chunk currently executing, so a SIGINT can cancel it without killing the
# session (Ctrl-C semantics: stop the chunk, keep the interpreter interactive).
_ptc_current_chunk_task = None
_ptc_loop = None
_PTC_MERGE_SKIP_NAMES = {"ptc_cell_storage", "__builtins__"}
# The session wrapper's `def _ptc_cell` is placed on the chunk's first user
# line, so raw trace deltas start at 0; shift to 1-based like the one-shot path.
_PTC_LINENO_OFFSET = 1


def _ptc_merge_cell_locals(storage: dict) -> None:
    """Merge user-visible cell locals into the persistent namespace.

    Names reserved by the runtime (leading "_ptc_", "PTC_", "__") are skipped so
    the plumbing cannot be clobbered by user code.
    """
    if not isinstance(storage, dict):
        return
    for key, value in storage.items():
        if key in _PTC_MERGE_SKIP_NAMES:
            continue
        if key.startswith("_ptc_") or key.startswith("PTC_") or key.startswith("__"):
            continue
        globals()[key] = value


def _ptc_stmt_has_top_level_await(node) -> bool:
    """True when the statement contains await/async-for/async-with outside any
    nested function or lambda scope."""
    if isinstance(node, (_ptc_ast.Await, _ptc_ast.AsyncFor, _ptc_ast.AsyncWith)):
        return True
    for child in _ptc_ast.iter_child_nodes(node):
        if isinstance(child, (_ptc_ast.FunctionDef, _ptc_ast.AsyncFunctionDef, _ptc_ast.Lambda)):
            continue
        if _ptc_stmt_has_top_level_await(child):
            return True
    return False


def _ptc_build_cell(code: str, cell_name: str):
    """Compile a chunk as a function body; returns (compiled, is_async).

    The function body is wrapped in try/finally whose finally block stores the
    cell's locals into ``globals()["ptc_cell_storage"]`` — so the merge happens
    even when the user code returns early or raises.

    A trailing bare expression (Jupyter's Out[] semantics) is stored into
    ``_ptc_last_value`` instead of being discarded; the exec chunk reads it for
    the auto-echo. The rewrite happens at the AST level so original line
    numbers (viewer arrow, tracebacks) are preserved.
    """
    tree = _ptc_ast.parse(code, cell_name, mode="exec")
    is_async = any(_ptc_stmt_has_top_level_await(stmt) for stmt in tree.body)
    body = tree.body or [_ptc_ast.Pass()]
    if isinstance(body[-1], _ptc_ast.Expr):
        trailing = body[-1]
        store = _ptc_ast.Assign(
            targets=[_ptc_ast.Name(id="_ptc_last_value", ctx=_ptc_ast.Store())],
            value=trailing.value,
        )
        _ptc_ast.copy_location(store, trailing)
        body[-1] = store

    storage = _ptc_ast.Assign(
        targets=[
            _ptc_ast.Subscript(
                value=_ptc_ast.Call(func=_ptc_ast.Name(id="globals", ctx=_ptc_ast.Load()), args=[], keywords=[]),
                slice=_ptc_ast.Constant(value="ptc_cell_storage"),
                ctx=_ptc_ast.Store(),
            )
        ],
        value=_ptc_ast.Call(
            func=_ptc_ast.Name(id="locals", ctx=_ptc_ast.Load()), args=[], keywords=[]
        ),
    )
    # Borrow the last user statement's location: the wrapper's own bookkeeping must
    # not be reported as a line (it otherwise inherits line 1 and makes the viewer's
    # arrow jump back to the top at the end of every chunk).
    _ptc_ast.copy_location(storage, body[-1])
    guarded = _ptc_ast.Try(
        body=body,
        handlers=[],
        orelse=[],
        finalbody=[storage],
    )

    func = _ptc_ast.AsyncFunctionDef() if is_async else _ptc_ast.FunctionDef()
    func.name = "_ptc_cell"
    func.args = _ptc_ast.arguments(
        posonlyargs=[], args=[], vararg=None, kwonlyargs=[], kw_defaults=[], kwarg=None, defaults=[]
    )
    func.body = [guarded]
    func.decorator_list = []
    func.returns = None
    func.type_params = []
    _ptc_ast.copy_location(func, body[0])
    _ptc_ast.fix_missing_locations(func)
    module = _ptc_ast.Module(body=[func], type_ignores=[])
    _ptc_ast.fix_missing_locations(module)
    return compile(module, cell_name, "exec"), is_async


def _ptc_find_magics(code: str) -> list[tuple[int, str]]:
    offending = []
    for lineno, line in enumerate(code.split("\n"), 1):
        if _PTC_MAGIC_RE.match(line):
            offending.append((lineno, line.strip()))
    return offending


def _ptc_code_parses(code: str) -> bool:
    """True when `code` is syntactically valid Python.

    The magic guard (L8) is only consulted when this fails: a leading `%`/`!` is
    always a SyntaxError, so a parse failure triggers the friendly MagicError
    scan — while `%`/`!` inside triple-quoted strings or after backslash joins
    parse fine and must execute untouched.
    """
    try:
        _ptc_ast.parse(code, "<ptc-magic-check>", mode="exec")
        return True
    except (SyntaxError, ValueError):
        return False


def _ptc_magic_error(offending: list[tuple[int, str]]) -> str:
    shown = "; ".join(f"line {n}: `{text[:60]}`" for n, text in offending[:3])
    equivalents = " · ".join(f"{magic} → {hint}" for magic, hint in _PTC_MAGIC_EQUIVALENTS)
    return (
        f"MagicError: IPython magics are not supported by this runtime ({shown}). "
        f"This cell was not executed and was not written to the notebook. "
        f"Native equivalents: {equivalents}"
    )


def _ptc_preview_value(value) -> str:
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
        and key not in _PTC_MERGE_SKIP_NAMES
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
            or key in _PTC_MERGE_SKIP_NAMES
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


def _ptc_bind_notebook(notebook_path: str) -> None:
    """Bind an artifact and preserve its existing cells/execution numbering."""
    global _ptc_notebook_path, _ptc_notebook_cell_fragments
    global _ptc_notebook_last_document, _ptc_notebook_metadata
    global _ptc_notebook_nbformat, _ptc_notebook_nbformat_minor, _cell_counter

    if notebook_path == _ptc_notebook_path:
        return
    _ptc_notebook_path = notebook_path
    _ptc_notebook_cell_fragments = []
    _ptc_notebook_last_document = None
    _ptc_notebook_metadata = {}
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
            _ptc_notebook_cell_fragments.append(
                _nb_json.dumps(cell, ensure_ascii=False, indent=1)
            )
            execution_count = cell.get("execution_count")
            if isinstance(execution_count, int):
                _cell_counter = max(_cell_counter, execution_count)
    except Exception:
        # A malformed/unreadable artifact must not prevent the kernel from
        # running; the next completed cell will produce a fresh valid notebook.
        _ptc_notebook_cell_fragments = []
        _cell_counter = 0


def _ptc_render_notebook_document() -> str:
    """Assemble the notebook document from cached per-cell JSON fragments.

    Equivalent to json.dumps of the whole notebook with indent=1, but each cell
    is serialized exactly once (when it completes) instead of the whole cells
    list being re-serialized on every completed cell.
    """
    import json as _nb_json

    metadata_value = _ptc_notebook_metadata or {
        "kernelspec": {"display_name": "Python 3 (ptc kernel)", "language": "python", "name": "python3"},
        "language_info": {"name": "python"},
    }
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
                        source_cell_index: int | None = None) -> None:
    """Append the completed cell and atomically rewrite the .ipynb.

    Best-effort host artifact plumbing: a write failure never fails the cell.
    Each cell is serialized to a JSON fragment exactly once; the document is
    reassembled from fragments and only rewritten when its bytes change.
    """
    global _ptc_notebook_last_document
    if not _ptc_notebook_path:
        return
    try:
        import json as _nb_json
        import os as _nb_os
        import uuid as _nb_uuid

        outputs = []
        if stdout_text:
            outputs.append({"output_type": "stream", "name": "stdout", "text": stdout_text.splitlines(True)})
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
        if source_cell_index is not None and 0 <= source_cell_index < len(_ptc_notebook_cell_fragments):
            _ptc_notebook_cell_fragments[source_cell_index] = fragment
        else:
            _ptc_notebook_cell_fragments.append(fragment)
        document = _ptc_render_notebook_document()
        if document == _ptc_notebook_last_document:
            return  # nothing changed on disk-worthy content; skip the rewrite
        _ptc_notebook_last_document = document
        directory = _nb_os.path.dirname(_ptc_notebook_path) or "."
        _nb_os.makedirs(directory, exist_ok=True)
        tmp_path = _ptc_notebook_path + ".tmp"
        with open(tmp_path, "w", encoding="utf-8") as handle:
            handle.write(document)
        _nb_os.replace(tmp_path, _ptc_notebook_path)
    except Exception:
        pass  # artifact plumbing must never break the kernel


def _ptc_emit_kernel_inspect(frame: dict) -> None:
    _emit_protocol({
        "type": "kernel_inspected",
        "id": frame.get("id") or "unknown",
        "digest": _ptc_kernel_state(_ptc_baseline),
    })


async def _ptc_exec_chunk(frame: dict) -> None:
    global _cell_counter, _last_reported_line, _last_progress_at, _current_line, _PTC_USER_CODE_LINE_COUNT

    global _ptc_notebook_path, _ptc_baseline
    exec_id = frame.get("id") or "unknown"
    code = frame.get("code") or ""
    source_path = frame.get("source_path") or None
    notebook_path = frame.get("notebook") or None
    source_cell_index = frame.get("source_cell_index")
    source_exec_count = source_cell_index + 1 if isinstance(source_cell_index, int) and source_cell_index >= 0 else None
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
                    source_cell_index=source_cell_index,
                )
            _emit_protocol({
                "type": "exec_error",
                "id": exec_id,
                "message": message,
            })
            return

    # L8: only consult the magic guard when the code does not parse. A leading
    # %/! is always a SyntaxError, so this still rejects IPython magics with the
    # friendly error (before execution: the counter does not advance and nothing
    # is written to the notebook), while % or ! inside triple-quoted strings or
    # after backslash joins parses fine and runs untouched. A genuine syntax
    # error with no magic involvement falls through and is reported as such.
    if not _ptc_code_parses(code):
        offending = _ptc_find_magics(code)
        if offending:
            message = _ptc_magic_error(offending)
            if source_exec_count is not None:
                message = message.replace(
                    "This cell was not executed and was not written to the notebook.",
                    "This sourced cell was not executed and was recorded as failed in the notebook.",
                )
                _ptc_notebook_write(
                    source_exec_count,
                    code,
                    stdout_text="",
                    echo_text=None,
                    full_output=message,
                    images=None,
                    error={"ename": "MagicError", "evalue": message, "traceback": message},
                    source_path=source_path,
                    source_cell_index=source_cell_index,
                )
            _emit_protocol({
                "type": "exec_error",
                "id": exec_id,
                "message": message,
                "magic": True,
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
    try:
        _ptc_sys.settrace(_trace_lines)
        _ptc_sys.stdout = _stdout_proxy
        try:
            cell_code, is_async = _ptc_build_cell(code, cell_name)
            before_fingerprint = _ptc_namespace_fingerprint()
            if _ptc_baseline is None:
                _ptc_baseline = dict(before_fingerprint)
            scope: dict = {}
            exec(cell_code, globals(), scope)
            cell = scope.get("_ptc_cell")
            result = await cell() if is_async else cell()
        except BaseException as error:
            _ptc_merge_cell_locals(globals().pop("ptc_cell_storage", None))
            _stdout_proxy.flush()
            _ptc_sys.stdout = _ORIGINAL_STDOUT
            _ptc_sys.settrace(None)
            if isinstance(error, (_ptc_asyncio.CancelledError, KeyboardInterrupt)):
                # Ctrl-C semantics: report where the chunk stopped and stay
                # interactive, so the caller can inspect state and retry.
                kind = "CancelledError" if isinstance(error, _ptc_asyncio.CancelledError) else "KeyboardInterrupt"
                # The traceback is authoritative: the tracer's last line can be the
                # wrapper's own bookkeeping statement rather than the user's line.
                line = 0
                for frame in reversed(_ptc_traceback.extract_tb(error.__traceback__)):
                    if frame.filename == cell_name:
                        line = frame.lineno or 0
                        break
                if not line:
                    line = _current_line or 0
                source_lines = code.split("\n")
                source = source_lines[line - 1].strip() if 0 < line <= len(source_lines) else ""
                _stdout_proxy.flush()
                traceback_text = _traceback_with_help(error)
                full_output = (
                    (_stdout_proxy.cell_text + traceback_text).strip()
                    if _stdout_proxy.cell_text else traceback_text
                )
                _ptc_notebook_write(
                    exec_count,
                    code,
                    stdout_text=_stdout_proxy.cell_text,
                    echo_text=None,
                    full_output=full_output,
                    images=None,
                    error={"ename": kind, "evalue": "chunk execution was interrupted", "traceback": traceback_text},
                    source_path=source_path,
                    source_cell_index=source_cell_index,
                )
                _stdout_proxy.cell_text = ""
                _emit_protocol({
                    "type": "exec_error",
                    "id": exec_id,
                    "message": f"{kind}: chunk execution was interrupted",
                    "traceback": traceback_text,
                    "interrupted": True,
                    "line": line,
                    "source": source,
                })
                return
            if isinstance(error, (SystemExit, GeneratorExit)):
                raise
            message = str(error)
            traceback_text = _traceback_with_help(error)
            # Errored cells executed, so they are recorded (Jupyter-faithful)
            # before the terminal frame lets the host/model continue.
            _stdout_proxy.flush()
            full_output = (
                (_stdout_proxy.cell_text + traceback_text).strip()
                if _stdout_proxy.cell_text else traceback_text
            )
            _ptc_notebook_write(
                exec_count,
                code,
                stdout_text=_stdout_proxy.cell_text,
                echo_text=None,
                full_output=full_output,
                images=None,
                error={
                    "ename": type(error).__name__,
                    "evalue": message,
                    "traceback": traceback_text,
                },
                source_path=source_path,
                source_cell_index=source_cell_index,
            )
            _stdout_proxy.cell_text = ""
            _emit_protocol({
                "type": "exec_error",
                "id": exec_id,
                "message": message,
                "traceback": traceback_text,
            })
            return

        storage = globals().pop("ptc_cell_storage", None)
        _ptc_merge_cell_locals(storage)
        echo_value = (storage or {}).get("_ptc_last_value")
        _stdout_proxy.flush()
        _ptc_sys.stdout = _ORIGINAL_STDOUT
        _ptc_sys.settrace(None)
        try:
            if _current_line:
                _report_execution_progress(_current_line, force=True)
            _cancel_progress_flush()
            images = _capture_figures()
            stdout_text = _stdout_proxy.cell_text
            result_text = _stringify_output(result)

            # Auto-echo (Out[n] semantics): the trailing bare expression's value,
            # str()-first so libraries opt into readable display via __str__.
            echo_text = None
            if echo_value is not None:
                try:
                    echo_text = echo_value if isinstance(echo_value, str) else str(echo_value)
                except Exception:
                    try:
                        echo_text = repr(echo_value)
                    except Exception:
                        echo_text = "<unrepresentable value>"

            # Segments travel as separate frame fields; the HOST composes the
            # sectioned model text (column-0 markers, cell content indented),
            # so provenance is structural. `output` carries only the cell's
            # own produced result text.
            digest = _ptc_kernel_digest(before_fingerprint)
            kernel_text = _ptc_format_digest(digest)
            subagents_text = _ptc_subagents_summary()
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
                source_path=source_path,
                source_cell_index=source_cell_index,
            )
            _stdout_proxy.cell_text = ""
            _emit_protocol({
                "type": "exec_done",
                "id": exec_id,
                "output": response_output,
                "echo": response_echo,
                "kernel_text": kernel_text,
                "subagents_text": subagents_text,
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
    except BaseException as fatal:
        # Only host-initiated teardown (abort/disconnect) lands here; report and
        # let the interpreter die — the host is already tearing the session down.
        _ptc_sys.stdout = _ORIGINAL_STDOUT
        _ptc_sys.settrace(None)
        _emit_protocol({
            "type": "exec_error",
            "id": exec_id,
            "message": f"session terminated during execution: {fatal}",
            "traceback": _ptc_traceback.format_exc(),
        })
        raise


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
