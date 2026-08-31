import asyncio
import json
import sys
from typing import Any, Dict, Optional


class ToolCallError(Exception):
    def __init__(self, payload: Dict[str, Any]):
        self.payload = payload
        message = str(payload.get("message") or "Tool call failed")
        stack = payload.get("stack")
        formatted = f"{message}\n{stack}" if isinstance(stack, str) and stack else message
        super().__init__(formatted)


class RpcProtocolError(Exception):
    pass


class RpcClient:

    def __init__(self):
        self.call_id = 0
        self.pending_calls: Dict[str, asyncio.Future[Any]] = {}
        self.reader_task: Optional[asyncio.Task[Any]] = None

    async def start_reader(self) -> None:
        self.reader_task = asyncio.create_task(self._stdin_reader())

    def _fail_pending_calls(self, error: Exception) -> None:
        for future in self.pending_calls.values():
            if not future.done():
                future.set_exception(error)
        self.pending_calls.clear()

    async def _stdin_reader(self) -> None:
        try:
            loop = asyncio.get_event_loop()
            reader = asyncio.StreamReader()
            protocol = asyncio.StreamReaderProtocol(reader)
            await loop.connect_read_pipe(lambda: protocol, sys.stdin)

            while True:
                line = await reader.readline()
                if not line:
                    self._fail_pending_calls(RpcProtocolError("RPC host closed stdin while tool calls were pending"))
                    break

                try:
                    response = json.loads(line.decode().strip())
                    self._handle_response(response)
                except json.JSONDecodeError as error:
                    raise RpcProtocolError(f"JSON decode error: {error}") from error
                except Exception as error:
                    raise RpcProtocolError(f"Error handling response: {error}") from error
        except asyncio.CancelledError:
            pass
        except Exception as error:
            self._fail_pending_calls(error if isinstance(error, Exception) else RpcProtocolError(str(error)))
            print(f"stdin reader error: {error}", file=sys.stderr)

    def _handle_response(self, response: Dict[str, Any]) -> None:
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

    async def call(self, tool: str, params: Dict[str, Any]) -> Any:
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
                return await asyncio.wait_for(future, timeout=300.0)
            except asyncio.TimeoutError as error:
                raise Exception(f"Tool call '{tool}' timed out") from error
        finally:
            self.pending_calls.pop(call_id, None)

    async def cleanup(self) -> None:
        self._fail_pending_calls(RpcProtocolError("RPC client shut down"))
        if self.reader_task:
            self.reader_task.cancel()
            try:
                await self.reader_task
            except asyncio.CancelledError:
                pass
            self.reader_task = None


_rpc = RpcClient()


async def _rpc_call(tool: str, params: Dict[str, Any]) -> Any:
    return await _rpc.call(tool, params)
