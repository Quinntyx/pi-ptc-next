# Searchable, progressively-disclosed API catalog for pi-ptc-next

**Status:** plan (docs only)
**Scope:** a Code Mode-style discovery surface — `search_api(query, kind?)` → names + summaries, `describe_api(name)` → full signatures/schemas — so the model stops guessing helper names (`ModelInfo.get`, `pi_subagents.list`, `No module named ptc`) and stops paying an always-on catalog tax in tool descriptions.

Everything below is grounded in the actual code:

- `src/index.ts` — `buildToolDescription()`, `currentToolDescription()`, `execCellTool()`, `inspectKernelTool()`, `onToolSetChanged` hot-reload path
- `src/tool-registry.ts` — `ToolRegistry.getCallableTools()`, `createCallableToolRuntime()`, `getConfiguredCallers()`
- `src/tools/python-tool-contract.ts` — `describePythonHelper()`, `buildPythonParamMetadata()`, `schemaToPythonType()`, `getPythonReturnType()`
- `src/tools/tool-wrapper.ts` — `generateToolWrappers()`
- `src/execution/session-prelude.ts` — `buildSessionPrelude()` (injects wrappers + runtime into the interpreter)
- `src/python-session-manager.ts` — `provision()` at ~L790 (calls `generateToolWrappers(callableToolRuntime.tools)` at L838)
- `src/contracts/execution-types.ts` — `RpcMessage` union
- `src/rpc-protocol.ts` — `PersistentSessionProtocol` message dispatch (the `case "tool_call" | "execution_progress" | …` switch at ~L600)
- `src/python-runtime/runtime.py` — `_PtcHelpers` (L162), `_LazyModuleProxy` (L225)
- `src/python-runtime/session.py` — notebook binding (`_ptc_notebook_write`, L372), kernel digest (`_ptc_kernel_digest`, L293)
- `src/python-runtime/rpc.py` — `_rpc_call()` (L222), the Python-side RPC client
- `src/contracts/tool-types.ts` — `PtcToolOptions` (`ptc.enabled/readOnly/pythonName/callers`)

---

## 1. Surfaces: in-kernel helpers over an RPC catalog fetch (recommended)

Two options were considered:

### Option A — host tools (`search_api` / `describe_api` registered via `pi.registerTool`)

- ❌ Adds two more always-on tool schemas (~150–300 tok) to every session — the exact tax we are removing.
- ❌ Discovery results land in the chat transcript (tool result → context), defeating the "intermediates stay out of context" PTC value proposition for large catalogs.
- ❌ The failure mode being fixed happens *inside* `exec_cell` (the model writes `ModelInfo.get(...)` in a cell, gets `AttributeError`/`NameError`). A host tool forces a context switch out of the kernel to discover, then back in. An in-kernel helper fixes the mistake in the same cell loop: one failed cell → `search_api(...)` in the next cell → corrected call, all without leaving `exec_cell`.

### Option B (recommended) — in-kernel helpers that fetch the catalog over RPC

- ✅ Zero always-on context cost: `search_api`/`describe_api` are Python names in the kernel namespace, advertised by **two lines** added to `buildToolDescription()`'s static tail.
- ✅ Search results, catalog listings, and full signatures stay in the kernel unless the model prints them — the same discipline as every other intermediate.
- ✅ The catalog is served fresh per request from the host, so hot-reloaded custom tools (`CustomToolManager` → `onToolSetChanged` in `src/index.ts`) are picked up with no cache invalidation logic in the kernel.
- ✅ Reuses the existing, proven RPC path: Python `tool_call` frames → `PersistentSessionProtocol` → `CallableToolRuntime.runTool` (`src/tool-registry.ts`).

**Decision: Option B.** The only host-side change is documentation text (one pointer line), not new host tools.

### Concrete mechanics

1. **New RPC message type.** Extend the `RpcMessage` union in `src/contracts/execution-types.ts`:

   ```ts
   | { type: "api_catalog"; id: string }                                     // Python → host: full/summary catalog
   | { type: "api_catalog_result"; id: string; version: string; entries: ApiCatalogEntry[] }
   ```

   Handle `"api_catalog"` in the dispatch switch in `src/rpc-protocol.ts` (`PersistentSessionProtocol`) next to `case "tool_call"`. The handler calls a new method on the runtime it already holds (same object that implements `runTool`), built by the catalog builder in §2/§3.

   Alternative considered and rejected: reusing `tool_call` with a synthetic tool name `"ptc_api_catalog"`. Rejected because `runTool` validates against `getCallableTools()` (which excludes PTC-owned names via `isPtcOwnedTool` in `src/tool-registry.ts`) and would need a special case anyway; a dedicated frame keeps the policy path untouched.

2. **Python helpers.** Add to the kernel namespace in `src/python-runtime/runtime.py` (alongside `_PtcHelpers`, L162) or `session.py`:

   ```python
   def search_api(query: str, kind: str | None = None, limit: int = 10) -> list[dict]:
       """Search the API catalog. kind ∈ {"tool","helper","subagent","runtime"}. Returns [{name, kind, signature, summary}]."""

   def describe_api(name: str) -> dict:
       """Full signature + params + docstring for one catalog entry. Materializes callable wrappers for host tools."""
   ```

   Both are thin clients over `_rpc_call`-style frames (a new `_rpc_request("api_catalog", …)` in `src/python-runtime/rpc.py` next to `_rpc_call`, L222). They run **synchronously from the model's perspective** inside a cell (top-level `await` is already available, and they're cheap host-side calls — no subprocess, no tool execution).

3. **Advertisement.** `buildToolDescription()` in `src/index.ts` gains two static lines in its tail block:

   ```
   - search_api(query, kind=None) -> list[dict]   # find any helper/tool/subagent API by keyword
   - describe_api(name) -> dict                   # full signature; materializes tool wrappers on demand
   ```

   plus a one-line rule in `EXEC_CELL_DESCRIPTION` (`src/index.ts`): *"If a name is not in the short list above, call `search_api(...)` in a cell instead of guessing."* This directly targets the observed guessing storms.

---

## 2. What the catalog indexes

One `ApiCatalogEntry` shape, four kinds:

```ts
interface ApiCatalogEntry {
  name: string;          // unique, e.g. "read", "ptc.read_tree", "pi_subagents.AgentPool.stage", "subagents"
  kind: "tool" | "helper" | "subagent" | "runtime";
  signature: string;     // inline Python signature (see §3)
  summary: string;       // one sentence, ≤120 chars
  detail?: string;       // longer docstring (describe_api only)
  callable: boolean;     // describe_api materializes a wrapper?
  rpcName?: string;      // host tool name for _rpc_call (may differ from pythonName)
}
```

| Source | Kind | Where it comes from |
|---|---|---|
| Callable host tools (read, glob, find, grep, ls, bash, edit, write, opted-in custom/extension tools) | `tool` | `ToolRegistry.getCallableTools(cwd, settings)` in `src/tool-registry.ts` — the *same* policy-filtered list already passed to `generateToolWrappers()` at `src/python-session-manager.ts:838`. One source of truth; the catalog can never list a tool the wrappers don't implement. |
| `ptc.*` runtime helpers (`gather_limit`, `read_many`, `read_tree`, `find_files`, `find_files_abs`, `read_text`, `json_dump`) | `helper` | Hand-maintained static entries in the new `src/api-catalog/` module, kept in sync with `_PtcHelpers` in `src/python-runtime/runtime.py` (L162–223). A unit test cross-checks the static list against `dir(_PtcHelpers)` at runtime-test level (§7). |
| `pi_subagents` Python surface | `subagent` | Generated **in-kernel** with `inspect` at first request and cached per kernel: classes `AgentPool` (`stage`, `pop`, `handles`, `snapshot`, `close`), `AgentStage` (`submit`, `submit_all`, `snapshot`), `AgentHandle` (`wait`/`wait_async`, `send`/`send_async`, `abort`/`abort_async`, `resume`/`resume_async`, `state`/`state_async`, `activity`, `result`, `kill`, `session`), module functions from `pi_subagents.__all__` (`list_agents`, `stop_all`, `finish`, `list_models`, `resolve_models`, `best_model_match`, `capabilities`, …). Names are namespaced `pi_subagents.<Class>.<method>`; the autoimported binding `subagents` (see `buildSessionPrelude()` in `src/execution/session-prelude.ts`) is catalogued as a `runtime` entry pointing at the same methods. Introspection must run in-kernel because pi_subagents is an external editable install (`~/.cache/pi-ptc/python-env`, provisioned by `src/subagents-env.ts`) whose version can drift independently of this package — hand-written entries would go stale silently. |
| Kernel/session runtime objects | `runtime` | The notebook binding (`session_id`, notebook path, cell count — from `SessionSummary`/`SessionRecord` in `src/python-session-manager.ts`), `PTC_*` constants injected by `buildSessionPrelude()`, and `np`/`pd`/`plt` lazy-import proxies (`_LazyModuleProxy`, `runtime.py` L225). |
| Host PTC tools themselves (`provision_kernel`, `exec_cell`, `inspect_kernel`, `provision_dependency`, `list_kernels`) | `tool`, `callable: false` | Static entries from `PTC_TOOL_NAMES` in `src/contracts/tool-types.ts`; describe-only (they're host tools, not in-kernel callables). Mostly useful for subagents that see a reduced tool set. |

**`read_cell_output` note:** this helper does **not exist yet** anywhere in the repo (verified: no match in `src/`). The plan treats it as a small companion feature: add `ptc.read_cell_output(session_id, exec_id)` to `_PtcHelpers` (backed by the notebook document already rendered by `_ptc_render_notebook_document`, `session.py` L346) and a catalog entry with it. It is not a prerequisite for the catalog.

**`NotebookClient` note:** there is no `NotebookClient` class in this repo; the notebook is written host-side (`_ptc_notebook_write`, `session.py` L372). The "runtime object" catalog entry covers the binding the model actually has (`session_id`, notebook path); if a client-style object is ever added, it lands in the same `runtime` kind with zero new machinery.

---

## 3. Extracting signatures and summaries (reuse existing machinery)

**For `kind: "tool"`** — this is a direct extension of what already runs at provision time:

- Signature: `describePythonHelper(tool)` in `src/tools/python-tool-contract.ts` — already produces `read(path: str, *, offset: Optional[int] = None, limit: Optional[int] = None) -> str` from TSchema via `buildPythonParamMetadata()` + `schemaToPythonType()` + `getBuiltinToolContract().helperSignature`. Measured output for the default 5-tool set is 583 chars for all five lines — exactly what today's `buildToolDescription()` already renders.
- Summary: first sentence of `tool.description`. For custom tools, add an optional `ptc.summary?: string` to `PtcToolOptions` (`src/contracts/tool-types.ts`) and prefer it in `CustomToolManager.upsertTool` → `ToolRegistry.upsertTool`. Falls back to first sentence, then `"(no summary)"`.
- Full schema (describe_api): reuse `buildPythonParamMetadata()` to render a per-param table (`name: type, required/optional, description from the TSchema `description` field) plus the tool's full description.

**For `kind: "helper"`** — signatures hand-written in `src/api-catalog/catalog.ts` (they are 7 stable functions; see the list in README "Python helpers"). Unit test asserts parity with `_PtcHelpers`.

**For `kind: "subagent"`** — `inspect.signature(fn)` + `inspect.getdoc()` computed inside the kernel on first `search_api`/`describe_api` call touching `pi_subagents`, cached in a module-level dict keyed by `(id(module), version)`. Rendering uses the same inline-signature style as `buildInlinePythonSignature()` so the model sees one uniform format.

**New module layout:**

```
src/api-catalog/
  catalog.ts          # buildApiCatalog(registry, settings, session): ApiCatalogEntry[]
  catalog-types.ts    # ApiCatalogEntry, ApiCatalogQuery/Result (shared with contracts)
  search.ts           # ranking: exact-name > name-prefix > token-overlap(name, summary)
```

`buildApiCatalog()` is called by the `api_catalog` RPC handler in `src/rpc-protocol.ts` with the same `CallableToolRuntime` inputs `provision()` already assembles (`src/python-session-manager.ts:827-839`), so policy filtering (`getCallableTools`) and name validation (`validatePythonHelperNames`) apply identically.

---

## 4. Progressive disclosure

**Initial prelude** (`buildSessionPrelude()`, `src/execution/session-prelude.ts`) changes from "all wrappers, always" to:

1. Always present: the core five generated wrappers — `read`, `glob`, `find`, `grep`, `ls` (the default callable set; measured wrapper source is 2,194 chars — irrelevant to context, trivial to the interpreter).
2. Always present: `search_api` / `describe_api` definitions and `_PtcHelpers` (they live in `runtime.py`, already in the prelude).
3. `pi_subagents` autoimport stays as-is (it already imports lazily enough, and the depth gate in `buildSessionPrelude()` must be preserved).
4. **Everything else materializes on demand**: when the model calls `describe_api("query_db")`, the kernel:
   - receives the full entry (signature, params, docstring, and the *generated wrapper source* — the host runs `generateToolWrappers([tool])` from `src/tools/tool-wrapper.ts` for just that tool and ships it in the `api_catalog_result`),
   - `exec`s the wrapper source in the session namespace (it is exactly the code the prelude would have contained — same `_rpc_call` target, same `_ptc_drop_none`),
   - returns the rendered signature + docstring to the cell.
   Subsequent cells call `query_db(...)` like any pre-provisioned helper. `describe_api` results for definitions are idempotent (re-describing re-execs harmlessly; use `callable` + presence check to skip).

**`buildToolDescription()` trim.** Today it embeds the full helper list (583 chars default; grows ~50–120 tok per opted-in custom tool). New shape:

- static tail: `search_api`/`describe_api` pointer + the four `ptc.*` lines + np/pd/plt line (~479 chars, unchanged);
- dynamic part: **core five signatures only** + `… N more tools — search_api() to find them` when `getCallableTools()` returns more than the core five;
- gating: new setting `PTC_API_DISCLOSURE=progressive|full` (default `full` for one release; flip default after eval green), read in `loadSettingsFromEnv()` (`src/utils.ts`), consumed by `buildToolDescription()` and `currentToolDescription()` (`src/index.ts`). The hot-reload path `onToolSetChanged` (index.ts) keeps working unchanged — it just re-renders the shorter description.

`inspect_kernelTool` (index.ts) embeds the same `toolDescription`; it gets the trimmed version for free since it consumes `currentToolDescription()`.

---

## 5. Token budget math (measured, this repo)

Measured by rendering the real descriptions with the real `dist/tools` machinery against `@mariozechner/pi-coding-agent` builtin tools:

| Block | Chars | ~Tokens (chars/4) |
|---|---|---|
| `EXEC_CELL_DESCRIPTION` (`src/index.ts`) | 1,623 | ~400 |
| `buildToolDescription()` default output (5 callable tools) | 1,064 | ~266 |
| — of which helper signature list | 583 | ~146 |
| — of which static `ptc.*` tail | ~479 | ~120 |
| `exec_cell` full description (exec + toolDescription) | 2,687 | ~670 |
| `inspect_kernel` description (~420 + same toolDescription) | ~1,480 | ~370 |
| `PROVISION_DESCRIPTION` | 985 | ~250 |
| `PROVISION_DEPENDENCY_DESCRIPTION` | 520 | ~130 |
| `list_kernels` description | ~250 | ~60 |
| **PTC always-on total today** | **~5,900** | **~1,480 / turn** |

Scaling problem: every custom tool with `ptc.enabled: true` adds a signature line (~15–30 tok) to *both* `exec_cell` and `inspect_kernel` descriptions (the same 1,064-char block is embedded twice). A session with 15 opted-in tools costs ~2,200 tok/turn before any work; 30 tools ~3,200 tok/turn.

**Progressive-disclosure cost:**

| Block | Chars | ~Tokens |
|---|---|---|
| Trimmed `exec_cell` description (exec + static tail + core five + pointer) | ~2,150 | ~540 |
| Trimmed `inspect_kernel` description | ~950 | ~240 |
| provision / dependency / list_kernels (unchanged) | 1,755 | ~440 |
| **Fixed always-on** | **~4,850** | **~1,220 / turn** |

So the fixed baseline already drops ~260 tok/turn at the default tool set, and — critically — goes **flat** as custom tools are added instead of growing ~2× (the description is embedded twice) × ~25 tok/tool.

**On-demand costs** (only when discovery is actually used, and they land in-cell, not in tool schemas):

- `search_api` hit list: 10 entries × ~12 tok ≈ **~120 tok**
- `describe_api`: signature + params + docstring ≈ **~60–150 tok** per name (vs ~250–1,500 tok to ship a whole tool's JSON schema through a host-tool call)

**Guess-storm math (the real payoff):** one wrong guess (`ModelInfo.get`, `pi_subagents.list`) costs a full failed cell turn — model output + error echo ≈ 300–800 tok — and storms repeat 2–4×. `search_api` replaces a storm with ~120–270 tok, once, and the answer (exact signature) is what the model would have guessed anyway. In the benchmark regime where PTC sessions run 10–30 cells, the break-even against today's baseline is immediate; against the *growing* custom-tool baseline it is strictly positive from the first opted-in tool.

**In-kernel (non-context) cost check:** `generateToolWrappers` for all 8 builtins is 2,863 chars; per-tool describe materialization is ~300 chars. Interpreter-side, negligible.

---

## 6. Rollout steps

1. **Catalog foundation** (`src/api-catalog/`): `catalog-types.ts`, `catalog.ts` (`buildApiCatalog` over `ToolRegistry.getCallableTools` + static helper entries + PTC-owned tool entries), `search.ts` (deterministic ranker: exact > prefix > token overlap; no embeddings).
2. **RPC plumbing**: extend `RpcMessage` in `src/contracts/execution-types.ts` with `api_catalog` / `api_catalog_result`; implement in `PersistentSessionProtocol` (`src/rpc-protocol.ts`); add `_rpc_request` support in `src/python-runtime/rpc.py` (generalize `_rpc_call` at L222 — it already does request/response correlation).
3. **In-kernel helpers**: `search_api` / `describe_api` in `src/python-runtime/runtime.py` (or `session.py` for the materialization exec); pi_subagents introspection with cache.
4. **Progressive materialization**: `describe_api` execs the per-tool wrapper from `generateToolWrappers([tool])`; add the `… N more tools` truncation to `buildToolDescription()`.
5. **Setting + migration**: `PTC_API_DISCLOSURE` in `src/utils.ts` settings loader; default `full` (current behavior) so nothing regresses; docs/README update.
6. **`read_cell_output`** companion helper + catalog entry (optional, can ship separately).
7. **Flip default** to `progressive` after evals (§7) and one release of real-session soak.
8. **Docs**: README section "Discovering APIs in a kernel", `docs/PTC-RESEARCH.md` note.

Each step is independently shippable; 1–3 are inert until 4–5 land.

---

## 7. Risks and mitigations

| Risk | Mitigation |
|---|---|
| **Catalog staleness** (hot-reloaded custom tools change mid-session via `CustomToolManager`) | Catalog is fetched per `search_api`/`describe_api` call from the live `ToolRegistry` — no kernel-side cache of tool entries. `api_catalog_result` carries a `version` string (hash of sorted names + settings fingerprint) the kernel logs in debug only. |
| **Stale materialized wrappers** (a described tool is later removed/blocked by hot reload) | Already handled one layer down: `CallableToolRuntime.runTool` (`src/tool-registry.ts`) throws ``Unknown callable tool: X. Available: …`` — the existing error is surfaced through the normal cell error path, and `describe_api` re-call refreshes. Document the "re-describe after hot reload" behavior in the helper docstring. |
| **Tool-set changes mid-session** (custom tool hot-reload also re-registers `exec_cell`/`inspect_kernel` via `onToolSetChanged`) | Unchanged behavior; the trimmed description re-renders from the same `currentToolDescription()` path. The "N more tools" count stays accurate because it is computed per render. |
| **pi_subagents API drift** (external editable install) | Introspection is done in-kernel at request time with `inspect`, so it can never disagree with the installed package. Cache is keyed per interpreter; a stale cache survives at most one kernel lifetime. |
| **Models ignore `search_api` and keep guessing** | Pointer line + rule in `EXEC_CELL_DESCRIPTION`; failed-cell error text for `NameError` on unknown uppercase/dotted names can append one deterministic hint: `name not found — try search_api("…")` (same pattern as the existing bounded async-recovery hint machinery in `src/recovery-classifier.ts` / `src/recovery-state.ts`, but non-persistent and per-cell). |
| **Full disclosure still needed by some models/evals** | `PTC_API_DISCLOSURE=full` preserves today's exact behavior bit-for-bit. |
| **Search quality** (ranker returns noise) | Deterministic ranker + `kind` filter + unit-tested golden queries (§7 tests); catalog is small (tens of entries), so recall failures are visible in evals, not heisenbugs. |
| **RPC frame complexity** (new message types in the protocol) | Frames are request/response with existing `id` correlation in `rpc.py` `_handle_response`; no new concurrency (handled inline in the protocol loop like `tool_call`). |

---

## Test plan

Unit tests (extend `test/`, Vitest, matching existing suites):

1. **Catalog builder parity** — `buildApiCatalog()` entries for `kind: "tool"` exactly match `getCallableTools()` (names, pythonName mapping, readOnly) for: default set, `PTC_ALLOW_MUTATIONS=true`, `PTC_CALLABLE_TOOLS`/`PTC_BLOCKED_TOOLS` overrides, and a fixture custom tool with `ptc.enabled`/`ptc.summary`/`callers: []` (empty-callers must be excluded — honors the `getExplicitCallers` semantics in `src/contracts/tool-types.ts`).
2. **Signature extraction** — describe output for `grep` matches `describePythonHelper()`; param table renders required vs keyword-only correctly from TSchema.
3. **RPC round-trip** — fake-protocol test: `api_catalog` frame → handler → valid `api_catalog_result` (mirrors existing `rpc-protocol` tests).
4. **In-kernel helpers** — Python-side test: `search_api("tree")` returns `ptc.read_tree`; `describe_api("read")` returns the exact wrapper signature; `describe_api("bash")` with mutations disabled returns a policy error, not a signature.
5. **Materialization** — after `describe_api("grep")`, the name `grep` is callable in the namespace and `_rpc_call` target string is `grep` (fake runtime); re-describe is idempotent.
6. **pi_subagents introspection** — with the real package importable, `search_api("pool", kind="subagent")` finds `pi_subagents.AgentPool.stage` and its signature contains `slots: int`.
7. **Description trimming** — `buildToolDescription()` under `progressive` renders core five + `N more tools` line; under `full` renders identical output to today (golden string).
8. **Hot-reload** — register a custom tool mid-session → next `search_api` sees it; remove it → `describe_api` errors with the `Unknown callable tool` message.

Evals (`.pi/evals/ptc/cases/`, run via `npm run build && node dist/run-benchmarks.js`):

- `api-discovery-subagents`: prompt that requires spawning a staged pool without naming methods; acceptance: `search_api_used=true`, no `AttributeError` for `pi_subagents.*`, `success=true`.
- `api-discovery-custom-tool`: fixture repo with a `ptc.enabled` custom tool not in the short list; acceptance: `describe_api` called before first call, zero failed calls.
- `no-guess-storm-regression`: seeded cases asserting `failure_class=unknown-name` count is 0 under `progressive` (baseline comparison against current storm cases).
- Existing routing/recovery cases must stay green under `full` (default until flip).

---

## Effort estimate: **M** (medium)

Roughly 1 focused week:

- Catalog module + ranker + tests: ~1.5 days
- RPC frames + Python client generalization: ~1 day
- In-kernel `search_api`/`describe_api` + pi_subagents introspection + materialization exec: ~1.5 days
- Description trimming, `PTC_API_DISCLOSURE` setting, README/docs: ~0.5 day
- Evals + benchmark runs + default-flip soak: ~1.5 days

Not S: the RPC surface and the materialization path touch the protocol, the prelude, and the tool-description hot-reload path simultaneously, and the eval harness work is real. Not L: everything reuses existing machinery (`getCallableTools`, `describePythonHelper`, `generateToolWrappers`, `_rpc_call` correlation) and no host tool surface changes.
