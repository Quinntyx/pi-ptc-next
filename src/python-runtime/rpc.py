import asyncio
import json
import sys
import threading
from typing import Any, Dict, Optional

"""JSONL RPC client for the PTC Python runtime.

Tool calls are written to stdout as {"type": "tool_call", ...} frames and
answered by the host on stdin. The same stdin carries host-initiated
exec/export_script/inspect frames for persistent-session mode, dispatched to a
registered exec handler. Malformed frames are skipped and logged; the client
disconnects only on EOF or 100 consecutive malformed frames.
"""

_ptc_rpc_asyncio = asyncio

# Startup guard: the runtime relies on PEP 604 unions in *evaluated* annotations
# (``int | None`` at def-time raises TypeError on <=3.9) and on
# ``ast.FunctionDef.type_params`` (Python 3.12+). Fail fast with a clear message
# instead of an opaque TypeError deep in the prelude — SubprocessSandbox can
# fall back to a bare `python3` that is older than the tool's configured one.
if sys.version_info < (3, 10):
    raise RuntimeError(
        f"PTC Python runtime requires Python 3.10+ (found {sys.version.split()[0]}). "
        "The runtime uses PEP 604 unions in evaluated annotations and AST "
        "type_params; older interpreters fail at definition time. Point "
        "PTC_PYTHON / the sandbox at a Python >= 3.10 interpreter."
    )

# L9 trip-wire: a single malformed stdin line is skipped and logged, but a
# stream that produces this many consecutive bad frames is genuinely broken
# (e.g. a binary blob piped into the protocol) and must not be spun on forever.
_MAX_CONSECUTIVE_MALFORMED_FRAMES = 100


class ToolCallError(Exception):
    """Raised when a tool call returns an error payload: the message includes the
    host-provided stack trace when present, and .payload keeps the original dict."""

    def __init__(self, payload: Dict[str, Any]):
        self.payload = payload
        message = str(payload.get("message") or "Tool call failed")
        stack = payload.get("stack")
        formatted = f"{message}\n{stack}" if isinstance(stack, str) and stack else message
        super().__init__(formatted)


class RpcProtocolError(Exception):
    """Raised for transport-level failures: EOF on stdin, a garbage frame stream,
    or client shutdown with calls still pending."""
    pass


async def _connect_stdin_reader(reader: asyncio.StreamReader, stdin: Any = None) -> None:
    """Attach `reader` to stdin, tolerating event loops without pipe support.

    `loop.connect_read_pipe(sys.stdin)` raises NotImplementedError on Windows
    ProactorEventLoop (the default since 3.8). Fall back to a daemon thread that
    blocks on `stdin.buffer.readline()` and feeds the same StreamReader via
    `call_soon_threadsafe`, so the protocol loop above is identical everywhere.
    """
    if stdin is None:
        stdin = sys.stdin
    loop = asyncio.get_running_loop()
    try:
        protocol = asyncio.StreamReaderProtocol(reader)
        await loop.connect_read_pipe(lambda: protocol, stdin)
        return
    except NotImplementedError:
        pass  # Windows ProactorEventLoop: use the threaded reader below

    def _pump() -> None:
        try:
            while True:
                line = stdin.buffer.readline() if hasattr(stdin, "buffer") else stdin.readline()
                loop.call_soon_threadsafe(reader.feed_data, line)
                if not line:
                    break  # EOF
        except Exception as error:  # broken/closed stdin
            loop.call_soon_threadsafe(reader.feed_error, error)
        finally:
            loop.call_soon_threadsafe(reader.feed_eof)

    threading.Thread(target=_pump, name="ptc-stdin-reader", daemon=True).start()


class RpcClient:
    """Request/response client over stdin/stdout JSONL frames, plus dispatch of
    host-initiated exec-family frames in persistent-session mode."""

    def __init__(self, default_call_timeout: float = 300.0):
        self.call_id = 0
        # Per-call timeout for tool calls (seconds). Host alignment is handled
        # elsewhere; 300s remains the default so behavior is unchanged.
        self.default_call_timeout = default_call_timeout
        self.pending_calls: Dict[str, asyncio.Future[Any]] = {}
        self.reader_task: Optional[asyncio.Task[Any]] = None
        # Persistent-session mode: the host sends {"type":"exec",...} frames on
        # the same stdin pipe; a registered handler receives them.
        self.exec_handler = None
        # Set when the host closes stdin (EOF) or the pipe breaks; the session
        # exec loop waits on this to shut down.
        self.disconnected = _ptc_rpc_asyncio.Event()

    def set_exec_handler(self, handler) -> None:
        """Register the callback that receives host "exec"/"export_script"/"inspect"
        frames (persistent-session mode)."""
        self.exec_handler = handler

    async def start_reader(self) -> None:
        """Start the background stdin reader task."""
        self.reader_task = asyncio.create_task(self._stdin_reader())

    def _fail_pending_calls(self, error: Exception) -> None:
        """Fail and clear every in-flight call with `error`."""
        for future in self.pending_calls.values():
            if not future.done():
                future.set_exception(error)
        self.pending_calls.clear()

    async def _stdin_reader(self) -> None:
        """Read stdin until EOF: route responses to pending calls, hand exec-family
        frames to the handler, and skip malformed lines. Disconnects (failing all
        pending calls) on EOF or 100 consecutive malformed/undecodable frames."""
        malformed_streak = 0
        try:
            reader = asyncio.StreamReader()
            await _connect_stdin_reader(reader)

            while True:
                line = await reader.readline()
                if not line:
                    self._fail_pending_calls(RpcProtocolError("RPC host closed stdin while tool calls were pending"))
                    break

                try:
                    response = json.loads(line.decode().strip())
                    malformed_streak = 0
                    self._handle_response(response)
                except json.JSONDecodeError as error:
                    # L9: one malformed frame must not kill the whole persistent
                    # session. Skip the line, log it, and only disconnect when
                    # the stream is consistently garbage (trip-wire above).
                    malformed_streak += 1
                    print(
                        f"skipping malformed RPC frame ({malformed_streak} consecutive): "
                        f"JSON decode error: {error}",
                        file=sys.stderr,
                    )
                    if malformed_streak >= _MAX_CONSECUTIVE_MALFORMED_FRAMES:
                        self._fail_pending_calls(
                            RpcProtocolError(
                                f"RPC stream produced {malformed_streak} consecutive malformed frames; giving up"
                            )
                        )
                        print("stdin reader: too many consecutive malformed frames; disconnecting", file=sys.stderr)
                        break
                except Exception as error:
                    # A bad frame must not tear down the session either; but a
                    # handler that throws repeatedly is the same broken-stream
                    # case, so it feeds the same trip-wire.
                    malformed_streak += 1
                    print(
                        f"skipping undecodable RPC frame ({malformed_streak} consecutive): {error}",
                        file=sys.stderr,
                    )
                    if malformed_streak >= _MAX_CONSECUTIVE_MALFORMED_FRAMES:
                        self._fail_pending_calls(
                            RpcProtocolError(
                                f"RPC stream produced {malformed_streak} consecutive undecodable frames; giving up"
                            )
                        )
                        print("stdin reader: too many consecutive malformed frames; disconnecting", file=sys.stderr)
                        break
        except asyncio.CancelledError:
            pass
        except Exception as error:
            self._fail_pending_calls(error if isinstance(error, Exception) else RpcProtocolError(str(error)))
            print(f"stdin reader error: {error}", file=sys.stderr)
        finally:
            self.disconnected.set()

    def _handle_response(self, response: Dict[str, Any]) -> None:
        """Dispatch one decoded frame: exec-family frames go to the handler;
        anything else resolves the pending call with the matching id (an `error`
        dict becomes ToolCallError)."""
        if response.get("type") in ("exec", "export_script", "inspect"):
            handler = self.exec_handler
            if handler is not None:
                handler(response)
            return
        call_id = response.get("id")
        if call_id and call_id in self.pending_calls:
            future = self.pending_calls[call_id]
            if not future.done():
                error = response.get("error")
                if isinstance(error, dict):
                    future.set_exception(ToolCallError(error))
                elif error:
                    future.set_exception(Exception(str(error)))
                else:
                    future.set_result(response.get("value"))
            del self.pending_calls[call_id]

    async def call(self, tool: str, params: Dict[str, Any], timeout: float | None = None) -> Any:
        """Invoke a host tool and await its result value. Raises ToolCallError (or
        a plain Exception) for error replies, and Exception on timeout (per-call
        `timeout` in seconds, default 300)."""
        self.call_id += 1
        call_id = f"call_{self.call_id}"
        request = {
            "type": "tool_call",
            "id": call_id,
            "tool": tool,
            "params": params,
        }

        # Register before writing so a fast host response can never be dropped.
        future: asyncio.Future[Any] = asyncio.get_running_loop().create_future()
        self.pending_calls[call_id] = future
        try:
            protocol_write = globals().get("_ptc_protocol_write")
            if callable(protocol_write):
                protocol_write(request)
            else:
                print(json.dumps(request), flush=True)

            try:
                effective_timeout = self.default_call_timeout if timeout is None else timeout
                return await asyncio.wait_for(future, timeout=effective_timeout)
            except asyncio.TimeoutError as error:
                raise Exception(f"Tool call '{tool}' timed out") from error
        finally:
            self.pending_calls.pop(call_id, None)

    async def cleanup(self) -> None:
        """Fail pending calls and cancel the reader task. Idempotent."""
        self._fail_pending_calls(RpcProtocolError("RPC client shut down"))
        if self.reader_task:
            self.reader_task.cancel()
            try:
                await self.reader_task
            except asyncio.CancelledError:
                pass
            self.reader_task = None


_rpc = RpcClient()

# Per-cell tool-call ledger. session.py clears this at the start of each exec
# and summarizes it into the cell's model-facing `tools:` section, so the model
# can see which Pi tools a cell used and how often.
cell_tool_calls: list[str] = []


async def _rpc_call(tool: str, params: Dict[str, Any], timeout: float | None = None) -> Any:
    """Call a host tool, first recording it in the per-cell tool-call ledger
    (cell_tool_calls) that feeds the model-facing `tools:` section."""
    cell_tool_calls.append(tool)
    return await _rpc.call(tool, params, timeout=timeout)
