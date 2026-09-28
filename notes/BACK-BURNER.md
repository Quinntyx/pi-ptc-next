# PTC Back-Burner / Deferred Decisions

Decisions from the 2026-09-26 feature-audit review. Each entry records what was
decided, why, and the condition for revisiting.

## 1. Duplicate-failure circuit breaker — SPECULATIVE, revisit after `help:` hints bake

- **Idea**: fingerprint normalized cell source + kernel-state digest (file hashes,
  namespace digest, dependency versions); when an identical invocation fails
  deterministically again, return the prior structured failure with a
  `force_retry` escape hatch instead of re-executing.
- **Evidence**: identical-call retry loops appeared in ~50% of heavy mined
  sessions (10–18 consecutive duplicates in the worst two).
- **Decision**: unnecessary machinery *for now*. The cheaper intervention is
  decorating deterministic error results with `help:` hints that nudge the model
  toward the fix (e.g. `ModuleNotFoundError` → "help: install with
  provision_dependency('<dist>') and re-run"). Those hints are being implemented
  with the output-overhaul work.
- **Revisit**: after the `help:` hints have been live for a few weeks, check the
  sessions again for identical-retry loops. If they persist, design the breaker
  (the state digest must include dependency/file/namespace changes so legitimate
  retries are never suppressed).

## 2. Four-session limit disabled — revisit for provisioning churn

- **Idea**: `maxPythonSessions` (default 4, `PTC_MAX_PYTHON_SESSIONS`) capped
  concurrently provisioned interpreters.
- **Decision**: the limit is vestigial under the persistent-kernel design (one
  long-lived kernel per session; provisioning churn was an old-system behavior).
  Enforcement has been commented out. `list_kernels` + explicit `dispose` remain
  the lifecycle tools.
- **Revisit**: in a few weeks, mine sessions for interpreter-provisioning churn
  (many `provision_kernel` calls per session, orphaned interpreters). If churn
  reappears, reintroduce the cap (or a leak-based guard: reap kernels idle for
  N hours) rather than a hard count.

## 3. Kernel checkpoints + rehydration — deferred (needs sandboxing rethink)

- E2B/Daytona-style snapshotting works at the container/VM level (filesystem
  included); a Python-interpreter-level checkpoint is a different, harder
  problem (pickle limits, live handles, sockets). Strong session evidence
  (namespace loss on death/reap), but the cost is a large runtime investment.
- **Revisit**: when/if we adopt any container or process-snapshot substrate;
  a middle path to evaluate then is serializable-globals pickling with honest
  "could not restore" reporting, not full VM snapshots.

## 4. Typed output envelope for exec_cell (tentative)

- Arbitrary Python output can't be schema-typed, but the *envelope* can:
  `{ text: string, metadata: { kernelState, cellIdx, durationMs, images, ... } }`.
- **Revisit**: alongside the API-search work (see docs/API-SEARCH-PLAN.md) —
  a documented result envelope is half of "describable API surface".

## 5. Detached-exec sugar (small, optional)

- Idle-timeout (silence-rearmed, SIGINT-preserving) + live pool/handle objects
  already cover the old hard-timeout failure mode. Remaining nicety: a
  documented "detach now, reattach next cell" pattern and/or ending the tool
  call while agents keep running. Possible refinement: idle timeout fires on
  *pool quiescence* instead of per-frame silence.
