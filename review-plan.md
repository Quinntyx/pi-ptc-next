I verified the key high/medium findings directly against the source (custom-tool-manager hot reload, DockerSandbox terminate/ensureContainer/stopContainerNow, execFilePtc, rpc-protocol images casts, tool-adapters regexes vs actual pi notice strings in node_modules, recovery-classifier patterns, subagents-env lock, benchmark-runner CLI parsing). All check out; I found nothing to discard. Below is the consolidated plan.

# Repository Review — Improvement Plan

## Summary

**pi-ptc-next** is a pi-coding-agent extension providing persistent Python tool-calling sessions: the model provisions a Python kernel and sends code chunks via `python_exec`, with Python calling real host tools through a Node↔Python JSON-RPC bridge (one-shot and persistent-session transports), optionally inside a Docker sandbox. Supporting subsystems cover tool discovery/policy, result normalization, recovery heuristics, telemetry, subagent orchestration, and a deterministic JSON eval/benchmark harness.

**Overall health:** The core happy path is solid and well-structured, with good separation (contracts/, execution/, tools/) and a real test suite. However, the audit found **5 high-severity bugs**, several concentrated in the two least-tested areas: **Docker sandbox mode** (terminate orphaning interpreters, cwd-blind container reuse, silent env loss) and **custom tool hot reload** (broken for the documented ESM style). The benchmark harness also fails its own seeded eval out of the box. A large tail of dead/duplicated code and stale pre-rename tool names (`python_exec` → `exec_cell` etc.) indicates an incomplete refactor; fixing the naming drift would eliminate ~6 findings at once. Subprocess mode — the default — is in much better shape than Docker mode.

---

## Bugs

Ordered by severity, deduplicated (Docker-terminate findings from "Sandbox" and "Python session manager" components merged; `callers: []` findings from two components merged; images-validation findings from two components merged).

### High

**H1. Docker `terminate()` kills only the `docker exec` client, orphaning the in-container interpreter** — `src/sandbox-manager.ts:224-227` (verified: `terminate` is just `proc.kill(signal)` on the CLI client).
`docker exec` clients dying does not signal the exec'd process. This breaks interrupt semantics twice: `sendSignal("SIGINT")` (`src/python-session-manager.ts:449-451`) and the 5s grace `terminateProcess("SIGKILL")` (~455-470). SIGKILL can never be forwarded, so the Python interpreter keeps executing the chunk while the host reports the session dead. SubprocessSandbox handles this correctly via `process.kill(-pid)`; Docker has no counterpart.
**Fix:** in `DockerSandbox.terminate`, signal the in-container process (`docker exec <id> kill -<sig> <pid>`, needing the in-container PID — e.g. discover it via `pgrep` or wrap the interpreter in a tiny init that forwards signals), or fall back to stop/recreate the container for SIGKILL. Add tests with a mocked docker binary.

**H2. `ensureContainer` reuses the container regardless of cwd** — `src/sandbox-manager.ts:169-180` (verified: reuse condition checks only `containerId`/`activeExecutions`/`lastUsed`; cwd only feeds the read-only `/workspace` mount of the *first* spawn).
A second session in a different directory (`PythonSessionManager` passes per-session cwd, `src/python-session-manager.ts:825`) runs in a container whose `/workspace` holds the first directory while `PTC_HOST_WORKSPACE_ROOT` is set to the new cwd — path translation and file access silently wrong.
**Fix:** key reuse to cwd: store `mountedCwd` and recreate the container when it differs. (H1's "recreate container" fix composes with this.)

**H3. ESM-syntax custom tools never hot-reload** — `src/custom-tool-manager.ts:37-44` (verified: `delete require.cache[require.resolve(filePath)]` then `await import(filePath)`; `require.cache` doesn't cover ESM).
Every fs-watch reload re-registers stale code while the user believes the tool updated. Only CJS-style `module.exports` tools (all the test fixtures) reload; the documented style (`tools/README.md`, `tools/get_weather.js.example`) uses `export default`.
**Fix:** cache-bust the import: `await import(pathToFileURL(filePath).href + "?t=" + Date.now())`. Add an `export default` test fixture (see test gap below).

**H4. `execFilePtc` treats spawn failures, timeouts, and aborts as success** — `src/index.ts:566-589` (verified: rejects only when `error.code === undefined`; Node sets `code` on spawn failure and `code = null` on timeout).
Missing `uv` binary (ENOENT) or a timed-out install resolves with partial output; the `/installed|uninstalled/` heuristic then reports "already satisfied" to the model. Also the AbortSignal is checked only after the child exits and is never wired to `child.kill()`, so an "aborted" call keeps installing for up to 180s.
**Fix:** check `error.killed`/`error.signal` (timeout) and `error.code === "ENOENT"` explicitly and reject; obtain the child handle (use `spawn` + manual pipe collection, or `execFile`'s returned ChildProcess) and kill it on abort, checking the signal before the exit result.

**H5. Shipped eval case `recovery-missing-await` fails under the repo's own harness** — `.pi/evals/ptc/cases/recovery-missing-await.json` vs `shouldAutoRoutePromptToCodeExecution` (`src/utils.ts`).
The prompt contains no `python_exec` keyword, fanout, or recognized processing verb, so it routes "direct" and the case's `observed_first_path=code_execution` rule always fails (verified by the auditor running the suite; the other five cases pass).
**Fix:** reword the case prompt to include a routing trigger, or extend the routing heuristics; then make `runBenchmarkSuite` (or a small smoke test) assert all shipped cases pass, so the seeded suite can't silently rot.

### Medium

**M1. Recovery classifier produces false "missing-await" recoveries** — `src/recovery-classifier.ts` (verified patterns).
Three compounding defects: (a) `helperCallPattern` (`:14`) doesn't exclude attribute access, so `open(p).read()` / `f.find(x)` match; (b) `missingAwaitDiagnosticPattern` (`:22`) accepts a bare `\bawait\b`, e.g. a traceback echoing `await some_user_fn()` or `SyntaxError: 'await' outside function`; (c) `stripComment` (`:31-33`) truncates at `#` inside string literals, dropping real evidence. A benign cell matching (a)+(b) burns the single `recoveryAttempted` slot (`src/recovery-state.ts:69`) and injects a misleading hint (`src/index.ts:1030-1031`).
**Fix:** use `(?<![.\w])` before helper names; require coroutine/never-awaited markers instead of bare `\bawait\b`; implement a quote-aware comment stripper. Extend `test/recovery-classifier.test.ts` with these cases.

**M2. find/ls truncation notices leak into Python results as phantom file paths** — `src/tool-adapters.ts` `splitNonEmptyLines` (verified against `node_modules/.../find.js:74-87`, `ls.js:90-105`).
The filter regex `^\[(Showing|Use offset=|Output truncated)` doesn't match pi's actual notices (`"[N results limit reached. …]"`, `"[NKB limit reached]"`), which are returned as list entries; downstream per-file processing then fails on them.
**Fix:** prefer structured `details` (`details.truncation`, `details.entryLimitReached`, `details.resultLimitReached`) over text scraping; minimally, add the observed notice patterns to the filter.

**M3. `parseGrepMatches` corrupts paths containing hyphen-digit segments** — `src/tool-adapters.ts:61` (verified lazy regex with `[:-]` separators).
`v2-2024-report.md:12: text` parses as path=`v2`, line=2024. Also pi's `[N matches limit reached…]` notice and `details.matchLimitReached` are dropped, so Python can't see grep truncation.
**Fix:** anchor on the last `:<digits>:` occurrence (e.g. require `:` separators for the match line, treat `-` only for context lines after a confirmed `path:line`), and surface `matchLimitReached` in the normalized value.

**M4. `stopContainerNow`'s error tolerance is dead code** — `src/sandbox-manager.ts:154-166` (verified: `stdio: "ignore"` discards stderr, so `error.message` can never contain "No such container").
A container that disappeared externally makes `ensureContainer` abort and every spawn fail with "Failed to create/use Docker container" even though a fresh container would work.
**Fix:** capture stderr or check `error.status`; treat "no such container" as success. Combine with a one-shot transparent recreate when a live `docker exec` fails with "is not running" (related improvement below).

**M5. `provision_dependency` silently targets the host python3 in Docker mode** — `DockerSandbox` doesn't implement `resolvePythonExecutable` (optional in `src/contracts/execution-types.ts:12`), so `index.ts:368-370` runs `uv pip install --python python3` on the host; the container (mounted `--network none`, `src/sandbox-manager.ts:175`) could never install anyway.
**Fix:** reject `provision_dependency` with an explicit "unsupported in Docker mode" error, or implement `resolvePythonExecutable` for the container (returning the in-container interpreter and an in-container install path).

**M6. Env-inheritance assumption breaks in Docker: `PI_SUBAGENTS_PROFILE` silently ignored** — `src/python-session-manager.ts:818-823` sets `process.env` assuming the spawn inherits it; `docker exec` does not forward host env.
**Fix:** pass an explicit env map to `sandboxManager.spawn` (see also consistency item C10 on the `process.env` mutation) and have `DockerSandbox.spawn` forward it via `-e` flags.

**M7. `images` arrays are the only unvalidated RPC frame fields** — `src/rpc-protocol.ts:92` (`value.images as any`) and `:138` (`as never`), verified. Malformed entries flow into `CodeExecutionResult.images` and then into tool-result content built at `src/index.ts:1012-1015`.
**Fix:** add a validator mirroring `isRpcErrorPayload` (array of `{mimeType: string, data: string}` per `PtcImageArtifact`) and use it in `validateCompleteMessage`/`validateExecDoneMessage`. Relatedly, `validateExecErrorMessage` (`:143-150`) strips the declared `interrupted/line/source` fields (`src/contracts/execution-types.ts:54`) — currently latent because session frames bypass validation; fix the validator to preserve them.

**M8. An exception in the host `onUpdate` callback is treated as a protocol failure and kills the Python process** — `src/rpc-protocol.ts:297-301` wraps the whole `handleLine` switch in one catch; the three `onUpdate?.()` sites (`:530, :553, :566`) run inside it, so a faulty UI callback triggers `rejectOnce` → `onFailure` → child termination.
**Fix:** wrap each `onUpdate` invocation in its own try/catch that logs via `logWarning`.

**M9. Subagents env lock is check-then-write, not atomic** — `src/subagents-env.ts:206-214` (verified `existsSync` + `writeFileSync`).
Two concurrent pi processes both "hold" the lock and race `git fetch/reset --hard` plus uv/pip installs into the shared venv. Compounding: the stale-lock breaker plus unconditional `finally { rmSync }` (`:222`) can delete another (long-running, >5 min) sync's live lock, allowing a third process in.
**Fix:** acquire with `openSync(lockFile, "wx")` (O_CREAT|O_EXCL), write the holder's pid, and in `finally` only remove the lock if it still contains your pid.

**M10. Crashed sessions are never reaped; `waitReady` failure leaks the interpreter** — `src/python-session-manager.ts`. A crashed interpreter stays in `sessions` with `killed: false`, permanently counting against `maxPythonSessions` (`provision()` live-count check, `:791-798`) with no id the model can `dispose()`. And if `protocol.waitReady(15_000)` rejects (`:858`), provision throws without terminating the spawned process (and its Docker container), and the record was never inserted so `disposeAll()` can't clean it.
**Fix:** listen for process exit at the manager level and mark/evict dead records; in `provision()`, wrap `waitReady` in try/catch that terminates the sandbox process before rethrowing.

**M11. `PersistentSessionProtocol.exec` wedges the protocol if `send()` throws; exit doesn't fail inspect/export promises** — `src/python-session-manager.ts:571-590`. Promise state is armed before `send()`; a throw leaves `execResolve` set forever so every later `exec` hits the busy check and the session wedges until idle-timeout SIGKILL (up to ~270s+5s). `failAllPending` (`:204-209`) rejects only `execRejectRef` — pending `inspectKernel`/`exportScript` hang until timeout, and their state isn't cleared so a late frame can resolve a stale promise.
**Fix:** arm promise state after a successful `send()` (or clear it in a catch); have `failAllPending` reject and clear *all* pending call kinds.

**M12. `backgrounded` never resets after the exec finishes** — `src/python-session-manager.ts:596-598, 663-671`. `currentExecId()` stays truthy, so `SessionSummary.running` reports true forever, `mostRecentActive()` keeps returning a finished session as the `/ptc` default, and `interruptRunning()` returns true while `interrupt()` silently no-ops.
**Fix:** clear the flag when the exec promise settles (in the same place `execResolve` is cleared).

**M13. `buildToolDescription` is dead — the dynamic tool description is never attached** — `src/index.ts:208-260` (verified no callers). The model is never told which host tools are callable inside the kernel, nor shown the docker-behavior warning; the registered `exec_cell` uses only the static `EXEC_CELL_DESCRIPTION`.
**Fix:** wire it into the `exec_cell`/`inspect_kernel` descriptions (recomputing on `onToolSetChanged`) or delete it.

**M14. Benchmark CLI: unknown `--cases` IDs yield a green empty run; missing flag values crash opaquely** — `src/benchmark-runner.ts` (verified).
`loadEvalCasesFromDisk` (`:168`) filters by ID but never checks that every requested ID matched; `--cases nonexistent` writes a `total_cases=0` result and exits 0 — a CI typo looks like a passing run. In `parseCliArgs` (`:400-440`), `const next = argv[index + 1]` is unchecked: `--provider` as the last argv becomes `undefined` and later throws `Cannot read properties of undefined (reading trim)` inside `getProviderModelSlug`; `--provider --model m` silently consumes `--model` as the value; `--timestamp` is unvalidated and used verbatim in the results filename.
**Fix:** error out when requested case IDs are unmatched; validate that `next` exists and isn't another flag for each value-taking option; validate the timestamp format.

### Low

**L1.** `fs.watch` errors unhandled — `src/custom-tool-manager.ts:123`: no `'error'` listener on the FSWatcher; deleting/renaming the tools dir throws `ERR_UNHANDLED_ERROR` and watching silently stops. Add an `'error'` handler that logs and attempts a re-watch.

**L2.** In-flight reconciles aren't serialized and can outlive `close()` — `src/custom-tool-manager.ts:203-217, 147-155`: overlapping reconciles for the same file complete out of order (last-writer-wins by completion time, not mtime), and a reconcile past its debounce can register tools after session shutdown (`index.ts` `handleSessionShutdown`). Track per-file in-flight promises (chain or drop), and add a `closed` flag checked in `reconcileFile`/`registerLoadedTool`.

**L3.** Explicit `ptc.callers: []` diverges between the two implementations — `CustomToolManager.setToolActive` (`src/custom-tool-manager.ts:159`) treats `[]` as "not direct" (never activated), while `ToolRegistry.getConfiguredCallers` (`src/tool-registry.ts:28-49`) treats `[]` as unset and grants both callers — the opposite of a deny-intent. Extract one shared helper in `src/contracts/tool-types.ts` and decide the semantics (recommend: explicit empty allowlist = no callers, documented).

**L4.** `buildToolMap` merge replaces the clean custom-tool schema with pi's activity-label-wrapped copy — `src/tool-registry.ts:171-182` overwrites `description`/`parameters` from `pi.getAllTools()`, so generated Python wrappers and `describePythonHelpers` gain an `activity: Optional[str]` kwarg the author never declared (`src/tools/tool-wrapper.ts`, `src/tools/python-tool-contract.ts`). Prefer the clean `customTools` copy for schema/params; use pi's copy only for labels.

**L5.** `removeTool` marks arbitrary names as extension-owned even when nothing was removed — `src/tool-registry.ts:106-109`: a later `removeTool("bash")` (no-op) permanently hides the builtin in `buildToolMap`. Only add to `extensionOwnedToolNames` when `customTools.delete(name)` returned true (or when the name was previously upserted).

**L6.** Custom tools colliding with builtin names inherit builtin classification and fabricated result types — `classifyBuiltinTool` (`src/tools/python-tool-contract.ts:41-48`) falls back to the builtin contract keyed only by `tool.name`, and `buildReadWrapper` (`src/tools/tool-wrapper.ts:37-50`) hardcodes name/params. Enforce name uniqueness against builtins at registration (warn + reject), which also resolves the duplicate-tool-name clobbering in `fileToTool`/`ToolRegistry.customTools` (`src/custom-tool-manager.ts:171-201`): warn on cross-file duplicate names and treat the second as a load error.

**L7.** `toScript` overwrite guard checks the wrong directory after the first iteration, and mangles non-`.py` names — `src/python-session-manager.ts:1149-1157`: the dedup loop's `target = path.join(dir, …)` isn't re-resolved against `options.cwd`, so with a relative path and differing host cwd the `existsSync` guard misses and the export overwrites; `baseName.replace(/(\.py)?$/, …)` turns `foo.txt` into `foo.txt-2.py`. Resolve every iteration against `options.cwd`; only append `-N` for `.py` names (or preserve the original extension).

**L8.** Magic guard rejects valid Python — `src/python-runtime/session.py:67, 156-160`: `_PTC_MAGIC_RE = r"\s*[%!]"` applied to raw lines rejects `%`/`!` inside triple-quoted strings or after an explicit backslash join. Only apply the magic check when `ast.parse` fails (or check after parse).

**L9.** One malformed stdin frame kills the whole persistent session — `src/python-runtime/rpc.py:47-77` + `session.py:712-762`: a `JSONDecodeError` on a single line sets `disconnected` and shuts down. Skip-and-log the bad line (with a counter/trip-wire for genuinely broken streams) instead of dying.

**L10.** RPC stdin reader incompatible with Windows ProactorEventLoop — `src/python-runtime/rpc.py:52` (`connect_read_pipe` raises NotImplementedError); the host side otherwise treats win32 as supported (`src/sandbox-manager.ts:56-69`). Add a platform guard with a threaded-reader fallback (or a documented "Windows unsupported" error at startup).

**L11.** `renderCompletedOutput` prints `NaNs` for validation-failure/rejected results — `src/index.ts:145` divides `details.durationMs` which those early-return detail objects lack. Guard with `typeof durationMs === "number"`.

**L12.** Repaint ticker prefers a stale global subagent snapshot — `src/index.ts:975`: `sessionState.lastSubagentSnapshot` is never cleared at exec start, so a new `exec_cell` briefly renders the previous workflow's panel. Prefer `lastUpdate.details.subagentSnapshot` or reset the global when a foreground exec begins.

**L13.** Single-slot foreground state clobbered by parallel `exec_cell` calls — `src/index.ts:961-963, ~1040`: `activeForegroundToolCallId/SessionId` assume one in-flight exec, so `/ptc interrupt|kill` default targeting (`resolveTargetSession`, `:1097-1109`) can hit the wrong session. Use a `Map<toolCallId, sessionId>` or derive from the session manager's running state.

**L14.** File-mode cells record a placeholder as chunk code — `src/index.ts:983` passes `"(exec_cell file mode)\n"`, so `record.chunks`/`toScript` export the placeholder instead of the file's content, and `validateUserCode` (`src/python-session-manager.ts:1096`) is silently bypassed. Read the file content host-side (or thread `source_path` through export and validation).

**L15.** RPC output char accounting mixes Python code points with JS UTF-16 units — Python counts `len(str)` (`src/python-runtime/runtime.py:352`), Node counts `text.length` (`src/rpc-protocol.ts:306-317, 381-396`); non-BMP chars inflate `observedChars` up to 2x, triggering premature truncation with a false footer. Compare like with like (e.g. `[...text].length` or a shared code-point count on the Node side).

**L16.** `activeTool` metric racy under parallel nested calls — `src/rpc-protocol.ts:564, 585, 498`: line dispatch is concurrent (`:299`) and Python supports parallel calls, so `details.activeTool` reflects whichever call started/finished last. Track per-call or drop the field for concurrent cases.

**L17.** Subagent panel: status `closed` renders ✓ but is excluded from done counts — `src/execution/subagent-panel.ts:140, 252` vs footer totals (`:92`) and `updateSubagentFooter` in `src/index.ts` (~1228). Unify on one "done" predicate. Also `formatCtx` (`:16-21`) divides by `ctx.limit` without a zero guard (renders `Infinity%`).

**L18.** Stale-lock removal can delete another process's live lock — covered under M9 (pid-tagged locks fix both).

---

## Prospective Improvements

Prioritized; highest value first.

1. **Add real test coverage for DockerSandbox** (medium impact, biggest blind spot). `test/sandbox-manager.test.ts` only covers subprocess mode. Use an injectable docker command / PATH shim to test `ensureContainer` (incl. cwd-keyed reuse from H2), `stopContainerNow` error paths (M4), `terminate` semantics (H1), expiry timer, and cleanup. Relatedly, `test-docker.sh` is a manual monitor (no assertions, blocks on `read`, infinite loop) — either convert it into an integration test or rename it `debug-docker.sh`.

2. **Wire or remove the unwired background-exec API.** `execBackground/waitForExec/markBackgrounded/pendingBackground` (`src/python-session-manager.ts:932-1022, 1046-1080`) have no callers outside the manager; `test/index.test.ts` only stubs them. If kept: fix the documented semantics (`execBackground` docstring says "returns immediately" but awaits `record.queue`; `waitForExec`'s deadline starts at call time so queued time consumes the budget) and replace `waitForExec`'s 200ms busy-poll with awaiting the exec promise it already holds (also fixes the "poll never notices process death" gap). If not kept, delete — dead surface area invites drift.

3. **Make the benchmark harness CI-usable and non-tautological.** Set `process.exitCode` on non-empty `comparison.regressions` (`src/run-benchmarks.ts` currently only fails on throw); report added/removed case IDs in `compareBenchmarkRuns` (regression-by-omission is invisible today); have the deterministic executor actually exercise `classifyCodeExecutionFailure` instead of echoing the case's own `acceptance.rules` back as `recovery_attempted`/`failure_class` (self-fulfilling assertions can't catch classifier regressions); validate rule keys in `validateEvalCase` (`src/eval-cases.ts`) against the known set so a typo'd rule fails at load; wrap `JSON.parse` in `loadEvalCasesFromDisk` with the file path; sanitize the ISO timestamp in `getDefaultBenchmarkResultPath` (colons break Windows/shells); derive `parseFailureClass` from the `RecoveryFailureClass` union instead of hardcoded strings. Add tests for `parseCliArgs` (missing/flag-like values), unknown `--cases`, malformed case files, and `readBenchmarkRun` against shape-mismatched baselines.

4. **Close the custom-tool-manager test gaps that masked H3.** Add an `export default` (ESM) fixture — this alone would have caught the hot-reload bug — plus cases for duplicate tool names across files, a custom tool shadowing a builtin, `fs.watch` error handling, and reload events after `close()`.

5. **Runtime robustness hardening (Python side).** Add a startup `sys.version_info >= (3,10)` assertion (PEP 604 unions in *evaluated* annotations raise `TypeError` at def-time on ≤3.9; `func.type_params` assumes 3.12+), since `SubprocessSandbox` falls back to bare `python3` (`src/sandbox-manager.ts:39-49`); make `RpcClient.call`'s hardcoded 300s timeout (`src/python-runtime/rpc.py:115`) configurable/host-aligned; replace deprecated `asyncio.get_event_loop()`; bound `_ptc_notebook_cells` re-serialization (O(n²) I/O per cell); ensure `loop.close()` runs even on `KeyboardInterrupt` in the bootstrap finally.

6. **Bound Node-side nested tool calls.** Apply a size cap (reuse `utils.truncateOutput`) when JSON-serializing `tool_result` payloads in `send()` (`src/rpc-protocol.ts:594-610`) — a huge `read` result is written whole to stdin today — and add a Node-side per-call timeout so abandoned calls (Python gives up after its 300s `wait_for`) don't keep executing and write results to a peer that dropped them.

7. **Improve Docker-mode resilience.** Transparently recreate the container once when an exec fails with "is not running" (complements M4); unref the cleanup interval and label containers for external reaping (leaks on host crash / extension reload — `index.ts` disposes the session manager but not the sandbox); replace `execFileSync` docker calls with async exec (a slow daemon or an image pull blocks the entire pi host on the hot path); pass a configurable or settings-derived container idle TTL instead of reusing `EXECUTION_TIMEOUT = 270_000` while the real timeout is configurable (`settings.executionTimeoutMs`).

8. **Fix `loadPythonRuntimeSources` re-reading 3 files synchronously on every execution** (`src/execution/runtime-assets.ts:27-38`; once per `execute` and per session provision). Memoize per resolved runtimeDir. Delete the pass-through `CodeExecutor.loadRuntimeFiles` wrapper.

9. **Surface abort reasons.** `RpcProtocol`'s abort handler always rejects with a fixed `PtcAbortError("Execution aborted")` and ignores `executionController.signal.reason` (which `handleCallerAbort`/`onFailure` carefully forward in `src/code-executor.ts:81-99`). Propagate the reason so callers can distinguish user aborts from protocol failures.

10. **Cache hygiene in `index.ts`.** Initialize `globalThis.__ptcTokensSaved` from the existing global so the tally survives extension reloads (`src/index.ts:57-59`); don't cache a failed shiki highlighter promise forever (`:660-676`) so a transient failure doesn't permanently disable approval highlighting.

11. **Subagents sync operational polish.** Retry sooner when `stamp.ok` is false and the runtime is missing (a failed initial clone currently blocks retry for 24h; the `ok` field is written but never read); rotate/size-cap `subagents-sync.log`.

12. **Recovery semantics polish.** Don't stamp aborts/timeouts (`PtcAbortError`/`PtcTimeoutError` from user Ctrl-C or timeouts) as `terminalState="failed_without_recovery"` in `noteCodeExecutionFailure` (`src/recovery-state.ts` / `src/index.ts:1034`); extend `iteratedHelperPatterns` to common forms (`"\n".join(read(f))` currently misclassifies as missing-await, `sum/min/max(...)`, `dict(zip(...))`).

13. **Test the remaining untested surfaces.** `buildSessionPrelude` autoimport gating and the `PTC_USER_CODE_LINE_COUNT` handoff; `noteCodeExecutionSuccess`/`terminalState` transitions/`buildPtcRecoveryDetails` in `test/recovery-state.test.ts`; `ensureSubagentsEnv` sync orchestration (stamp writing, `needsInstall`, lock acquire/break/remove — injectable `cacheRoot`/`now` already exist); the cell-approval dialog flow, `execFilePtc` error paths, and the `/ptc` command handler in `test/index.test.ts`; wrapper generation from realistic pi builtin schemas (currently minimal stubs, so the activity-param leak in L4 would go uncaught). Also add reserved-name coverage for prelude globals (`subagents`, `pi_subagents`, `PTC_*`) in `RESERVED_PYTHON_HELPER_NAMES` (`src/tools/python-tool-contract.ts:19-33`) — a custom tool named `subagents` is silently shadowed by the autoimport.

14. **`serializeError` redaction.** Consider stripping host stack traces from tool_result error frames when running sandboxed (`src/rpc-protocol.ts:203-214` → `src/python-runtime/rpc.py:8-14` → model context); they leak host paths into Docker containers and model output.

---

## Consistency Fixes

1. **Stale pre-rename tool names everywhere (biggest single cleanup).** The tools are now `provision_kernel / exec_cell / list_kernels / inspect_kernel / provision_dependency`, but: `PTC_OWNED_TOOLS` still lists `provision_python_session/python_exec/python_session_to_script` (`src/tool-registry.ts:18`) and the denylist is dead code — the intended "never expose PTC machinery" invariant holds only incidentally because pi-registered tools lack `ptc` metadata; `resolveTargetSession`'s error says "Provision one with provision_python_session first" (`src/index.ts:1108`); `shouldAutoRoutePromptToCodeExecution` triggers only on the literal `python_exec` (`src/utils.ts:104`); `validateUserCode`'s error (`src/utils.ts:154`) and the subagent depth note (`src/index.ts:1286`) mention `python_exec`. Update all references, derive `PTC_OWNED_TOOLS` from the actually-registered tool names, and centralize the repeated `'code_execution'` literal (`src/tool-registry.ts:34, 212, 251`).

2. **Delete dead code (verified or high-confidence):** `CustomToolManager.seed` (`src/custom-tool-manager.ts:93-98`, no callers); `loadCustomToolsFromDir` (only test consumer; duplicates `start()`'s loop with opposite error policy — extract one parameterized scan instead); `CodeExecutor` one-shot path itself (`src/code-executor.ts` — runtime uses only `PythonSessionManager`; `buildCombinedCode` duplicates `buildSessionPrelude` and has drifted: no `PTC_SESSION_ID`/`PTC_MODE`/autoimport block; README.md:310 still documents it as the orchestration layer); `utils.formatPythonError` (byte-identical to `formatPythonErrorMessage` in `src/execution/execution-errors.ts`, zero callers); `describeSessionError` (`src/index.ts:1082`); unused `pi` param in `provisionKernelTool` (`index.ts:800`); write-only `sessionState.requestedBackground` (`index.ts:418`); `ExecutionOptions.recoveryState` (`src/contracts/execution-types.ts:143`, never consumed); `PTC_CTX_LIMIT_FALLBACK` (`src/execution/subagent-panel.ts:12`, fallback hardcoded at `:19`); dead nullish fallbacks in the footer summary (`:210-214`, `totals` is always fully built five lines above); `classifyTool` pass-through (`src/tool-registry.ts:26-28`); the effectively-dead catch in `CodeExecutor.execute` (`error instanceof PtcPythonError ||` is always true since `PtcPythonError extends Error`, `src/code-executor.ts:111-115`) — if CodeExecutor survives, also guard the `finally { await rpc?.dispose() }` (`:118`) so a dispose failure can't mask the original error.

3. **Kill duplicated logic between the two RPC transports (one-shot vs persistent session).** `PythonSessionManager.handleLine` (`src/python-session-manager.ts:246-385`) re-implements `RpcProtocol`'s tool_call pipeline, `appendStdout`/`buildFinalOutput`, and `serializeError` (`src/rpc-protocol.ts:303-318, 381-396, 560-592`) — and skips the frame validation the other transport applies. Extract a shared "nested tool dispatcher" + "output accounting" helper and route session frames through `validateRpcMessage` (note M7's `exec_error` field stripping must be fixed first). Also: `DEFAULT_MAX_OUTPUT_CHARS` (`rpc-protocol.ts:217`) duplicates private `DEFAULT_MAX_OUTPUT_SIZE` (`src/utils.ts:3`); the truncation-notice template duplicates `utils.truncateOutput`; output truncation exists three times total (Python `_StdoutProxy`/`_ptc_exec_chunk`, host session manager, `utils.truncateOutput`) — keep one canonical implementation per side, documented as mirroring each other; the identical fallback `CodeExecutionResult` is hand-built in `execBackground`'s and `markBackgrounded`'s catches (`src/python-session-manager.ts:963-977, ~1063-1077`) — extract a helper.

4. **`ptc.callers` semantics: one helper, one meaning** — see L3 (`src/contracts/tool-types.ts` shared with `CustomToolManager.setToolActive` and `ToolRegistry.getConfiguredCallers`/`toolAllowsDirectCaller`).

5. **Venv path logic in three places** — `resolvePythonExecutable` (`src/sandbox-manager.ts:39-47`), `resolvePaths` (`src/subagents-env.ts:94-97`), `ptcVenvPythonPath` (`:127-129`, comment admits it "mirrors sandbox-manager"). Export one shared `defaultCacheRoot()/venvPythonPath(cacheRoot?)` (used by `index.ts:1371`, which currently passes no `cacheRoot` so the paths only happen to agree); note both hardcode `bin/python`, wrong for Windows venvs — add a guard or comment.

6. **Session-level types belong in contracts/** — `SessionSummary`, `SessionExecOptions`, `BackgroundCompletion` live in `src/python-session-manager.ts:26-64` while every other cross-module type it consumes lives in `src/contracts/execution-types.ts`. Move them.

7. **`provision()` mutating global `process.env`** — `process.env.PI_SUBAGENTS_PROFILE = …` (`src/python-session-manager.ts:838-841`) is never restored/scoped and only affects sessions provisioned after the change. Pass it explicitly to `sandboxManager.spawn` (this is also the fix vehicle for M6's Docker env forwarding).

8. **Truncation-notice knowledge: structured over scraped.** The `/^\[(Showing|Use offset=|Output truncated)/` regex in `tool-adapters.ts:55` encodes partial knowledge of pi's notice formats while pi exposes `details.truncation/entryLimitReached/resultLimitReached/matchLimitReached` — prefer structured details (this is also the proper fix for M2/M3).

9. **Telemetry field hygiene.** `firstToolPath: "direct"` is declared but never produced (`src/recovery-state.ts:47-52`; `benchmark-runner.ts:184-193` derives "direct" independently) — record direct usage or drop the union member; `routedToCodeExecution` is write-only and excluded from `PtcExecutionTelemetry` — drop or emit; `autoRecoverMaxAttempts` is clamped to [0,1] (`src/utils.ts:78`) and only checked `> 0` — rename to a boolean kill-switch or implement real multi-attempt recovery. Also fix M-level finding: `buildPtcExecutionTelemetry` is only called on the success path (`src/index.ts:1023`) so `failed_without_recovery`/`failed_after_recovery` are unreachable — attach telemetry to error results too (merged into Bugs as part of the telemetry cluster; see M-cluster in the audit "Recovery & routing state").

---

*Discards: none — every audit finding was either directly verified in source (custom-tool-manager, sandbox-manager, tool-adapters vs pi internals, rpc-protocol, subagents-env lock, benchmark CLI, recovery classifier, execFilePtc) or consistent with verified code. The `exec_error`-strips-fields finding was noted as latent (session frames currently bypass validation) and folded into M7.*