import type { PythonRuntimeSources } from "./runtime-assets";

export interface SessionPreludeOptions {
  sessionId: string;
  toolWrappers: string;
  runtime: PythonRuntimeSources;
  maxParallelToolCalls: number;
  maxOutputChars: number;
  hostWorkspaceRoot: string;
  runtimeWorkspaceRoot: string;
  autoimportSubagents: boolean;
}

/**
 * Builds the persistent interpreter program: rpc bridge + tool wrappers +
 * runtime helpers + (conditional) pi_subagents autoimport + the session exec
 * loop. One interpreter serves many `python_exec` chunks.
 */
export function buildSessionPrelude(options: SessionPreludeOptions): string {
  const {
    sessionId,
    toolWrappers,
    runtime,
    maxParallelToolCalls,
    maxOutputChars,
    hostWorkspaceRoot,
    runtimeWorkspaceRoot,
    autoimportSubagents,
  } = options;

  const autoimports = autoimportSubagents
    ? `# Autoimports (excluded when PI_SUBAGENT_DEPTH is set: spawned agents
# cannot spawn further agents).
try:
    import pi_subagents as _ptc_auto_subagents
    subagents = _ptc_auto_subagents
    pi_subagents = _ptc_auto_subagents
except NotImplementedError:
    pass  # depth-locked environment: subagent spawning disabled
except Exception as _ptc_auto_error:
    print(f"pi_subagents autoimport unavailable: {_ptc_auto_error}", file=__import__("sys").stderr)`
    : `# pi_subagents autoimport excluded: PI_SUBAGENT_DEPTH is set.`;

  return `
${runtime.rpcCode}

${toolWrappers}

PTC_MAX_PARALLEL_TOOL_CALLS = ${maxParallelToolCalls}
PTC_MAX_OUTPUT_CHARS = ${maxOutputChars}
PTC_HOST_WORKSPACE_ROOT = ${JSON.stringify(hostWorkspaceRoot)}
PTC_RUNTIME_WORKSPACE_ROOT = ${JSON.stringify(runtimeWorkspaceRoot)}
PTC_SESSION_ID = ${JSON.stringify(sessionId)}
PTC_USER_CODE_LINE_COUNT = 0

${runtime.runtimeCode}

${autoimports}

PTC_MODE = "session"

${runtime.sessionCode}

# Session entry: run our own loop so SIGINT interrupts a chunk, not the process.
_ptc_session_bootstrap()
`;
}
