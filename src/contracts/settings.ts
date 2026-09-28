export interface PtcSettings {
  executionTimeoutMs: number;
  /** Maximum text returned directly to the model before head/tail collapsing. */
  outputPreviewChars: number;
  /** Emergency per-cell capture ceiling; output below this is always persisted in full. */
  maxSpoolChars: number;
  allowMutations: boolean;
  allowBash: boolean;
  maxParallelToolCalls: number;
  debugLogging: boolean;
  autoRoute: boolean;
  autoRecover?: boolean;
  autoRecoverMaxAttempts?: number;
  trustedReadOnlyTools?: string[];
  callableTools?: string[];
  blockedTools?: string[];
  maxPythonSessions: number;
  scriptsDir?: string;
  /** Reusable notebook library; env fallback is PTC_LIBRARY_DIR. */
  libraryDir?: string;
  subagentsProfile?: string;
  subagentFooter: boolean;
}
