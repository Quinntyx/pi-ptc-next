export interface PtcSettings {
  executionTimeoutMs: number;
  maxOutputChars: number;
  allowMutations: boolean;
  allowBash: boolean;
  maxParallelToolCalls: number;
  useDocker: boolean;
  allowUnsandboxedSubprocess: boolean;
  debugLogging: boolean;
  autoRoute: boolean;
  autoRecover?: boolean;
  autoRecoverMaxAttempts?: number;
  trustedReadOnlyTools?: string[];
  callableTools?: string[];
  blockedTools?: string[];
  maxPythonSessions: number;
  scriptsDir?: string;
  subagentsProfile?: string;
  subagentFooter: boolean;
}
