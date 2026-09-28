# Programmatic Tool Calling / Agent Workflow Ecosystem — Research Notes

*Researched via web (primary sources). companion summary in conversation.*

## A note on "VFork"

No Cloudflare product called "vfork" exists. In the Workers context, `vfork`/`fork`/`clone` are the POSIX syscalls that **workerd's seccomp filter blocks** — they show up in error messages when code (or a dependency) tries to spawn native processes inside a V8 isolate. The actual Cloudflare sandbox primitives are: **V8 isolates via the Dynamic Worker Loader API** (millisecond-start, disposable) and the **Sandbox SDK** (containers + Durable Objects, for real filesystems/shells).

## Tools

### 1. Cloudflare Code Mode (`@cloudflare/codemode`)
- **Mechanism**: MCP tools / AI-SDK tools / OpenAPI operations are compiled into a **typed TypeScript API** presented to the model as one meta-tool. The model writes a JS async arrow function; it runs in a **disposable V8 isolate** created per execution pass via the **Dynamic Worker Loader** (no containers, ms startup, `globalOutbound: null` = no generic network). All external access flows through **connector globals** (`github.list_pull_requests(...)`) backed by Workers RPC to the host, which holds credentials — the sandbox never sees API keys.
- **Notable APIs**:
  - `codemode({ system, tools })` — drop-in wrapper for AI SDK `streamText`
  - Durable runtime: `createCodemodeRuntime({ ctx, executor: new DynamicWorkerExecutor({loader}), connectors })` → state stored in a Durable Object **facet** with SQLite; survives hibernation
  - Sandbox SDK: `codemode.search()` / `codemode.describe()` (progressive disclosure — ranked paths, not full schemas), `codemode.step(name, fn)` (records nondeterministic work for replay), `codemode.run(name, input)` (run saved snippets)
  - Output statuses: `completed | paused (pending approvals) | error`
  - **Approvals via abort-and-replay**: when code hits an approval-required connector call, runtime records `pending`, aborts the pass; on approval it re-runs the same source with the same execution ID; applied calls replay recorded results. **Deterministic replay** with sequence numbers; divergence (same seq, different args) → error. `replay: "reexecute"` policy for idempotent reads. Sequential calls required when pausing (Promise.all ordering breaks replay).
  - **Rollback**: walks applied calls in reverse, invokes per-method `revert` implementations (compensation, not transactions)
  - **Snippets**: host promotes a completed execution to a named, reusable, input-taking recipe; model discovers via `search`/`describe`
  - Retention: `maxExecutions` (default 50), `expirePaused()`, 1MB serialized-value limit
  - MCP-server variant: `codeMcpServer()` exposes one `code` tool to *any* MCP client; "search and execute" pattern for OpenAPI-sized APIs
- **Sources**: https://blog.cloudflare.com/code-mode/ · https://developers.cloudflare.com/agents/tools/codemode/how-it-works/ · https://developers.cloudflare.com/agents/tools/codemode/durable-runtime/ · https://developers.cloudflare.com/agents/model-context-protocol/codemode/ · https://developers.cloudflare.com/workers/runtime-apis/bindings/worker-loader/
- **Sandbox SDK (sibling product)**: container-based sandboxes for agents needing real filesystem/shell/Python — `getSandbox()`, argv process execution with handles + streaming logs, PTY terminals (browser + WebSocket), file ops, background processes, Docker-in-Docker, R2/S3 mounts for persistence, pairing with Workflows/fibers for durable long-running work. https://developers.cloudflare.com/sandbox/ · https://developers.cloudflare.com/agents/tools/sandbox/

### 2. Anthropic Programmatic Tool Calling (server-side PTC)
- **Mechanism**: Claude writes Python that calls your tools **inside the code-execution container** at the API level — no harness round-trips per call. `allowed_callers: ["code_execution_20260120"]` on a tool definition grants code-exec the right to call that tool. Requires code execution tool ≥ `code_execution_20260120`.
- **Notable APIs**: `code_execution` container tool; `allowed_callers`; `tool_reference`; tool search tool (progressive disclosure of schemas); bash tool version `code_execution_20260521`. Reported +11% avg on BrowseComp/DeepSearchQA with 24% fewer input tokens vs direct calls.
- **Source**: https://docs.claude.com/en/docs/agents-and-tools/tool-use/programmatic-tool-calling

### 3. Anthropic "Code execution with MCP" (engineering pattern)
- **Mechanism**: present MCP servers as a **file tree of typed TS stubs** (`servers/google-drive/getDocument.ts` ...); agent explores filesystem to load only needed definitions (98.7% token reduction in their example). Intermediate results filtered/aggregated in the sandbox; only `console.log` output reaches the model.
- **Patterns worth stealing**: PII **tokenization** at the client boundary (real values flow tool→tool, never through the model); **state via files** (`./workspace/leads.csv` resumable across executions); **skills as saved code** (agent-written functions + SKILL.md become reusable tools).
- **Source**: https://www.anthropic.com/engineering/code-execution-with-mcp

### 4. smolagents (Hugging Face) CodeAgent
- **Mechanism**: ReAct-style loop where each action is a **Python snippet** (CodeAct). Default executor is `LocalPythonExecutor`: a from-scratch **AST-walking interpreter** (not CPython) — imports denied unless whitelisted (`additional_authorized_imports`, incl. `numpy.*` submodule rules), operation-count cap kills infinite loops, anything not implemented in the interpreter errors. Explicitly documented as *not* a security boundary.
- **Notable APIs**: `CodeAgent(tools, model, stream_outputs=True, executor_type="e2b"|"modal"|"blaxel"|"docker")`; context-manager lifecycle with `cleanup()`; agent state shipped to sandbox at each `agent.run()`; two architectures — *snippet-in-sandbox* vs *whole-agent-in-sandbox*. Also `ToolCallingAgent` for comparison; multi-agent hierarchies.
- **Sources**: https://github.com/huggingface/smolagents · https://huggingface.co/docs/smolagents/en/tutorials/secure_code_execution

### 5. Open Interpreter
- **Current (v2)**: now a **fork of OpenAI Codex** in Rust, provider-agnostic, `/harness` switching among harness emulations (claude-code, kimi-code, swe-agent, ...), ACP- and Codex-SDK-compatible, sandbox + approval-mode guardrails, session resume.
- **Classic (v0.x)**: the original notebook-style agent — stateful Python via an embedded **Jupyter kernel**, streamed output chunks, interrupt by killing/restarting the run cell, Docker sandbox option.
- **Sources**: https://github.com/openInterpreter/open-interpreter · https://docs.openinterpreter.com/guides/streaming-response

### 6. E2B
- **Mechanism**: managed **Firecracker-ish microVM** sandboxes; the code-interpreter template runs a real **Jupyter server (jupyter-server + ipykernel) behind a FastAPI/WS gateway**; `run_code` targets **code contexts** (= kernel sessions, so parallelizable), producing rich outputs (charts, DataFrames).
- **Notable APIs**: `Sandbox.create()` / `connect()`; `sandbox.runCode(code, {context, onStdout, onStderr, onError})`; `createCodeContext({cwd, language, requestTimeoutMs})`, `restartCodeContext()`; **persistence**: `pause()`/`resume()` preserving **filesystem + memory** (running processes, loaded variables) indefinitely; **snapshots** & **fork** (boot N sandboxes from one state); **filesystem-only snapshots** (reboot-on-resume); volumes; PTY & SSH; custom **templates** (Dockerfile-based, versioned) for preinstalled deps; lifecycle events API/webhooks; OTel export; `sandbox.git` methods.
- **Sources**: https://e2b.dev/docs/llms.txt · https://docs.e2b.dev/sandbox/persistence.md · https://docs.e2b.dev/code-interpreting/contexts.md · https://docs.e2b.dev/code-interpreting/streaming.md

### 7. Daytona
- **Mechanism**: OCI/Docker "composable computers" for AI code — full kernel, fs, network stack; **<90ms** sandbox start; Python/TS/JS SDKs + REST + CLI. **Repo archived June 2026** (core moved to private codebase) — still a useful design reference.
- **Notable APIs**: sandboxes lifecycle, **stateful snapshots** (declarative builder), volumes, **process & code execution**, PTY, **LSP** endpoint (nice for code-intelligence tools), MCP server endpoint, **log streaming**, computer use, network limits, orgs/audit/billing controls.
- **Source**: https://github.com/daytonaio/daytona · https://www.daytona.io/docs

### 8. ipybox (gradion-ai) / freeact
- **Mechanism**: local **stateful IPython kernel** that unifies Python + shell (`!cmd`, `%%bash`) + **programmatic MCP tool calls in one code block**. `mcpygen` generates **typed Python APIs (Pydantic models) from MCP server schemas** — i.e., "Code Mode" in Python. Optional OS-level isolation via Anthropic's `sandbox-runtime` (landlock-style fs/network restrictions).
- **Notable APIs**: `executor.execute(code)` (auto-approve) vs `executor.stream(code)` yielding `ApprovalRequest | CodeExecutionChunk | CodeExecutionResult`; `approve_tool_calls=True` (default), `approve_shell_cmds=True`; **variable interpolation happens before approval** so the app sees the fully-expanded command; `require_shell_escape=True` blocks `subprocess`/`os.system`/`os.spawn*`/`pty.spawn` bypasses, forcing shell through the approved `!cmd` path; reject → `ApprovalRejectedError` traceback inside the kernel; MCP server + Claude Code plugin packaging.
- **Sources**: https://github.com/gradion-ai/ipybox · https://gradion-ai.github.io/ipybox/codeexec/ · https://github.com/gradion-ai/freeact

### 9. AutoGen executors (JupyterCodeExecutor et al.)
- **Mechanism**: pluggable `CodeExecutor` interface; `JupyterCodeExecutor` executes **statefully via nbclient** against a kernel; `CancellationToken` for cancellation; also Docker/local command-line executors; wraps as `PythonCodeExecutionTool` for any agent.
- **Source**: https://microsoft.github.io/autogen/stable/reference/python/autogen_ext.code_executors.jupyter.html

### 10. OpenHands (SDK v1)
- **Mechanism**: event-stream agent working in a container runtime; code actions are IPython cells. Approval is policy-driven: **confirmation policies** (`AlwaysConfirm`, `NeverConfirm`, `ConfirmRisky`) + **security analyzers** (LLM-based risk scoring, defense-in-depth stacking) that gate actions before execution.
- **Source**: https://docs.openhands.dev/sdk/guides/security

### 11. CodeAct (academic foundation)
- Wang et al., *Executable Code Actions Elicit Better LLM Agents* (ICML 2024): unify the action space as executable Python; multi-turn interpreter feedback; up to **20% higher success rate** across 17 LLMs vs JSON tool calling. The paper smolagents/Code Mode all cite.
- **Source**: https://arxiv.org/abs/2402.01030

### Also-rans (brief)
- **Blaxel / Modal sandboxes**: managed VM sandboxes; Blaxel resumes from hibernation <25ms keeping memory state (smolagents integration).
- **Anthropic `sandbox-runtime`**: bash-oriented OS-level sandbox (landlock) used by ipybox.
- **Jupyter AI**: LLM magics/assist inside JupyterLab — inverse direction (LLM in the notebook, not notebook in the agent).

## Patterns worth stealing (cross-cutting)

1. **One meta-tool instead of N tools.** Model gets a single "run code" tool plus a typed API surface compiled from tool/MCP/OpenAPI schemas. Doc comments from schemas; TypeScript or Python typings in-training-distribution beats JSON tool-call training.
2. **Progressive disclosure of the API surface.** Full catalog never in context: `search()` → ranked paths → `describe(path)` → focused types (Cloudflare), file-tree exploration (Anthropic), `search_tools` with detail-level param.
3. **Intermediate results stay out of the model.** Filter/aggregate in the sandbox; return references (file paths, row counts) not data; `transformResult` to shrink results for the model while the audit log keeps the raw value.
4. **Capability bindings, not network egress.** Sandbox has no `fetch`/`connect`; the only doors are pre-authorized connector globals via RPC to a supervisor that holds the tokens → API keys can't leak through model-written code. Cleaner than network filtering for both supervisor and LLM.
5. **Abort-and-replay approvals (durable HITL).** Don't try to pause a process: record an ordered log of side-effectful calls with sequence numbers; on approval, replay recorded results and continue. Requires determinism discipline — `step()` wrapper for `Date.now()`/`Math.random()`, no `Promise.all` around pausable calls, divergence detection as a hard error.
6. **Rollback as compensation, not transactions.** Per-method `revert` implementations; walk applied calls in reverse; tolerate partial failure and report; rollback is separate from rejection.
7. **Stateful kernel-as-agent-memory.** A persistent IPython kernel (E2B contexts, AutoGen, ipybox, classic Open Interpreter) gives variable/state continuity across model turns for free — the natural substrate for data-science-flavored agents.
8. **Streaming + interrupts as first-class.** `on_stdout/on_stderr` callbacks (E2B), async generator streams (ipybox), `stream_outputs` (smolagents); cancellation via token or kernel restart. Stream chunks into the model loop rather than waiting for cell completion.
9. **Install handling: two tiers.** Prebaked versioned templates/snapshots (E2B templates, Daytona snapshots, CF Sandbox Dockerfile) for cold start; runtime `!pip install` inside the approved shell path for iteration — with variable interpolation expanded *before* the approval check.
10. **Cell-level approval with bypass prevention.** Approve per tool-call/shell-command mid-execution (ipybox `ApprovalRequest`), block process-creation escapes (`subprocess`, `os.system`...), policy layers on top (OpenHands `ConfirmRisky` + security analyzers).
11. **Snapshot the whole machine.** Pause/resume preserving **memory + fs** (E2B), fork N agents from one state, fs-only snapshots for cheaper restarts. Snapshots double as environment versioning.
12. **Agent-written code as durable artifacts.** Skills/snippets: the host (not the model) promotes verified executions into reusable, named, input-taking recipes discoverable via search — closing the loop from "one-off script" to "capability library".
13. **Privacy by dataflow, not prompt.** Tokenize PII at the tool boundary; detokenize only inside tool calls — sensitive data never enters context even when logged.
14. **Execution log as the spine.** The same ordered record serves audit, replay, rollback, expiry/GC, and dev-facing run viewers.

## Verified source URLs
- https://blog.cloudflare.com/code-mode/
- https://developers.cloudflare.com/agents/tools/codemode/how-it-works/
- https://developers.cloudflare.com/agents/tools/codemode/ (patterns), .../durable-runtime/, .../api-reference/
- https://developers.cloudflare.com/agents/tools/sandbox/ · https://developers.cloudflare.com/sandbox/
- https://docs.claude.com/en/docs/agents-and-tools/tool-use/programmatic-tool-calling
- https://www.anthropic.com/engineering/code-execution-with-mcp
- https://github.com/huggingface/smolagents · https://huggingface.co/docs/smolagents/en/tutorials/secure_code_execution
- https://github.com/openInterpreter/open-interpreter · https://docs.openinterpreter.com/guides/streaming-response
- https://e2b.dev/docs/llms.txt (+ persistence / snapshots / contexts / streaming .md pages)
- https://github.com/daytonaio/daytona
- https://github.com/gradion-ai/ipybox · https://gradion-ai.github.io/ipybox/codeexec/
- https://microsoft.github.io/autogen/stable/reference/python/autogen_ext.code_executors.jupyter.html
- https://docs.openhands.dev/sdk/guides/security
- https://arxiv.org/abs/2402.01030
