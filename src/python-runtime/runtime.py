import asyncio as _ptc_asyncio
import json as _ptc_json
import os as _ptc_os
import sys as _ptc_sys
import time as _ptc_time
import traceback as _ptc_traceback
from typing import Any, Callable, Coroutine, Iterable, Sequence

_current_line = 0
_last_reported_line = 0
_last_progress_at = 0.0
_pending_progress_line: "int | None" = None
_progress_flush_handle = None
_PTC_PROGRESS_INTERVAL_SECONDS = 0.05
_PTC_HOST_WORKSPACE_ROOT = globals().get("PTC_HOST_WORKSPACE_ROOT", _ptc_os.getcwd())
_PTC_RUNTIME_WORKSPACE_ROOT = globals().get("PTC_RUNTIME_WORKSPACE_ROOT", _ptc_os.getcwd())
_PTC_USER_CODE_LINE_COUNT = globals().get("PTC_USER_CODE_LINE_COUNT", 0)
_PTC_MAX_OUTPUT_CHARS = max(1, int(globals().get("PTC_MAX_OUTPUT_CHARS", 100_000)))
_ORIGINAL_STDOUT = _ptc_sys.stdout


def _emit_protocol(message: dict[str, Any]) -> None:
    _ORIGINAL_STDOUT.write(_ptc_json.dumps(message) + "\n")
    _ORIGINAL_STDOUT.flush()


_ptc_protocol_write = _emit_protocol


class _StdoutProxy:
    def __init__(self):
        self._buffer = ""
        self.total_chars = 0
        self.accepted_chars = 0

    def write(self, text: str) -> int:
        if not text:
            return 0

        self.total_chars += len(text)
        remaining = _PTC_MAX_OUTPUT_CHARS - self.accepted_chars
        if remaining <= 0:
            return len(text)

        accepted = text[:remaining]
        self.accepted_chars += len(accepted)
        self._buffer += accepted
        while "\n" in self._buffer:
            line, self._buffer = self._buffer.split("\n", 1)
            _emit_protocol({"type": "stdout", "text": f"{line}\n"})
        return len(text)

    def flush(self) -> None:
        if self._buffer:
            _emit_protocol({"type": "stdout", "text": self._buffer})
            self._buffer = ""


_stdout_proxy = _StdoutProxy()


def _emit_progress_frame(lineno: int) -> None:
    global _last_progress_at, _last_reported_line
    # A newer frame supersedes any scheduled flush, and dropping the timer keeps a
    # finished chunk's interpreter from being held open by a stray callback.
    _cancel_progress_flush()
    try:
        _emit_protocol({"type": "execution_progress", "line": lineno, "total_lines": _PTC_USER_CODE_LINE_COUNT})
        _last_reported_line = lineno
        _last_progress_at = _ptc_time.monotonic()
    except Exception:
        pass


def _cancel_progress_flush() -> None:
    global _progress_flush_handle
    if _progress_flush_handle is not None:
        _progress_flush_handle.cancel()
        _progress_flush_handle = None


def _flush_pending_progress() -> None:
    global _pending_progress_line, _progress_flush_handle
    _progress_flush_handle = None
    line = _pending_progress_line
    _pending_progress_line = None
    if line is not None:
        _emit_progress_frame(line)


def _schedule_progress_flush() -> None:
    global _progress_flush_handle
    try:
        loop = _ptc_asyncio.get_running_loop()
    except RuntimeError:
        return
    _cancel_progress_flush()
    _progress_flush_handle = loop.call_later(_PTC_PROGRESS_INTERVAL_SECONDS, _flush_pending_progress)


def _report_execution_progress(lineno: int, force: bool = False) -> None:
    global _pending_progress_line

    # sys.settrace fires for every executed line. Emitting and flushing one JSON
    # frame per event can fill the pipe and starve the Node event loop/SIGCHLD
    # handling during tight loops. Repeated lines need no redraw, and changed
    # lines are capped at 20 updates/second.
    #
    # Suppressed lines are *coalesced*, never dropped: a chunk typically runs its
    # first statements within a few milliseconds, and dropping those left the
    # viewer's line arrow pinned at line 1 for the whole (long) await that
    # followed. The newest suppressed line is flushed on a timer, so the arrow
    # catches up as soon as the chunk yields back to the loop.
    if lineno == _last_reported_line and not force:
        return

    now = _ptc_time.monotonic()
    if not force and _last_progress_at and now - _last_progress_at < _PTC_PROGRESS_INTERVAL_SECONDS:
        _pending_progress_line = lineno
        _schedule_progress_flush()
        return

    _pending_progress_line = None
    _emit_progress_frame(lineno)


def _trace_lines(frame, event, arg):
    global _current_line

    if event != "line":
        return _trace_lines

    if frame.f_code.co_name in ("user_main", "_ptc_cell"):
        # f_lineno is offset from co_firstlineno, which points at the `def` line.
        # The first body line therefore maps to user line 1, not 2.
        # _PTC_LINENO_OFFSET shifts the mapping when the wrapper's def line is
        # placed ON the first user statement (persistent session cells), where
        # the raw delta starts at 0 for the first body line.
        lineno = frame.f_lineno - frame.f_code.co_firstlineno + globals().get("_PTC_LINENO_OFFSET", 0)
        _current_line = lineno
        _report_execution_progress(lineno)

    return _trace_lines


def _host_abspath(path: str) -> str:
    if _ptc_os.path.isabs(path):
        runtime_root = _ptc_os.path.normpath(_PTC_RUNTIME_WORKSPACE_ROOT)
        normalized = _ptc_os.path.normpath(path)
        if normalized == runtime_root or normalized.startswith(f"{runtime_root}{_ptc_os.sep}"):
            relative_path = _ptc_os.path.relpath(normalized, runtime_root)
            return _ptc_os.path.normpath(_ptc_os.path.join(_PTC_HOST_WORKSPACE_ROOT, relative_path))
        return normalized

    return _ptc_os.path.normpath(_ptc_os.path.join(_PTC_HOST_WORKSPACE_ROOT, path))


class _PtcHelpers:
    def __init__(self, max_parallel_tool_calls: int):
        self.max_parallel_tool_calls = max(1, max_parallel_tool_calls)

    async def gather_limit(self, coroutines: Iterable[Coroutine[Any, Any, Any]], limit: int | None = None):
        semaphore = _ptc_asyncio.Semaphore(max(1, limit or self.max_parallel_tool_calls))

        async def _runner(coro: Coroutine[Any, Any, Any]):
            async with semaphore:
                return await coro

        return await _ptc_asyncio.gather(*[_runner(coro) for coro in coroutines])

    async def find_files(self, pattern: str, path: str = ".", max_files: int = 1000) -> Sequence[str]:
        return await glob(pattern=pattern, path=path, limit=max_files)

    async def find_files_abs(self, pattern: str, path: str = ".", max_files: int = 1000) -> Sequence[str]:
        files = await self.find_files(pattern=pattern, path=path, max_files=max_files)
        base_path = _host_abspath(path)
        return [item if _ptc_os.path.isabs(item) else _ptc_os.path.join(base_path, item) for item in files]

    async def read_text(self, path: str, offset: int | None = None, limit: int | None = None) -> str:
        return await read(path=path, offset=offset, limit=limit)

    async def read_many(
        self,
        paths: Sequence[str],
        max_concurrency: int | None = None,
        *,
        offset: int | None = None,
        line_limit: int | None = None,
    ) -> Sequence[str]:
        return await self.gather_limit(
            [read(path=path, offset=offset, limit=line_limit) for path in paths],
            limit=max_concurrency,
        )

    async def read_tree(
        self,
        pattern: str,
        path: str = ".",
        max_files: int = 1000,
        concurrency: int | None = None,
        offset: int | None = None,
        line_limit: int | None = None,
    ) -> Sequence[dict[str, Any]]:
        files = await self.find_files_abs(pattern=pattern, path=path, max_files=max_files)
        contents = await self.read_many(files, max_concurrency=concurrency, offset=offset, line_limit=line_limit)
        return [
            {
                "path": file_path,
                "content": content,
            }
            for file_path, content in zip(files, contents)
        ]

    def json_dump(self, value: Any) -> str:
        return _ptc_json.dumps(value, indent=2, ensure_ascii=False, sort_keys=True)


ptc = _PtcHelpers(globals().get("PTC_MAX_PARALLEL_TOOL_CALLS", 8))


class _LazyModuleProxy:
    def __init__(self, module_name: str, setup_fn=None):
        self._module_name = module_name
        self._setup_fn = setup_fn
        self._module = None

    def _load(self):
        if self._module is None:
            if self._setup_fn:
                self._setup_fn()
            import importlib
            self._module = importlib.import_module(self._module_name)
        return self._module

    def __getattr__(self, name: str) -> Any:
        return getattr(self._load(), name)

    def __getitem__(self, item: Any) -> Any:
        return self._load()[item]

    def __call__(self, *args: Any, **kwargs: Any) -> Any:
        return self._load()(*args, **kwargs)

    def __dir__(self) -> list[str]:
        return dir(self._load())

    def __repr__(self) -> str:
        return repr(self._load())

def _setup_matplotlib():
    try:
        import matplotlib
        matplotlib.use("Agg", force=True)
    except Exception:
        pass

np = _LazyModuleProxy("numpy")
pd = _LazyModuleProxy("pandas")
plt = _LazyModuleProxy("matplotlib.pyplot", setup_fn=_setup_matplotlib)

def _capture_figures() -> list[dict[str, Any]]:
    captured = []
    try:
        import matplotlib.pyplot as _plt
        import io as _io
        import base64 as _b64
        try:
            from PIL import Image as _PILImage
        except ImportError:
            _PILImage = None

        fig_nums = _plt.get_fignums()
        if not fig_nums:
            return captured

        for num in fig_nums[:4]:
            try:
                fig = _plt.figure(num)
                buf = _io.BytesIO()
                fig.savefig(buf, format="png", bbox_inches="tight", dpi=150)
                buf.seek(0)
                img_bytes = buf.read()

                width, height = fig.get_size_inches() * fig.dpi
                width, height = int(width), int(height)

                if _PILImage and len(img_bytes) > 2 * 1024 * 1024:
                    try:
                        pil_img = _PILImage.open(_io.BytesIO(img_bytes))
                        pil_img.thumbnail((1600, 1200))
                        out_buf = _io.BytesIO()
                        pil_img.save(out_buf, format="PNG", optimize=True)
                        img_bytes = out_buf.getvalue()
                        width, height = pil_img.size
                    except Exception:
                        pass

                b64_data = _b64.b64encode(img_bytes).decode("ascii")
                captured.append({
                    "mimeType": "image/png",
                    "data": b64_data,
                    "width": width,
                    "height": height
                })
            except Exception:
                pass
        _plt.close("all")
    except Exception:
        pass
    return captured

def _stringify_output(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, str):
        return value
    if isinstance(value, (dict, list, tuple, bool, int, float)):
        # User values can hold anything (modules, sockets, DataFrames with odd
        # fields); fall back to repr instead of failing the chunk, and make that
        # fallback the very last resort so the session never dies on formatting.
        try:
            return _ptc_json.dumps(value, indent=2, ensure_ascii=False, sort_keys=True, default=repr)
        except Exception:
            try:
                return repr(value)
            except Exception:
                return "<unserializable result>"
    return str(value)


async def _runtime_main(user_main: Callable[[], Coroutine[Any, Any, Any]]):
    try:
        _setup_matplotlib()
        await _rpc.start_reader()
        _ptc_sys.settrace(_trace_lines)
        _ptc_sys.stdout = _stdout_proxy
        output = await user_main()
        _stdout_proxy.flush()
        _ptc_sys.stdout = _ORIGINAL_STDOUT
        _ptc_sys.settrace(None)
        # Ensure short executions and the final line are observable even when
        # the regular progress update was suppressed by the rate limit.
        if _current_line:
            _report_execution_progress(_current_line, force=True)
        _cancel_progress_flush()
        images = _capture_figures()
        final_output = _stringify_output(output)
        total_output_chars = _stdout_proxy.total_chars + len(final_output)
        remaining_output_chars = max(0, _PTC_MAX_OUTPUT_CHARS - _stdout_proxy.accepted_chars)
        _emit_protocol({
            "type": "complete",
            "output": final_output[:remaining_output_chars],
            "images": images,
            "total_output_chars": total_output_chars,
        })
    except Exception as error:
        _ptc_sys.stdout = _ORIGINAL_STDOUT
        _ptc_sys.settrace(None)
        _emit_protocol(
            {
                "type": "error",
                "message": str(error),
                "traceback": _ptc_traceback.format_exc(),
            }
        )
        _ptc_sys.exit(1)
    finally:
        await _rpc.cleanup()

# The one-shot entry point (``asyncio.run(_runtime_main(user_main))``) lives in
# the host-built combined script for one-shot executions; persistent-session
# mode (PTC_MODE == "session") invokes session.py's exec loop instead.
