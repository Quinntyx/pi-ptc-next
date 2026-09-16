"""Persistent PTC session runtime.

Unlike the one-shot combined script (rpc + wrappers + runtime + user_main), a
persistent session keeps one interpreter alive for many code chunks. The host
sends JSONL frames on stdin:

    {"type": "exec", "id": "exec_1", "code": "...", "user_code_line_count": N}
    {"type": "export_script", "id": "export_1", "path": "...", "cells": ["..."]}

and the runtime answers:

    {"type": "exec_done", "id": ..., "output": ..., "images": [...], "total_output_chars": N}
    {"type": "exec_error", "id": ..., "message": ..., "traceback": "..."}
    {"type": "script_exported", "id": ..., "path": ..., "cells": N, "wrapped_async": bool}

interspersed with the usual execution_progress / stdout frames, plus
{"type": "subagent_state", "snapshot": {...}} frames emitted by the
pi_subagents bridge and {"type": "session_ready"} once the loop is live.

Each chunk compiles as a function body (sync `def` or `async def` when it uses
top-level await), so `return` keeps working, and the function's locals are
merged back into the shared namespace afterwards so imports and definitions
persist across chunks.
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
_PTC_MERGE_SKIP_NAMES = {"ptc_local_storage", "__builtins__"}


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
    """
    tree = _ptc_ast.parse(code, cell_name, mode="exec")
    is_async = any(_ptc_stmt_has_top_level_await(stmt) for stmt in tree.body)
    body = tree.body or [_ptc_ast.Pass()]

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


async def _ptc_exec_chunk(frame: dict) -> None:
    global _cell_counter, _last_reported_line, _last_progress_at, _current_line, _PTC_USER_CODE_LINE_COUNT

    exec_id = frame.get("id") or "unknown"
    code = frame.get("code") or ""
    _cell_counter += 1
    cell_name = f"<ptc-cell-{_cell_counter}>"

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
            scope: dict = {}
            exec(cell_code, globals(), scope)
            cell = scope.get("_ptc_cell")
            result = await cell() if is_async else cell()
        except BaseException as error:
            _ptc_merge_cell_locals(globals().pop("ptc_cell_storage", None))
            _stdout_proxy.flush()
            _ptc_sys.stdout = _ORIGINAL_STDOUT
            _ptc_sys.settrace(None)
            if isinstance(error, (KeyboardInterrupt, SystemExit, GeneratorExit)):
                raise
            _emit_protocol({
                "type": "exec_error",
                "id": exec_id,
                "message": str(error),
                "traceback": _ptc_traceback.format_exc(),
            })
            return

        _ptc_merge_cell_locals(globals().pop("ptc_cell_storage", None))
        _stdout_proxy.flush()
        _ptc_sys.stdout = _ORIGINAL_STDOUT
        _ptc_sys.settrace(None)
        if _current_line:
            _report_execution_progress(_current_line, force=True)
        images = _capture_figures()
        final_output = _stringify_output(result)
        total_output_chars = _stdout_proxy.total_chars + len(final_output)
        remaining = max(0, _PTC_MAX_OUTPUT_CHARS - _stdout_proxy.accepted_chars)
        _emit_protocol({
            "type": "exec_done",
            "id": exec_id,
            "output": final_output[:remaining],
            "images": images,
            "total_output_chars": total_output_chars,
        })
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
            '"""Exported from a pi PTC session (python_session_to_script).',
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


async def _ptc_session_entry() -> None:
    """Persistent exec loop; invoked via asyncio.run(_ptc_session_entry()) by
    the host-built prelude when PTC_MODE == "session"."""
    await _rpc.start_reader()
    _setup_matplotlib()

    frame_queue: "_ptc_asyncio.Queue[dict]" = _ptc_asyncio.Queue()
    _rpc.set_exec_handler(lambda frame: frame_queue.put_nowait(frame))

    _emit_protocol({"type": "session_ready"})
    _ptc_sys.stdout = _stdout_proxy

    disconnect_wait = _ptc_asyncio.ensure_future(_rpc.disconnected.wait())
    while True:
        get_frame = _ptc_asyncio.ensure_future(frame_queue.get())
        done, _pending = await _ptc_asyncio.wait(
            {get_frame, disconnect_wait}, return_when=_ptc_asyncio.FIRST_COMPLETED
        )
        if disconnect_wait in done or _rpc.disconnected.is_set():
            get_frame.cancel()
            break
        frame = get_frame.result()
        if frame.get("type") == "export_script":
            _ptc_export_script(frame)
            _stdout_proxy.flush()
            continue
        try:
            await _ptc_exec_chunk(frame)
        except (KeyboardInterrupt, SystemExit, GeneratorExit):
            break
        _stdout_proxy.flush()

    await _rpc.cleanup()
