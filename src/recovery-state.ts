import type { PtcSettings } from "./contracts/settings";
import { PtcAbortError, PtcTimeoutError } from "./execution/execution-errors";

/** Failure shapes that automatic recovery knows how to coach the model past. */
export type RecoveryFailureClass = "missing-await" | "async-wrapper-iterated";
/**
 * How a request ended from the recovery system's viewpoint. Aborts and
 * timeouts leave terminalState null (see noteCodeExecutionFailure).
 */
export type RecoveryTerminalState = "success" | "failed_without_recovery" | "failed_after_recovery";
/** Whether the request's first tool use went through code execution or a direct tool call. */
export type PtcFirstToolPath = "code_execution" | "direct";

/**
 * Per-request recovery bookkeeping, threaded through the extension's session
 * state and stamped into exec_cell result details as telemetry.
 */
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

/** Model-safe subset of PtcRecoveryState emitted in tool result details. */
export interface PtcExecutionTelemetry {
  autoRouted: boolean;
  firstToolPath: PtcFirstToolPath | null;
  routedToCodeExecution: boolean;
  codeExecutionAttempts: number;
  recoveryAttemptCount: number;
  terminalState: RecoveryTerminalState | null;
}

/** Whether automatic recovery was eligible, attempted, and for what failure class. */
export interface PtcRecoveryDetails {
  eligible: boolean;
  attempted: boolean;
  failureClass: RecoveryFailureClass | null;
}

/** Fresh per-request state; every counter null/zero. */
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

/** Mark that the routing heuristic (not the model) pushed this request toward exec_cell. */
export function noteAutomaticRouting(state: PtcRecoveryState): void {
  state.autoRouted = true;
}

/** Record one code-execution attempt and set firstToolPath if this is the first. */
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

/** Whether an automatic recovery prompt may still be armed for this request. */
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

/**
 * Arm one automatic recovery attempt (consuming budget) for the given failure
 * class. Returns false when recovery is disabled or the attempt cap is hit.
 */
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

/** Stamp the request as successfully finished. */
export function noteCodeExecutionSuccess(state: PtcRecoveryState): void {
  state.terminalState = "success";
}

/**
 * Stamp a terminal failure state, distinguishing recovered from unrecovered
 * runs. User aborts (Ctrl-C) and host-side timeouts are not recoverable
 * execution failures: stamping them as terminal failures misrepresents the run
 * as one where recovery logic failed, so terminalState is left untouched.
 */
export function noteCodeExecutionFailure(state: PtcRecoveryState, error?: unknown): void {
  if (error instanceof PtcAbortError || error instanceof PtcTimeoutError) {
    return;
  }
  state.terminalState = state.recoveryAttempted ? "failed_after_recovery" : "failed_without_recovery";
}

/** Project the request state into the model-safe telemetry shape. */
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

/** Project whether recovery was eligible/attempted (and its failure class) for result details. */
export function buildPtcRecoveryDetails(state: PtcRecoveryState): PtcRecoveryDetails {
  return {
    eligible: state.failureClass !== null,
    attempted: state.recoveryAttempted,
    failureClass: state.failureClass,
  };
}
