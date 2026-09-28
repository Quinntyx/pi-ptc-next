## Reconciled

- Moved `SessionSummary`, `SessionExecOptions`, and `PythonSessionManagerHooks` into `src/contracts/execution-types.ts`; updated imports and public type exports.
- Wired `sandbox-manager.ts` to shared `venvPythonPath()` from `subagents-env.ts`; removed the duplicate compatibility helper.
- Aligned `renderSubagentNotification(snapshot, theme, execId)` with `index.ts` and tests.
- Removed all Docker settings, environment variables, fixtures, and comments. Docker audit returns no matches.
- Replaced stale `python_exec`, `provision_python_session`, and `python_session_to_script` references with current kernel/cell terminology. Audit returns no matches.
- Updated README architecture and usage for `provision_kernel`, `exec_cell`, `list_kernels`, `inspect_kernel`, and `provision_dependency`.
- Removed remaining background-execution compatibility fields and misleading command text.
- Reworked `process-lifecycle.test.ts`: it previously passed only because it imported stale `dist/code-executor.js`. It now tests the live `PythonSessionManager` implementation and persistent-kernel lifecycle.

## Verification

`npm run build`: **PASS**

| Test file | Result | Time |
|---|---:|---:|
| benchmark-runner | PASS | 0.09s |
| code-view | PASS | 0.09s |
| contracts-public-types | PASS | 0.08s |
| custom-tool-manager | PASS | 4.56s |
| eval-cases | PASS | 0.08s |
| execution-errors | PASS | 0.08s |
| execution-types | PASS | 0.08s |
| index | PASS | 0.20s |
| process-lifecycle | PASS | 1.72s |
| python-session-manager | PASS | 14.32s |
| python-tool-contract | PASS | 0.08s |
| recovery-classifier | PASS | 0.08s |
| recovery-state | PASS | 0.08s |
| rpc-protocol | PASS | 0.21s |
| run-benchmarks | PASS | 0.19s |
| runtime-assets | PASS | 0.08s |
| sandbox-manager | PASS | 0.11s |
| subagent-panel | PASS | 0.08s |
| subagents-env | PASS | 0.15s |
| tool-adapters | PASS | 0.08s |
| tool-registry | PASS | 0.13s |
| tool-types | PASS | 0.08s |
| tool-wrapper | PASS | 0.08s |
| utils | PASS | 0.09s |

No hangs or failures. The slower suites are expected:

- `python-session-manager`: real interpreter integration, deliberate sleeps, idle-timeout and interrupt recovery checks.
- `custom-tool-manager`: filesystem watcher debounce/re-watch timing tests.

## Known remaining issues

None found within the requested scope. All audits, build, and per-file tests are green.