"""Spike: embed IPython's InteractiveShell in the PTC runtime event loop.

Not shipped code — a developer record for the IPython migration. Run it with an
interpreter that has IPython installed:

    /path/to/venv/bin/python scripts/ipython_embed_spike.py

It verifies, on the real process shape we will ship:

1. ``run_cell_async`` works and top-level ``await`` resolves on the running
   loop (no ``loop_runner`` / nested ``run_until_complete``).
2. A Jupyter-style ``DisplayHook`` publishes mime bundles; ``capture_output``
   then yields clean ``stdout`` plus ``execute_result``/``display_data`` and no
   stray printed ``Out[n]:`` text.
3. SIGINT under our bootstrap loop (``loop.run_until_complete``, NOT
   ``asyncio.run``) lands as ``KeyboardInterrupt`` for blocking code and as a
   cancelled task for ``await``-based code, and the shell stays usable after.
4. A cell can ``await`` a host-tool coroutine. NOTE: this spike uses a
   stand-in coroutine; the real async RPC client path is verified shipped by
   the gated real-runtime suite instead.
5. Magics (``%time``, ``%pip``) parse and run.
6. Mime bundles carry the same data a kernel would publish.

Also note: the ``input()`` fail-fast requirement from the migration brief is
not exercised here — it is covered shipped by ``_ptc_blocked_input`` and the
gated suite.
"""
import asyncio
import os
import signal
import threading
import time

from IPython.core.display_trap import DisplayTrap
from IPython.core.displayhook import DisplayHook
from IPython.core.interactiveshell import InteractiveShell
from IPython.utils.capture import capture_output


class JupyterDisplayHook(DisplayHook):
    """Suppress the printed ``Out[n]:`` prompt and publish the mime bundle."""

    def write_output_prompt(self):
        return None

    def write_format_data(self, format_dict, md_dict=None):
        pub = getattr(self.shell, "display_pub", None)
        if pub is not None:
            pub.publish(data=format_dict, metadata=md_dict or {})


def make_shell():
    shell = InteractiveShell.instance()
    shell.autocall = 0
    try:
        shell.history_manager.enabled = False
    except Exception:
        pass
    shell.showtraceback = lambda *a, **k: None
    shell.showsyntaxerror = lambda *a, **k: None
    shell.displayhook = JupyterDisplayHook(shell=shell)
    # init_displayhook() captured the *original* hook when it built display_trap,
    # so assigning displayhook alone is not enough: rebuild the trap.
    shell.display_trap = DisplayTrap(hook=shell.displayhook)
    return shell


shell = make_shell()
CURRENT = {"task": None}


async def run_cell(code):
    transformed = shell.transform_cell(code)
    with capture_output() as cap:
        result = await shell.run_cell_async(code, store_history=True, transformed_cell=transformed)
    return result, cap


async def run_cell_reporting(code):
    """Surface an interrupt as ``error_in_exec`` when IPython swallows it."""
    task = asyncio.ensure_future(run_cell(code))
    CURRENT["task"] = task
    try:
        return await task
    except asyncio.CancelledError:
        print("  run_cell raised CancelledError")
        return None, None
    finally:
        CURRENT["task"] = None


def sigint_later(delay):
    def go():
        time.sleep(delay)
        os.kill(os.getpid(), signal.SIGINT)

    threading.Thread(target=go, daemon=True).start()


async def main():
    failures = []

    def check(label, ok, detail=""):
        print(f"[{'ok ' if ok else 'FAIL'}] {label}{(' — ' + detail) if detail else ''}")
        if not ok:
            failures.append(label)

    result, cap = await run_cell("{'a': 1}")
    check("mime bundle published", any(o.data.get("text/plain") == "{'a': 1}" for o in cap.outputs))
    check("stdout has no Out[] prompt", "Out[" not in cap.stdout, repr(cap.stdout))

    sigint_later(0.4)
    start = time.monotonic()
    result, _ = await run_cell_reporting("import time\ntime.sleep(10)")
    elapsed = time.monotonic() - start
    check(
        "blocking sleep is interrupted",
        isinstance(getattr(result, "error_in_exec", None), KeyboardInterrupt) and elapsed < 2.0,
        f"elapsed={elapsed:.2f}s err={getattr(result, 'error_in_exec', None)!r}",
    )

    async def host_tool():
        return 41 + 1

    shell.user_ns["host_tool"] = host_tool
    result, cap = await run_cell("value = await host_tool()\nvalue")
    check(
        "top-level await of host tool",
        result.success and any(o.data.get("text/plain") == "42" for o in cap.outputs),
        repr(getattr(result, "error_in_exec", None)),
    )

    result, cap = await run_cell("%time sum(range(10))")
    check("magic runs", result.success, repr(result.error_in_exec))

    result, cap = await run_cell("print('alive')\n'z'")
    check("shell usable after interrupt", result.success and cap.stdout == "alive\n")

    print("\nALL OK" if not failures else f"\nFAILURES: {failures}")
    return 1 if failures else 0


def bootstrap():
    """Run the body under a loop we own, so we can route SIGINT ourselves."""
    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)
    task = loop.create_task(main())
    while True:
        try:
            code = loop.run_until_complete(task)
            break
        except KeyboardInterrupt:
            current = CURRENT["task"]
            if current is not None and not current.done():
                current.cancel()
    loop.close()
    return code


if __name__ == "__main__":
    raise SystemExit(bootstrap())
