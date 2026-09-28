# Planning notes — review findings needing design work

From the 2026-09-28 review pass. These are the items that need a decision or
cross-repo work rather than a local fix. Everything else from that review
(manifest/naming, `read_cell_output` kernel param + `cellIdx` marker, SystemExit
as cell error, venv readiness gate, `PTC_ALLOW_MUTATIONS` removal, `/workflow`,
per-cell tool ledger + tool subtree rendering, vendored shimmer, README install)
has been implemented; see the changelog/commits.

## 1. Bridging extension tools (review item 8)

**Problem.** Pi tools discovered from other extensions get a placeholder
`execute` that throws (`src/tool-registry.ts`, `source: "extension"`), so cells
see the wrapper but every call fails. Root cause is upstream: pi's
`ExtensionAPI.getAllTools()` returns `ToolInfo`, which is
`Pick<ToolDefinition, "name" | "description" | "parameters" | "promptGuidelines">`
— pi deliberately strips `execute` from what extensions can see, so there is no
programmatic invocation path for other extensions' tools. Without one, "PTC"
over-promises: only PTC-owned tools (builtins we adapt + custom `tools/` files)
are truly callable from cells.

**Options.**

1. **Upstream pi API (preferred).** Propose `pi.callTool(name, params, opts)` on
   `ExtensionAPI`, routed through the same executor the model path uses
   (permissions, truncation, activity labels intact). Fixes the class of
   problem for every extension, keeps one permission path. Cost: a PR and
   release cadence on pi-coding-agent; until it lands we keep the placeholder.
2. **Inter-extension invoke protocol (no upstream change).** Mirror the
   pi-tool-tree pattern (`Symbol.for("pi-tool-tree:api")` on globalThis): define
   `Symbol.for("pi-ptc:tool-invoke")` exposing `{ name, invoke(params) }` per
   extension. PTC bridges extension tools that opt in; the rest keep the clear
   "execute not available" error. Cost: every third-party extension must adopt
   it; but it works today and can coexist with option 1 later.
3. **Drive pi's own tool executor from outside the extension API.** Pi's
   internal tool registry (the activity-label-wrapped one) holds real
   `execute` implementations, but no supported seam reaches it from an
   extension. Synthetic tool-call events / transcript injection would be
   fragile and version-coupled — not recommended except as a last resort.
4. **Honest narrowing.** Bridge only what we own (builtins + custom tools) and
   mark other extension tools as "not cell-callable" in the generated Python
   docs (skip the wrapper entirely instead of shipping a throwing one).

**Recommendation.** Do 4 immediately (stop shipping throwing wrappers — filter
them out of `getCallableTools` and note why in `docs/tool-bridge.md`), and file
option 1 upstream with option 2 as the interim bridge for our own ecosystem
(pi-tool-tree, pi-sock, pi-subagents tooling).

## 2. AgentPool slot race on multi-stage submit (review item 12)

**Problem.** Stages reserve slots as *priorities*, and the scheduler lets idle
stages' reserved slots borrow work. With stage A(4 slots) and B(4 slots) in one
pool, `submit_all(A×8)` followed immediately by `submit_all(B×8)` can start B's
reserved agents on A's work during the window where A's queue is visible and
B's isn't — B's own tasks then wait despite arriving milliseconds later. Works
as coded; wrong for the declared stage layout.

**Options.**

1. **Atomic multi-stage submit.** New API, e.g.
   `pool.submit_all({"build": tasks_a, "review": tasks_b})`, which enqueues all
   stages' tasks within a single scheduler turn before any dispatch decision.
   The existing priority logic then sees both queues and assigns reserved slots
   correctly. Deterministic, backward compatible, small diff.
2. **Submit-window grace.** After `stage.submit_all()`, mark the stage
   "submitting" for a short window (e.g. 250 ms or until the next loop tick);
   foreign slots may not steal its queue during the window. Fixes the common
   sequential-submit pattern but is timing-based — heuristics, not guarantees.
3. **Strict slots mode.** Per-pool `strict=True`: reserved slots never borrow
   across stages; an idle stage's slots stay idle. Perfect stage fidelity,
   worse utilization; a reasonable opt-in for users who care about layout over
   throughput.
4. **Fair-share scheduler.** Replace priority reservation with weighted round
   robin across stages that have queued work. Most correct under contention,
   largest change; overkill unless strict mode proves too rigid.

**Recommendation.** Implement 1 (atomic submit) and expose 3 (`strict`) as an
escape hatch; 2 is a cheap add-on inside 1's scheduler tick if atomicity alone
leaves a gap for the sequential-`submit_all` habit. Work lives in the
pi-subagents repo (`src/pi_subagents/pool.py`).

## 3. Decoupling subagents from pi-profiles (`PI_SUBAGENT_DIR`) (review item 13)

**Problem.** `pi_subagents` speaks in "profiles" (env `PI_SUBAGENTS_PROFILE`,
`PTC_SUBAGENTS_PROFILE` upstream, docs assuming `~/.config/pi/profiles/<name>`)
and hardcodes the `subagents` profile name, coupling it to pi-profiles. The
underlying concept is simply "a different agent dir" — any `PI_CODING_AGENT_DIR`
equivalent works; it does not need pi-profiles at all.

**Design.**

- New env var **`PI_SUBAGENT_DIR`** (naming parity with `PI_CODING_AGENT_DIR` /
  `PI_AGENT_DIR`). Semantics: the agent dir in which spawned subagent pi
  instances run. Default: **the parent's own agent dir** (`PI_CODING_AGENT_DIR`
  / `~/.config/pi`), so installing pi-subagents works instantly with zero
  profile setup — subagents just share the main config.
- A "subagent profile" becomes nothing more than an agent dir: point
  `PI_SUBAGENT_DIR=~/.pi_subagents` (or anywhere) and copy/seed config as
  desired. pi-profiles remains the *recommended* way to create and manage such
  a dir, but is never required.
- Keep `PI_SUBAGENTS_PROFILE` (and PTC's `PTC_SUBAGENTS_PROFILE` /
  `subagentsProfile` setting) as a **deprecated compatibility alias**: when set,
  translate to `<pi-config>/profiles/<name>` and log a deprecation notice
  pointing at `PI_SUBAGENT_DIR`.
- Sweep terminology and any hardcoded `"subagents"` strings in pi-subagents
  (`~/docs/src/pi-subagents`, the private forge repo) — grep for `profiles/`,
  `PI_SUBAGENTS_PROFILE`, and profile-name assumptions; the extension side
  (`src/python-session-manager.ts` `spawnSession`, `PTC_SUBAGENTS_PROFILE`)
  then passes `PI_SUBAGENT_DIR` through instead of, or in addition to, the
  profile shim.
- Docs: rewrite the subagent setup sections (README optional deps,
  `docs/subagents.md`, FAQ) around `PI_SUBAGENT_DIR`, with pi-profiles
  presented as the convenience manager.

**Sequencing.** Requires a release of pi-subagents first (env var + alias),
then the extension's passthrough swap; both are small, but the alias keeps
existing setups working across the transition.
