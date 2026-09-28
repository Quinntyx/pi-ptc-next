import type { PtcSettings } from "./contracts/settings";
import { PtcAbortError, PtcTimeoutError } from "./execution/execution-errors";

export type RecoveryFailureClass = "missing-await" | "async-wrapper-iterated";
export type RecoveryTerminalState = "success" | "failed_without_recovery" | "failed_after_recovery";
export type PtcFirstToolPath = "code_execution" | "direct";

export interface PtcRecoveryState {
  autoRouted: boolean;
  firstToolPath: PtcFirstToolPath | null;
  routedToCodeExecution: boolean;
  codeExecutionAttempts: number;
  recoveryAttempted: boolean;
  recoveryAttemptCount: number;
  failureClass: RecoveryFailureClass | null;
  terminalState: RecoveryTerminalState | null;
}

export interface PtcExecutionTelemetry {
  autoRouted: boolean;
  firstToolPath: PtcFirstToolPath | null;
  routedToCodeExecution: boolean;
  codeExecutionAttempts: number;
  recoveryAttemptCount: number;
  terminalState: RecoveryTerminalState | null;
}

export interface PtcRecoveryDetails {
  eligible: boolean;
  attempted: boolean;
  failureClass: RecoveryFailureClass | null;
}

export function createPtcRecoveryState(): PtcRecoveryState {
  return {
    autoRouted: false,
    firstToolPath: null,
    routedToCodeExecution: false,
    codeExecutionAttempts: 0,
    recoveryAttempted: false,
    recoveryAttemptCount: 0,
    failureClass: null,
    terminalState: null,
  };
}

export function noteAutomaticRouting(state: PtcRecoveryState): void {
  state.autoRouted = true;
}

export function noteCodeExecutionAttempt(state: PtcRecoveryState): void {
  state.routedToCodeExecution = true;
  if (!state.firstToolPath) {
    state.firstToolPath = "code_execution";
  }
  state.codeExecutionAttempts += 1;
}

/**
 * Records that the request was answered directly (without routing to code
 * execution) so `firstToolPath: "direct"` is actually produced rather than
 * merely declared. Call once per request, before any code-execution attempt.
 */
export function noteDirectToolCall(state: PtcRecoveryState): void {
  if (!state.firstToolPath) {
    state.firstToolPath = "direct";
  }
}

export function canAttemptAutomaticRecovery(
  state: PtcRecoveryState,
  settings: Pick<PtcSettings, "autoRecover" | "autoRecoverMaxAttempts">
): boolean {
  const maxAttempts = Math.max(0, settings.autoRecoverMaxAttempts ?? 1);
  return (
    settings.autoRecover === true &&
    maxAttempts > 0 &&
    state.codeExecutionAttempts > 0 &&
    state.recoveryAttemptCount < maxAttempts
  );
}

export function armAutomaticRecovery(
  state: PtcRecoveryState,
  settings: Pick<PtcSettings, "autoRecover" | "autoRecoverMaxAttempts">,
  failureClass: RecoveryFailureClass
): boolean {
  if (!canAttemptAutomaticRecovery(state, settings)) {
    return false;
  }

  state.recoveryAttempted = true;
  state.recoveryAttemptCount += 1;
  state.failureClass = failureClass;
  return true;
}

export function noteCodeExecutionSuccess(state: PtcRecoveryState): void {
  state.terminalState = "success";
}

export function noteCodeExecutionFailure(state: PtcRecoveryState, error?: unknown): void {
  // User aborts (Ctrl-C) and host-side timeouts are not recoverable execution
  // failures: stamping them as terminal failures misrepresents the run as one
  // where recovery logic failed, so leave terminalState untouched.
  if (error instanceof PtcAbortError || error instanceof PtcTimeoutError) {
    return;
  }
  state.terminalState = state.recoveryAttempted ? "failed_after_recovery" : "failed_without_recovery";
}

export function buildPtcExecutionTelemetry(state: PtcRecoveryState): PtcExecutionTelemetry {
  return {
    autoRouted: state.autoRouted,
    firstToolPath: state.firstToolPath,
    routedToCodeExecution: state.routedToCodeExecution,
    codeExecutionAttempts: state.codeExecutionAttempts,
    recoveryAttemptCount: state.recoveryAttemptCount,
    terminalState: state.terminalState,
  };
}

export function buildPtcRecoveryDetails(state: PtcRecoveryState): PtcRecoveryDetails {
  return {
    eligible: state.failureClass !== null,
    attempted: state.recoveryAttempted,
    failureClass: state.failureClass,
  };
}
