import asyncio as _ptc_asyncio
import json as _ptc_json
import os as _ptc_os
import sys as _ptc_sys
import time as _ptc_time
import traceback as _ptc_traceback
from typing import Any, Callable, Coroutine, Iterable, Sequence

"""Cell-execution plumbing for the PTC Python kernel: stdout proxy, progress
tracing, output serialization, and the `ptc` helpers exposed to user code.

The host-built combined script concatenates rpc.py + tool wrappers + this
module + user_main, then runs ``_runtime_main`` (one-shot) or session.py's
persistent exec loop (PTC_MODE == "session"). Names defined here are runtime
plumbing and are excluded from kernel digests.
"""

_current_line = 0
_last_reported_line = 0
_last_progress_at = 0.0
_pending_progress_line: "int | None" = None
_progress_flush_handle = None
_PTC_PROGRESS_INTERVAL_SECONDS = 0.05
_PTC_HOST_WORKSPACE_ROOT = globals().get("PTC_HOST_WORKSPACE_ROOT", _ptc_os.getcwd())
_PTC_RUNTIME_WORKSPACE_ROOT = globals().get("PTC_RUNTIME_WORKSPACE_ROOT", _ptc_os.getcwd())
_PTC_USER_CODE_LINE_COUNT = globals().get("PTC_USER_CODE_LINE_COUNT", 0)
# Canonical full-capture site. The host never truncates a second time; it only
# collapses a model-facing preview after this emergency per-cell safety valve.
_PTC_MAX_SPOOL_CHARS = max(1, int(globals().get(
    "PTC_MAX_SPOOL_CHARS",
    globals().get("PTC_MAX_OUTPUT_CHARS", _ptc_os.environ.get("PTC_MAX_SPOOL_CHARS", 10_000_000)),
)))
_ORIGINAL_STDOUT = _ptc_sys.stdout


def _emit_protocol(message: dict[str, Any]) -> None:
    """Write one JSONL protocol frame to the original (unproxied) stdout."""
    _ORIGINAL_STDOUT.write(_ptc_json.dumps(message) + "\n")
    _ORIGINAL_STDOUT.flush()


_ptc_protocol_write = _emit_protocol


class _StdoutProxy:
    """sys.stdout replacement for cells: forwards complete lines to the host as
    stdout frames while spooling a per-cell transcript. Output past
    _PTC_MAX_SPOOL_CHARS is silently dropped, but write() still reports the
    full length so user code is unaffected."""

    def __init__(self):
        self._buffer = ""
        self.total_chars = 0
        self.accepted_chars = 0
        # Per-cell transcript for the notebook writer.
        self.cell_text = ""

    def reset_cell(self) -> None:
        """Clear the buffer, transcript, and counters before a new cell."""
        self._buffer = ""
        self.total_chars = 0
        self.accepted_chars = 0
        self.cell_text = ""

    def write(self, text: str) -> int:
        """Accept text (up to the spool cap), emit complete lines as stdout
        frames, and append the rest to the per-cell transcript. Always returns
        len(text), even for dropped output."""
        if not text:
            return 0

        self.total_chars += len(text)
        remaining = _PTC_MAX_SPOOL_CHARS - self.accepted_chars
        if remaining <= 0:
            return len(text)

        accepted = text[:remaining]
        self.accepted_chars += len(accepted)
        self._buffer += accepted
        self.cell_text += accepted
        while "\n" in self._buffer:
            line, self._buffer = self._buffer.split("\n", 1)
            _emit_protocol({"type": "stdout", "text": f"{line}\n"})
        return len(text)

    def flush(self) -> None:
        """Emit any buffered partial line as a stdout frame."""
        if self._buffer:
            _emit_protocol({"type": "stdout", "text": self._buffer})
            self._buffer = ""


_stdout_proxy = _StdoutProxy()


def _emit_progress_frame(lineno: int) -> None:
    """Send an execution_progress frame (with the cell's total line count) now,
    cancelling any scheduled coalesced flush; never raises."""
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
    """Cancel a scheduled coalesced-progress flush, if one is pending."""
    global _progress_flush_handle
    if _progress_flush_handle is not None:
        _progress_flush_handle.cancel()
        _progress_flush_handle = None


def _flush_pending_progress() -> None:
    """Timer callback: flush the newest suppressed progress line."""
    global _pending_progress_line, _progress_flush_handle
    _progress_flush_handle = None
    line = _pending_progress_line
    _pending_progress_line = None
    if line is not None:
        _emit_progress_frame(line)


def _schedule_progress_flush() -> None:
    """Schedule the pending progress line to flush after the 0.05s interval;
    no-op when no event loop is running."""
    global _progress_flush_handle
    try:
        loop = _ptc_asyncio.get_running_loop()
    except RuntimeError:
        return
    _cancel_progress_flush()
    _progress_flush_handle = loop.call_later(_PTC_PROGRESS_INTERVAL_SECONDS, _flush_pending_progress)


def _report_execution_progress(lineno: int, force: bool = False) -> None:
    """Rate-limited tracer reporting: unchanged lines are skipped, changed lines
    capped at ~20 updates/s, and suppressed lines coalesced (never dropped) via
    a timer flush. force=True bypasses both limits."""
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
    """sys.settrace callback: report progress for user frames only.

    Two shapes reach us: the legacy one-shot ``user_main`` wrapper, and cells
    executed by the embedded IPython shell, whose code objects carry the cell's
    filename (``_PTC_ACTIVE_FILENAME``). Returning None for every other 'call'
    event keeps IPython's own machinery out of the per-line hook — tracing all of
    it line-by-line was pure overhead.
    """
    global _current_line

    if event == "call":
        if frame.f_code.co_name == "user_main":
            return _trace_lines
        if frame.f_code.co_filename == globals().get("_PTC_ACTIVE_FILENAME"):
            return _trace_lines
        return None

    if event != "line":
        return _trace_lines

    if frame.f_code.co_name == "user_main":
        # f_lineno is offset from co_firstlineno, which points at the `def` line.
        # The first body line therefore maps to user line 1, not 2.
        # _PTC_LINENO_OFFSET shifts the mapping when the wrapper's def line is
        # placed ON the first user statement (persistent session cells), where
        # the raw delta starts at 0 for the first body line.
        lineno = frame.f_lineno - frame.f_code.co_firstlineno + globals().get("_PTC_LINENO_OFFSET", 0)
    else:
        # IPython compiles the cell with the original line numbers, so f_lineno
        # is already the 1-based user line.
        lineno = frame.f_lineno
    _current_line = lineno
    _report_execution_progress(lineno)
    return _trace_lines


def _host_abspath(path: str) -> str:
    """Map a runtime-side path to its host-side absolute path: paths under the
    runtime workspace root are re-rooted onto the host workspace root, other
    absolute paths pass through, and relative paths resolve against the host root."""
    if _ptc_os.path.isabs(path):
        runtime_root = _ptc_os.path.normpath(_PTC_RUNTIME_WORKSPACE_ROOT)
        normalized = _ptc_os.path.normpath(path)
        if normalized == runtime_root or normalized.startswith(f"{runtime_root}{_ptc_os.sep}"):
            relative_path = _ptc_os.path.relpath(normalized, runtime_root)
            return _ptc_os.path.normpath(_ptc_os.path.join(_PTC_HOST_WORKSPACE_ROOT, relative_path))
        return normalized

    return _ptc_os.path.normpath(_ptc_os.path.join(_PTC_HOST_WORKSPACE_ROOT, path))


class _PtcHelpers:
    """Backing object of the `ptc` namespace available in user cells: bounded
    parallel gather plus glob/read conveniences that call the host tools over RPC."""

    def __init__(self, max_parallel_tool_calls: int):
        self.max_parallel_tool_calls = max(1, max_parallel_tool_calls)

    async def gather_limit(self, coroutines: Iterable[Coroutine[Any, Any, Any]], limit: int | None = None):
        """gather() the coroutines under a semaphore (default: max_parallel_tool_calls)."""
        semaphore = _ptc_asyncio.Semaphore(max(1, limit or self.max_parallel_tool_calls))

        async def _runner(coro: Coroutine[Any, Any, Any]):
            async with semaphore:
                return await coro

        return await _ptc_asyncio.gather(*[_runner(coro) for coro in coroutines])

    async def find_files(self, pattern: str, path: str = ".", max_files: int = 1000) -> Sequence[str]:
        """Glob for files via the host `glob` tool; returns up to `max_files`
        (default 1000) paths as the tool reports them."""
        return await glob(pattern=pattern, path=path, limit=max_files)

    async def find_files_abs(self, pattern: str, path: str = ".", max_files: int = 1000) -> Sequence[str]:
        """Like find_files, but every returned path is made absolute (host-side)."""
        files = await self.find_files(pattern=pattern, path=path, max_files=max_files)
        base_path = _host_abspath(path)
        return [item if _ptc_os.path.isabs(item) else _ptc_os.path.join(base_path, item) for item in files]

    async def read_text(self, path: str, offset: int | None = None, limit: int | None = None) -> str:
        """Read one file via the host `read` tool, with optional line offset/limit."""
        return await read(path=path, offset=offset, limit=limit)

    async def read_many(
        self,
        paths: Sequence[str],
        max_concurrency: int | None = None,
        *,
        offset: int | None = None,
        line_limit: int | None = None,
    ) -> Sequence[str]:
        """Read many files concurrently, sharing one optional offset/line_limit;
        `max_concurrency` bounds parallelism (default: max_parallel_tool_calls)."""
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
        """Glob + batched read in one call; returns [{"path", "content"}, ...]
        aligned with the found files."""
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
        """JSON-serialize with indent=2, sorted keys, and non-ASCII preserved."""
        return _ptc_json.dumps(value, indent=2, ensure_ascii=False, sort_keys=True)


ptc = _PtcHelpers(globals().get("PTC_MAX_PARALLEL_TOOL_CALLS", 8))


class _LazyModuleProxy:
    """Proxy that imports the wrapped module on first attribute access, so heavy
    imports (numpy/pandas/matplotlib) cost nothing until used. Also supports
    item access, calling, dir(), and repr."""

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
    """Force the non-interactive Agg backend so figures can be captured headlessly."""
    try:
        import matplotlib
        matplotlib.use("Agg", force=True)
    except Exception:
        pass

np = _LazyModuleProxy("numpy")
pd = _LazyModuleProxy("pandas")
plt = _LazyModuleProxy("matplotlib.pyplot", setup_fn=_setup_matplotlib)

def _capture_figures() -> list[dict[str, Any]]:
    """Capture open matplotlib figures as base64 PNG dicts (max 4, dpi 150,
    tight bbox); images over 2MB are downscaled to 1600x1200 when PIL is
    available. Closes all figures. Best-effort: never raises."""
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

def _python_error_help(error: BaseException) -> str | None:
    """A one-line recovery hint for common exception types, or None."""
    if isinstance(error, (ModuleNotFoundError, ImportError)):
        missing = getattr(error, "name", None)
        top_level = str(missing).split(".")[0] if missing else None
        if top_level == "pi_subagents" and not os.environ.get("PI_SUBAGENTS_MAX_CONCURRENT"):
            return ("help: subagent orchestration is disabled by default; set "
                    "PI_SUBAGENTS_MAX_CONCURRENT=8 (any positive number) in your environment "
                    "and restart pi to enable it")
        # Only suggest provision_dependency for import names that are also PyPI
        # distribution names. Common offenders have different distribution names
        # (PIL -> pillow, cv2 -> opencv-python, sklearn -> scikit-learn, ...);
        # suggesting the import name there installs a package that does not
        # exist or the wrong one. The host's provision_dependency maps import
        # names to distributions for the packages it knows about, so stay quiet
        # for the mismatched ones instead of lying.
        KNOWN_MISMATCHED_DISTRIBUTIONS = {
            "PIL": "pillow", "cv2": "opencv-python", "sklearn": "scikit-learn",
            "Crypto": "pycryptodome", "yaml": "pyyaml", "dateutil": "python-dateutil",
            "dotenv": "python-dotenv", "serial": "pyserial", "pptx": "python-pptx",
            "docx": "python-docx", "gi": "PyGObject", "usb": "pyusb",
        }
        if top_level is None:
            return "help: install the module's PyPI distribution with provision_dependency('<distribution>') then re-run"
        distribution = KNOWN_MISMATCHED_DISTRIBUTIONS.get(top_level, top_level)
        return f"help: install it with provision_dependency('{distribution}') then re-run"
    if isinstance(error, NameError):
        return "help: name is undefined — define it, or inspect_kernel to see live names (the kernel may have restarted)"
    if isinstance(error, SyntaxError):
        return "help: fix the syntax error at the reported line"
    if isinstance(error, FileNotFoundError):
        return "help: verify the path exists (read/ls the parent dir)"
    if isinstance(error, AttributeError):
        return "help: inspect_kernel to discover the real attribute/API"
    return None


def _traceback_with_help(error: BaseException) -> str:
    """Format the current exception's traceback, appending a recovery hint when
    _python_error_help has one for it."""
    traceback_text = _ptc_traceback.format_exc().rstrip()
    hint = _python_error_help(error)
    return f"{traceback_text}\n{hint}" if hint else traceback_text


def _format_exception_with_help(error: BaseException) -> str:
    """Like _traceback_with_help, but for an exception object captured earlier
    (IPython's ExecutionResult), when no exception is active on the stack.

    IPython's own execution frames (interactiveshell.run_code etc.) are dropped:
    they are the embedded equivalent of the old wrapper frames and only add
    noise to the model-facing traceback.
    """
    tb = getattr(error, "__traceback__", None)
    if tb is not None:
        frames = [
            entry for entry in _ptc_traceback.extract_tb(tb)
            if "/IPython/" not in entry.filename
        ]
        parts = ["Traceback (most recent call last):\n"] + _ptc_traceback.format_list(frames)
    else:
        parts = []
    parts += _ptc_traceback.format_exception_only(type(error), error)
    traceback_text = "".join(parts).rstrip()
    hint = _python_error_help(error)
    return f"{traceback_text}\n{hint}" if hint else traceback_text


def _stringify_output(value: Any) -> str:
    """Serialize a cell's return value for the host: strings pass through,
    JSON-able values dump (sorted keys, repr fallback), everything else goes
    through str(). Never raises."""
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
    """One-shot entry: run user_main under the tracer/stdout proxy, then emit a
    "complete" frame (spool-capped output plus captured figures), or an "error"
    frame followed by exit(1) on failure."""
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
        remaining_output_chars = max(0, _PTC_MAX_SPOOL_CHARS - _stdout_proxy.accepted_chars)
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
                "traceback": _traceback_with_help(error),
            }
        )
        _ptc_sys.exit(1)
    finally:
        await _rpc.cleanup()

# The one-shot entry point (``asyncio.run(_runtime_main(user_main))``) lives in
# the host-built combined script for one-shot executions; persistent-session
# mode (PTC_MODE == "session") invokes session.py's exec loop instead.
