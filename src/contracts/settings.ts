export interface PtcSettings {
  /** Idle/silence timeout per cell (re-arms on activity), in ms. */
  executionTimeoutMs: number;
  /** Maximum text returned directly to the model before head/tail collapsing. */
  outputPreviewChars: number;
  /** Emergency per-cell capture ceiling; output below this is always persisted in full. */
  maxSpoolChars: number;
  /** Gates the bash bridge inside cells; mutating tools are deliberately ungated (yolo mode). */
  /** Max tool calls a cell may have in flight at once (RPC bridge concurrency). */
  maxParallelToolCalls: number;
  debugLogging: boolean;
  /** Heuristic auto-routing of eligible prompts to code execution. */
  autoRoute: boolean;
  autoRecover?: boolean;
  autoRecoverMaxAttempts?: number;
  /** Allowlist of tools cells may call; unset means all callable tools. */
  callableTools?: string[];
  /** Denylist applied on top of the callable-tool rules. */
  blockedTools?: string[];
  maxPythonSessions: number;
  scriptsDir?: string;
  /** Reusable notebook library; env fallback is PTC_LIBRARY_DIR. */
  libraryDir?: string;
  /** Whether the subagent status footer is shown in exec_cell results. */
  subagentFooter: boolean;
}
