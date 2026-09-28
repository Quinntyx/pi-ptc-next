# PTC Feature Audit — Evidence-Based Proposals

## Method

This audit triangulates three sources: the current `pi-ptc-next` README and implementation, the ecosystem survey in `research/ptc-ecosystem.md`, and roughly 500 MB of real pi JSONL session history mined for old-system PTC behavior, with new-system sessions used as redesign contrasts. The supplied catalog cites 18 distinct session files; its frequency denominators vary by analysis slice (six heavy old sessions, seven old PTC sessions, nine PTC-using sessions, and four new-system contrast sessions), so percentages below retain the miners’ original denominators rather than pretending they form one uniform sample. The miner output contains 21 failure-mode labels: 20 complete records and one trailing record truncated after its name. Of the 20 classifiable records, five are explicitly superseded by the redesign and 15 survive; the incomplete 21st record is reported but excluded from that filter count. Overlapping labels are preserved in the appendix rather than silently deduplicated.

## Proposed Features

### 1. Automatic kernel checkpoints and rehydration

**What it is.** After each completed cell, persist a recoverable checkpoint containing serializable globals, function and class source, imports, dependency versions, cwd, and cell sequence. Bind it to the notebook path as a stable identity. If the process dies or a transcript supplies a stale session ID, provision a replacement automatically, replay or restore eligible state, and report every object that could not be restored.

**Classification.** **Parity**, inspired by E2B memory-preserving pause/resume and snapshots and Daytona stateful snapshots. **Expected benefit:** very high. **Complexity:** large.

#### Evidence

This is the strongest proposal because several independently mined modes point to the same loss boundary:

- **“session death loses entire namespace; model re-provisions and re-computes”** occurred in about **60% of old-system sessions with PTC traffic (6/10)**. In `2026-09-20T18-16-34-494Z_01a0c008-c1be-71e0-ae7d-9918212c5ac4.jsonl`, an unknown session was followed by `NameError: buf is not defined`; two later idle terminations pushed the model to `/tmp/m8analyse.py` and bash. `2026-09-25T04-32-52-126Z_01a0d6d6-6d9e-774a-abab-2fa9bdc44676.jsonl` recorded three unknown-session events and two consecutive “no longer running” events.
- **“Idle reap causes silent state loss and NameError storm”** appeared in about **4/7 old PTC sessions (~57%)**. In `preTTY/2026-09-19T20-01-03-973Z_01a0bb42-0fe4-71e0-ae7d-99173bd0ac33.jsonl`, two 276-second gaps caused two reaps; the first was followed by a `buf` `NameError`, and the second forced repeated image setup.
- **“Stale session id replayed after session resume/branch”** was deterministic in **three sessions in one lineage**. Both `2026-09-25T20-21-18-912Z_01a0da3a-c1c0-7671-a312-7a1566acb238.jsonl` and `2026-09-25T22-43-33-809Z_01a0dabc-fd30-73f0-bc81-c56bdfba55bc.jsonl` inherited dead ID `d889df3af26f`, failed, provisioned again, and replayed setup.
- The downstream outcome, **“PTC abandonment”**, occurred at the end of **3/6 heavy old sessions**; **5/6** had more than 100 non-PTC calls after their final PTC call.

The redesign’s notebook record and non-destructive interrupt behavior reduce damage, but a notebook records cells rather than reconstituting a live namespace. This proposal closes that remaining gap.

### 2. Detached cell executions with polling and reattachment

**What it is.** Add an explicit detached mode to `exec_cell` that returns an execution ID immediately. Provide inspect/progress, await, cancel, and output-retrieval operations; preserve notebook completion exactly once; and serialize or otherwise guard live-namespace mutation. Execution identity must survive the foreground tool call and be reattachable after a turn interruption.

**Classification.** **Parity**, inspired by OpenAI asynchronous tool calls, managed Codex durable sessions, and Cloudflare process handles. **Expected benefit:** very high. **Complexity:** large.

#### Evidence

- **“Long-blocking orchestration inside PTC chunks”** occurred in about **4/9 PTC-using sessions (~44%)**, reportedly every sampled attempt to orchestrate agents through PTC. `pi-ui-forge/2026-09-23T22-53-29-143Z_01a0d079-5ab7-730f-b6e4-33ed05710e40.jsonl` contains six Ctrl-C aborts while blocked in waits of 900 seconds to four hours; the user explicitly said the run hung.
- **“hard 270s execution/idle timeout kills long subagent orchestration mid-flight”** occurred in about **2/6 heavy old sessions (~33%)**, with at least five timeout events. `2026-09-25T04-32-52-126Z_01a0d6d6-6d9e-774a-abab-2fa9bdc44676.jsonl` had two execution timeouts, three settle timeouts, and four retries of the same tmux spawn code.
- **“user interruption or correction immediately after a PTC call”** produced **4–5 events across the heavy sessions**. In `2026-09-20T18-16-34-494Z_01a0c008-c1be-71e0-ae7d-9918212c5ac4.jsonl`, aborting a tool call terminated the old session and was followed by the user’s complaint about an approximately 40-agent fan-out.

The current redesign correctly sends SIGINT and preserves the kernel, which supersedes the destructive part of the old behavior. It does not make a multi-minute operation detached or reattachable; source comments explicitly mark background/foreground modes as deferred.

### 3. Lossless output spooling with compact references

**What it is.** Store complete stdout, stderr, returned values, and rich artifacts outside model-visible transcript text. Return a bounded head-and-tail preview plus an immutable output reference, byte and line counts, and truncation metadata. Support range reads and in-kernel consumption of the referenced value so the model need not dump it back into context.

**Classification.** **Parity**, inspired by OpenAI container file citations, Anthropic `OUTPUT_DIR` artifacts, and Cloudflare sandbox file APIs. **Expected benefit:** high. **Complexity:** medium.

#### Evidence

- **“giant output dumps truncated at 100k chars, repeatedly, blowing context”** affected about **2/6 heavy sessions (~33%)**, but generated **25+ truncated results** in those two sessions alone. `2026-09-20T18-16-34-494Z_01a0c008-c1be-71e0-ae7d-9918212c5ac4.jsonl` had roughly 18 consecutive results truncated at 100,000 of 103,000–117,000 characters. `2026-09-25T04-32-52-126Z_01a0d6d6-6d9e-774a-abab-2fa9bdc44676.jsonl` included a 100,000-of-248,521-character result and three more near-100k dumps.
- Those sessions also had **11 and five compactions**, respectively. This is correlation, not proof of causation, but repeated 100k transcript injections are an obvious context cost.

Raising the existing `PTC_MAX_OUTPUT_CHARS` cap would preserve more bytes only by worsening the model-context failure. Spooling preserves both auditability and bounded context.

### 4. Searchable deferred Python API catalog

**What it is.** Expose tools, `ptc` helpers, `pi_subagents`, handle classes, signatures, return types, and examples through `search` and `describe` APIs. Initially disclose names and summaries only; load detailed schemas and generated wrappers on demand.

**Classification.** **Parity**, inspired by OpenAI and Anthropic Tool Search, Cloudflare `codemode.search`/`describe`, and Anthropic filesystem-based MCP stubs. **Expected benefit:** high. **Complexity:** medium.

#### Evidence

- **“guessing injected-API shape causes AttributeError/TypeError storms”** occurred in about **3/6 old subagent-orchestration sessions plus 2/4 new sessions**. `2026-09-25T04-32-52-126Z_01a0d6d6-6d9e-774a-abab-2fa9bdc44676.jsonl` contains guesses such as `pi_subagents.list`, `len(Registry)`, and list indexing with the wrong shape. In both `2026-09-26T00-07-06-219Z_01a0db09-78ea-73fa-8e02-13d4793d1364.jsonl` and `2026-09-26T00-49-15-613Z_01a0db30-115c-756c-b362-c47d6683aac4.jsonl`, the first cell tried `ModelInfo.get`, failed, and needed a `dir()` probe despite the new inspection facilities.
- **“Two coexisting code-run APIs cause duplicated work and API guessing”** appeared in **5/9 PTC-using sessions (~56%)**. One cited error was `No module named ptc`, showing that models guessed even the runtime module boundary.

The final supplied catalog record, **“Runtime API discovery by trial and error,”** was truncated before its frequency and citations. It is therefore not used numerically here, although its label is directionally consistent with the complete evidence above.

### 5. Durable idempotent subagent run registry

**What it is.** Move subagent run identity and ownership to a host-level registry independent of Python module imports and kernel lifetime. Give logical tasks idempotency keys; return an existing active or completed run for duplicate spawns; make imports side-effect-free; and provide documented list, attach, cancel-group, and fan-out approval operations.

**Classification.** **Novel**, inspired by the session evidence. Existing agent frameworks expose subagents and lifecycle hooks, but the survey did not find host-durable leases with semantic spawn idempotency across kernel loss. **Expected benefit:** high for orchestration-heavy use. **Complexity:** large.

#### Evidence

- **“non-idempotent re-imports of injected helper modules destroy live handles”**: `import pi_subagents` appeared in **14% of all old `python_exec` cells (86/628)**. In `2026-09-25T04-32-52-126Z_01a0d6d6-6d9e-774a-abab-2fa9bdc44676.jsonl`, the user explicitly corrected the re-import behavior; leaked handles then hit the eight-agent concurrency cap and required `stop_all()`.
- **“user interruption or correction immediately after a PTC call”** includes the approximately 40-agent complaint in `2026-09-20T18-16-34-494Z_01a0c008-c1be-71e0-ae7d-9918212c5ac4.jsonl` and two direct corrections around fan-out/import behavior in the Vault session.
- **“hard 270s execution/idle timeout…”** and **“Long-blocking orchestration…”** show why run ownership cannot safely live only in a foreground Python await.

This should complement, not replace, detached execution: the execution registry tracks the cell; the subagent registry tracks semantically durable child runs.

### 6. State-aware duplicate-failure circuit breaker

**What it is.** Fingerprint normalized cell source, relevant file contents and options, a kernel-state digest, and nested tool arguments. If the same invocation already failed and the relevant state has not changed, return the prior structured failure without executing again unless `force_retry` is explicit. Exempt errors classified as transient.

**Classification.** **Novel**, inspired by the session evidence; replay systems offer divergence detection, but the surveyed tools did not expose a kernel-state-aware duplicate-failure suppressor. **Expected benefit:** medium to high. **Complexity:** medium.

#### Evidence

- **“identical-call retry loops after errors (no argument change)”** affected about **50% of heavy sessions**, with **10–18 consecutive-duplicate events in each of the two heaviest sessions**. Both `2026-09-25T04-32-52-126Z_01a0d6d6-6d9e-774a-abab-2fa9bdc44676.jsonl` and `2026-09-20T18-16-34-494Z_01a0c008-c1be-71e0-ae7d-9918212c5ac4.jsonl` contain four identical tmux spawn failures in a row.
- **“missing session_id causes schema-validation failure and wasted round trips”** occurred roughly six times across **2/6 heavy sessions**, followed by resubmission of identical, sometimes large, code payloads.
- **“Opaque, context-free error results…”** affected about **3/9 PTC-using sessions** and helps explain blind retries, although better diagnostics should be pursued independently.

The state digest is essential: source equality alone would incorrectly suppress a retry after a dependency install, file edit, approval, or namespace repair.

### 7. Dependency-complete approval previews

**What it is.** For a confirmed cell, show the submitted source and the source of referenced live user-defined functions and classes. For file execution, show the exact file contents and hash. Display predicted defined or mutated names and unresolved dynamic dependencies. On rejection, return an unchanged-state digest and the names that were not created.

**Classification.** **Novel**, inspired by session evidence. Surveyed systems show submitted code or individual calls, but not transitive live-namespace dependencies plus rejected-state effects. **Expected benefit:** medium to high. **Complexity:** medium.

#### Evidence

- **“NEW-system only: confirm-gate shows opaque wrapper, user rejects the cell”** occurred in **3/4 new-system sessions (75%)**. In `2026-09-25T23-18-32-706Z_01a0dadd-0402-735e-8790-6ecfa3b3a9c9.jsonl`, the confirmed source was only `await main()`; the user rejected it because the popup did not reveal the controlling code. `2026-09-26T00-07-06-219Z_01a0db09-78ea-73fa-8e02-13d4793d1364.jsonl` produced a rejection followed by requests for syntax highlighting and inline code.
- **“user interruption or correction immediately after a PTC call”** had **4–5 events**, including a user stopping an eight-agent launch before fan-out.

The current redesign has already added syntax highlighting and displays the literal cell body, so those narrow complaints are fixed. The remaining evidence-backed problem is indirection: `await main()` or file execution can still hide the code that controls behavior.

### 8. Typed and validated tool output contracts

**What it is.** Let tools declare JSON-compatible output schemas and examples, validate normalized values at the host boundary, generate Python `TypedDict` or dataclass return types, and report violations with exact output paths and bounded previews.

**Classification.** **Parity**, inspired by OpenAI `output_schema` and typed code APIs in Anthropic and Cloudflare systems. **Expected benefit:** medium. **Complexity:** medium.

#### Evidence

Evidence is **indirect but real**. The strongest mapped mode is **“guessing injected-API shape causes AttributeError/TypeError storms”** (about **3/6 old orchestration sessions and 2/4 new sessions**). The repeated `ModelInfo.get` failure in `2026-09-26T00-07-06-219Z_01a0db09-78ea-73fa-8e02-13d4793d1364.jsonl` and wrong list/registry assumptions in `2026-09-25T04-32-52-126Z_01a0d6d6-6d9e-774a-abab-2fa9bdc44676.jsonl` show that undocumented shapes cause mistakes.

However, those examples concern helper-library objects as well as nested tool outputs. A searchable catalog may prevent more of them than runtime schema validation alone. This feature is justified as the contract-enforcement half of the catalog, not as a separately proven cure for all shape errors.

### 9. Verified reusable execution skills

**What it is.** Let the host promote a successful execution into a named, versioned, parameterized skill with an input schema, description, source hash, provenance, permissions, and optional tests. Store skills in a project capability directory and expose metadata through progressive search before loading source.

**Classification.** **Parity**, inspired by Cloudflare host-promoted snippets and Anthropic Agent Skills with `SKILL.md` plus bundled scripts. **Expected benefit:** medium. **Complexity:** medium.

#### Evidence

Evidence is **secondary rather than direct**:

- **“PTC abandonment”** ended **3/6 heavy old sessions** in full bash fallback; **5/6** had more than 100 non-PTC calls after their last PTC call. In `2026-09-25T04-32-52-126Z_01a0d6d6-6d9e-774a-abab-2fa9bdc44676.jsonl`, a bash heredoc later broke on the apostrophe in `Jin's Reign.md`.
- **“session death loses entire namespace…”** and **“Idle reap…”** forced repeated setup and recomputation.

Checkpointing is the direct fix for lost state. Skills address the repeated-work residue: once a workflow is known-good, it should not be regenerated as another fragile heredoc. Promotion must be explicit and host-verified; the sessions do not support autonomous promotion of arbitrary model-written code.

### 10. Per-call approval and policy hooks inside cells

**What it is.** Intercept each nested mutation, shell command, configured sensitive read, and dangerous process or socket operation. Apply ordered allow, deny, transform, or confirm rules to fully expanded arguments, pausing and resuming only the affected operation rather than approving an opaque orchestration cell wholesale.

**Classification.** **Parity**, inspired by ipybox `ApprovalRequest` and bypass prevention, OpenHands confirmation policies, and Claude Agent SDK lifecycle hooks. **Expected benefit:** potentially high for adoption and safety. **Complexity:** large.

#### Evidence

The evidence supports **finer approval UX**, but not the full security claim:

- The opaque confirm gate was rejected in **3/4 new-system sessions**.
- Users interrupted or corrected PTC immediately after calls **4–5 times**, including before an eight-agent fan-out and after an approximately 40-agent fan-out.

These observations show that whole-cell review is poorly aligned with large orchestration cells. They do **not** document a sensitive read, secret leak, or sandbox bypass. The first-principles case is that users can assess an expanded concrete operation more reliably than transitive generated code. This proposal should therefore be evaluated with approval-rate, rejection-recovery, and bypass tests rather than claimed as session-proven security.

### 11. OS-level filesystem and network sandbox

**What it is.** Add Bubblewrap or Landlock isolation on Linux and Seatbelt on macOS. Make the workspace read-only by default, expose explicit writable paths, deny arbitrary network egress, scrub secrets from the child environment, and route authorized external access through host RPC capabilities.

**Classification.** **Parity**, inspired by Claude Code’s sandbox runtime, OpenAI and Anthropic hosted containers, and smolagents remote executors. **Expected benefit:** high where untrusted code is a deployment blocker. **Complexity:** large.

#### Evidence

**Speculative.** The mined sessions contain no cited credential exfiltration, unauthorized network access, or unrelated-file mutation incident. The case is first-principles and architectural: the current README says Python runs directly on the host, inherits the host environment, and requires `PTC_ALLOW_UNSANDBOXED_SUBPROCESS=true`. Model-written Python and child processes therefore share the user’s ambient authority. Capability-only network access and secret scrubbing materially reduce worst-case impact, but the audit cannot estimate incident-frequency benefit from the supplied sessions. Treat this as a security prerequisite for broader deployment, not as a top usability fix demonstrated by the sample.

## Explicitly Rejected Ideas

- **Restore or retain multiple overlapping code-run APIs.** Rejected. **“Two coexisting code-run APIs…”** appeared in 5/9 PTC-using sessions and caused duplicated imports, recomputation, and API guessing. One canonical kernel/cell surface is preferable; compatibility naming in telemetry is not a reason to expose another model-facing executor.
- **Raise the four-session limit.** Rejected as a primary fix. The old limit was hit after models provisioned 6–13 sessions and juggled stale IDs. A larger cap masks churn and leaks more interpreters; stable notebook identity, `list_kernels`, automatic rehydration, and explicit lifecycle management address the cause.
- **Increase or remove the 100k output cap.** Rejected. The observed problem was context injection and repeated dumps, not merely missing tail bytes. Lossless external spooling is safer than a larger transcript payload.
- **Only lengthen the 270-second timeout.** Rejected. Multi-hour awaits still block turns, invite Ctrl-C, and remain fragile. Activity-based interruption already preserves the redesigned kernel; detached execution and reattachment solve the interaction model.
- **Re-add print-oriented result scaffolding or an auto-print helper.** Rejected as already fixed. The redesign auto-echoes final expressions and reports namespace deltas. Both print-scaffolding catalog entries are explicitly superseded.
- **Build another dependency-install path or silently auto-install on `ImportError`.** Rejected. `provision_dependency` already addresses the old hardcoded-venv and missing-package loops. Silent installation would mutate environments without a clear package/distribution decision or approval boundary.
- **Treat better tracebacks as a new headline proposal.** Rejected as largely redesign work already present: current interruption reports map to chunk lines, file execution maps tracebacks to real files, and execution errors no longer automatically kill a kernel. Continue hardening diagnostics, but do not rank the old opaque-wrapper symptom above unsolved durability and output problems.
- **Blind automatic retry or a larger general recovery budget.** Rejected. The evidence shows identical guaranteed-same retries were themselves a recurring failure mode. Recovery should be bounded and state-aware; transient retries need explicit classification.
- **Automatic, model-only skill promotion.** Rejected. Reuse is valuable, but successful execution is not sufficient proof of safety or generality. Promotion needs host control, provenance, a source hash, permissions, and preferably tests.
- **Full abort-and-replay approval semantics as the first approval change.** Deferred/rejected for this cycle. Cloudflare’s design requires deterministic sequencing and divergence detection; live Python namespaces, concurrency, and arbitrary subprocesses make replay correctness a much larger project. Per-call hooks provide value without pretending arbitrary cells are replay-safe.
- **Kernel forking and speculative parallel namespace branches.** Rejected for lack of session evidence. The corpus shows loss, blocking, and duplicate subagent runs—not demand for branching Python memory. Checkpoint/restore should precede fork semantics.
- **PII tokenization, generic rollback/compensation, LSP integration, and hosted PTY/SSH.** Rejected from this proposal set. They are credible ecosystem patterns but have no direct support in the mined PTC failures and weaker expected benefit than the ranked items above.

## Appendix: Failure-Mode Catalog

The table reproduces every complete mined record supplied to this audit, including overlapping formulations from different miners. “Yes” means the record itself was marked superseded by the redesign; “No” means it survived that filter. The final row was truncated in the supplied source and is deliberately not reconstructed.

| # | Failure mode | Frequency reported by miner | Superseded by redesign? | Evidence file references |
|---:|---|---|:---:|---|
| 1 | session death loses entire namespace; model re-provisions and re-computes | ~60% of old-system sessions with PTC traffic (6/10); preTTY alone 6+ times | No | `2026-09-20T18-16-34-494Z_01a0c008-c1be-71e0-ae7d-9918212c5ac4.jsonl`<br>`2026-09-25T04-32-52-126Z_01a0d6d6-6d9e-774a-abab-2fa9bdc44676.jsonl`<br>`2026-09-25T22-02-44-736Z_01a0da97-9e80-7671-a312-7a1807190b73.jsonl` |
| 2 | multi-session spawn churn and the 4-session limit | ~50% of old PTC sessions (3/6 with >1 provision); limit reached at least once | Yes | `2026-09-25T04-32-52-126Z_01a0d6d6-6d9e-774a-abab-2fa9bdc44676.jsonl`<br>`2026-09-20T18-16-34-494Z_01a0c008-c1be-71e0-ae7d-9918212c5ac4.jsonl` |
| 3 | missing `session_id` causes schema-validation failure and wasted round trips | ~33% of heavy old sessions (2/6); ~6 occurrences plus five adjacent identical bash validation retries in preTTY | No | `2026-09-20T18-16-34-494Z_01a0c008-c1be-71e0-ae7d-9918212c5ac4.jsonl`<br>`2026-09-25T04-32-52-126Z_01a0d6d6-6d9e-774a-abab-2fa9bdc44676.jsonl` |
| 4 | giant output dumps truncated at 100k chars, repeatedly, blowing context | ~33% of heavy sessions (2/6); 25+ truncated 100k results in those two | No | `2026-09-20T18-16-34-494Z_01a0c008-c1be-71e0-ae7d-9918212c5ac4.jsonl`<br>`2026-09-25T04-32-52-126Z_01a0d6d6-6d9e-774a-abab-2fa9bdc44676.jsonl` |
| 5 | `print()`-wrapping everything because there is no auto-echo | ~50% of old PTC sessions; >50% of cells print-wrapped in Vault sessions | Yes | `2026-09-25T04-32-52-126Z_01a0d6d6-6d9e-774a-abab-2fa9bdc44676.jsonl`<br>`2026-09-24T20-24-27-730Z_01a0d517-4752-756a-acc9-9c95d08bcc95.jsonl`<br>`2026-09-26T00-49-15-613Z_01a0db30-115c-756c-b362-c47d6683aac4.jsonl` (new-system contrast) |
| 6 | hard 270s execution/idle timeout kills long subagent orchestration mid-flight | ~33% of heavy old sessions (2/6); 5+ timeout events | No | `2026-09-25T04-32-52-126Z_01a0d6d6-6d9e-774a-abab-2fa9bdc44676.jsonl`<br>`2026-09-20T18-16-34-494Z_01a0c008-c1be-71e0-ae7d-9918212c5ac4.jsonl` |
| 7 | missing dependency kills the session; reinstall loop in a fresh env | ~17% of heavy old sessions (1/6), with four downstream failures | Yes | `2026-09-25T04-32-52-126Z_01a0d6d6-6d9e-774a-abab-2fa9bdc44676.jsonl` |
| 8 | non-idempotent re-imports of injected helper modules destroy live handles | 14% of all old `python_exec` cells re-import helper; one explicit user correction in two forked Vault sessions | No | `2026-09-25T04-32-52-126Z_01a0d6d6-6d9e-774a-abab-2fa9bdc44676.jsonl`<br>`2026-09-24T20-24-27-730Z_01a0d517-4752-756a-acc9-9c95d08bcc95.jsonl` |
| 9 | guessing injected-API shape causes `AttributeError`/`TypeError` storms | ~50% of sessions doing subagent orchestration (3/6 old + 2/4 new) | No | `2026-09-25T04-32-52-126Z_01a0d6d6-6d9e-774a-abab-2fa9bdc44676.jsonl`<br>`2026-09-26T00-07-06-219Z_01a0db09-78ea-73fa-8e02-13d4793d1364.jsonl`<br>`2026-09-26T00-49-15-613Z_01a0db30-115c-756c-b362-c47d6683aac4.jsonl` |
| 10 | PTC abandonment: model reverts to bash heredocs / read+edit for the rest of the session | 3/6 heavy old sessions end in full bash fallback; 5/6 have >100 non-PTC calls after final PTC | No | `2026-09-20T18-16-34-494Z_01a0c008-c1be-71e0-ae7d-9918212c5ac4.jsonl`<br>`2026-09-25T22-02-44-736Z_01a0da97-9e80-7671-a312-7a1807190b73.jsonl`<br>`2026-09-25T04-32-52-126Z_01a0d6d6-6d9e-774a-abab-2fa9bdc44676.jsonl` |
| 11 | user interruption or correction immediately after a PTC call | 4–5 events across heavy sessions (~50% of heavy old sessions) | No | `2026-09-20T18-16-34-494Z_01a0c008-c1be-71e0-ae7d-9918212c5ac4.jsonl`<br>`2026-09-25T04-32-52-126Z_01a0d6d6-6d9e-774a-abab-2fa9bdc44676.jsonl` |
| 12 | NEW-system only: confirm-gate shows opaque wrapper, user rejects the cell | 3/4 new-system sessions (75%) | No | `2026-09-25T23-18-32-706Z_01a0dadd-0402-735e-8790-6ecfa3b3a9c9.jsonl`<br>`2026-09-26T00-07-06-219Z_01a0db09-78ea-73fa-8e02-13d4793d1364.jsonl`<br>`2026-09-26T00-21-56-234Z_01a0db17-0d8a-763e-898d-c063379a0fef.jsonl` |
| 13 | identical-call retry loops after errors (no argument change) | ~50% of heavy sessions; 10–18 consecutive-duplicate events in each of two heaviest | No | `2026-09-25T04-32-52-126Z_01a0d6d6-6d9e-774a-abab-2fa9bdc44676.jsonl`<br>`2026-09-20T18-16-34-494Z_01a0c008-c1be-71e0-ae7d-9918212c5ac4.jsonl` |
| 14 | Idle reap causes silent state loss and `NameError` storm | ~4/7 old-system PTC sessions (~57%) | No | `--home-zlare-docs-src-preTTY-main--/2026-09-19T20-01-03-973Z_01a0bb42-0fe4-71e0-ae7d-99173bd0ac33.jsonl`<br>`--home-zlare-docs-src-preTTY-main--/2026-09-19T04-50-13-915Z_01a0b800-2b1b-71e0-ae7d-9914806f735e.jsonl`<br>`--home-zlare-Downloads--/2026-09-18T20-48-54-674Z_01a0b647-8191-77cb-8cbc-8f611ca08619.jsonl` |
| 15 | Stale session id replayed after session resume/branch | Three sessions in one lineage (~18% of files); deterministic on each resume inheriting PTC history | No | `--home-zlare-docs-src-pi-ptc-next-main--/2026-09-25T19-26-21-740Z_01a0da08-722b-7671-a312-7a113c8e0085.jsonl`<br>`--home-zlare-docs-src-pi-ptc-next-main--/2026-09-25T20-21-18-912Z_01a0da3a-c1c0-7671-a312-7a1566acb238.jsonl`<br>`--home-zlare-docs-src-pi-ptc-next-main--/2026-09-25T22-43-33-809Z_01a0dabc-fd30-73f0-bc81-c56bdfba55bc.jsonl` |
| 16 | Long-blocking orchestration inside PTC chunks | ~4/9 PTC-using sessions (~44%); every sampled PTC agent-orchestration attempt hit it | No | `--home-zlare-docs-src-pi-ui-forge--/2026-09-23T22-53-29-143Z_01a0d079-5ab7-730f-b6e4-33ed05710e40.jsonl`<br>`--home-zlare-docs-src-preTTY-main--/2026-09-19T20-01-03-973Z_01a0bb42-0fe4-71e0-ae7d-99173bd0ac33.jsonl`<br>`--home-zlare-docs-src-pi-ptc-next-main--/2026-09-26T00-23-10-761Z_01a0db18-30a9-763e-898d-c065ae59735e.jsonl`<br>`--home-zlare-docs-src-pi-ptc-next-main--/2026-09-26T00-02-24-606Z_01a0db05-2cde-735e-8790-6ed0134a22f7.jsonl` |
| 17 | Opaque, context-free error results from code execution | ~3/9 PTC-using sessions (~33%); ~10–12% of `code_execution` calls | No | `--home-zlare-docs-src-pi-ptc-next-main--/2026-09-25T22-43-33-809Z_01a0dabc-fd30-73f0-bc81-c56bdfba55bc.jsonl`<br>`--home-zlare-docs-src--/2026-09-07T12-03-09-283Z_01a07bc0-3563-74c2-981c-ddfbfc13d70f.jsonl`<br>`--home-zlare-Downloads--/2026-09-18T20-48-54-674Z_01a0b647-8191-77cb-8cbc-8f611ca08619.jsonl` |
| 18 | Two coexisting code-run APIs cause duplicated work and API guessing | 5/9 PTC-using sessions (~56%) | No | `--home-zlare-docs-src-preTTY-main--/2026-09-19T20-01-03-973Z_01a0bb42-0fe4-71e0-ae7d-99173bd0ac33.jsonl`<br>`--home-zlare-docs-src-pi-ptc-next-main--/2026-09-25T22-43-33-809Z_01a0dabc-fd30-73f0-bc81-c56bdfba55bc.jsonl`<br>`--home-zlare-Downloads--/2026-09-18T20-48-54-674Z_01a0b647-8191-77cb-8cbc-8f611ca08619.jsonl`<br>`--home-zlare-docs-src--/2026-09-07T12-03-09-283Z_01a07bc0-3563-74c2-981c-ddfbfc13d70f.jsonl` |
| 19 | No auto-echo: `print()` scaffolding required in every chunk | 100% of old-system `python_exec` usage in the cited preTTY run (113/113 chunks; average 5.3 prints/chunk) | Yes | `--home-zlare-docs-src-preTTY-main--/2026-09-19T20-01-03-973Z_01a0bb42-0fe4-71e0-ae7d-99173bd0ac33.jsonl`<br>`--home-zlare-Downloads--/2026-09-18T20-48-54-674Z_01a0b647-8191-77cb-8cbc-8f611ca08619.jsonl` |
| 20 | Out-of-band dependency installs via bash with hardcoded venv path | 3/9 PTC-using sessions (~33%) | Yes | `--home-zlare-docs-src-pi-ptc-next-main--/2026-09-25T19-26-21-740Z_01a0da08-722b-7671-a312-7a113c8e0085.jsonl`<br>sibling sessions `2026-09-25T20-21-18-912Z_01a0da3a-c1c0-7671-a312-7a1566acb238.jsonl` and `2026-09-25T22-43-33-809Z_01a0dabc-fd30-73f0-bc81-c56bdfba55bc.jsonl`<br>`--home-zlare-docs-src-pi-ptc-next-main--/2026-09-26T00-02-24-606Z_01a0db05-2cde-735e-8790-6ed0134a22f7.jsonl` (new-system contrast) |
| 21 | Runtime API discovery by trial and error | **Not available: supplied record truncates immediately after the `description` key begins** | **Unknown; excluded from 15/20 survivor count** | **Not available in supplied record** |
