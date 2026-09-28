const test = require("node:test");
const assert = require("node:assert/strict");
const {
  armAutomaticRecovery,
  buildPtcExecutionTelemetry,
  buildPtcRecoveryDetails,
  canAttemptAutomaticRecovery,
  createPtcRecoveryState,
  noteAutomaticRouting,
  noteCodeExecutionAttempt,
  noteCodeExecutionFailure,
  noteDirectToolCall,
} = require("../dist/recovery-state.js");
const { PtcAbortError, PtcTimeoutError } = require("../dist/execution/execution-errors.js");

test("PtcRecoveryState allows at most one automatic recovery attempt per request", () => {
  const settings = { autoRecover: true, autoRecoverMaxAttempts: 1 };
  const state = createPtcRecoveryState();

  noteCodeExecutionAttempt(state);
  assert.equal(canAttemptAutomaticRecovery(state, settings), true);
  assert.equal(armAutomaticRecovery(state, settings, "missing-await"), true);

  noteCodeExecutionAttempt(state);
  assert.equal(canAttemptAutomaticRecovery(state, settings), false);
  assert.equal(armAutomaticRecovery(state, settings, "async-wrapper-iterated"), false);

  noteCodeExecutionFailure(state);
  assert.deepEqual(state, {
    autoRouted: false,
    firstToolPath: "code_execution",
    routedToCodeExecution: true,
    codeExecutionAttempts: 2,
    recoveryAttempted: true,
    recoveryAttemptCount: 1,
    failureClass: "missing-await",
    terminalState: "failed_after_recovery",
  });
});

test("PtcRecoveryState supports multiple automatic recovery attempts when configured", () => {
  const settings = { autoRecover: true, autoRecoverMaxAttempts: 2 };
  const state = createPtcRecoveryState();

  noteCodeExecutionAttempt(state);
  assert.equal(armAutomaticRecovery(state, settings, "missing-await"), true);

  noteCodeExecutionAttempt(state);
  assert.equal(canAttemptAutomaticRecovery(state, settings), true);
  assert.equal(armAutomaticRecovery(state, settings, "async-wrapper-iterated"), true);

  noteCodeExecutionAttempt(state);
  assert.equal(canAttemptAutomaticRecovery(state, settings), false);
  assert.equal(armAutomaticRecovery(state, settings, "missing-await"), false);
  assert.equal(state.recoveryAttemptCount, 2);
});

test("PtcRecoveryState treats autoRecoverMaxAttempts 0 as a kill switch", () => {
  const settings = { autoRecover: true, autoRecoverMaxAttempts: 0 };
  const state = createPtcRecoveryState();

  noteCodeExecutionAttempt(state);
  assert.equal(canAttemptAutomaticRecovery(state, settings), false);
  assert.equal(armAutomaticRecovery(state, settings, "missing-await"), false);
});

test("PtcRecoveryState does not stamp aborts or timeouts as terminal failures", () => {
  const state = createPtcRecoveryState();
  noteCodeExecutionAttempt(state);
  armAutomaticRecovery(state, { autoRecover: true, autoRecoverMaxAttempts: 1 }, "missing-await");

  noteCodeExecutionFailure(state, new PtcAbortError("Execution aborted"));
  assert.equal(state.terminalState, null);

  noteCodeExecutionFailure(state, new PtcTimeoutError("Execution timed out after 270 seconds"));
  assert.equal(state.terminalState, null);

  noteCodeExecutionFailure(state, new Error("real failure"));
  assert.equal(state.terminalState, "failed_after_recovery");
});

test("PtcRecoveryState records direct tool usage as the first tool path", () => {
  const state = createPtcRecoveryState();
  noteDirectToolCall(state);
  assert.equal(state.firstToolPath, "direct");
  assert.equal(state.routedToCodeExecution, false);

  noteDirectToolCall(state);
  assert.equal(state.firstToolPath, "direct");

  noteCodeExecutionAttempt(state);
  assert.equal(state.firstToolPath, "direct");
  assert.equal(state.routedToCodeExecution, true);
});

test("PtcRecoveryState builds ephemeral execution telemetry snapshots", () => {
  const state = createPtcRecoveryState();

  noteAutomaticRouting(state);
  noteCodeExecutionAttempt(state);
  const telemetry = buildPtcExecutionTelemetry(state);
  const recovery = buildPtcRecoveryDetails(state);

  assert.deepEqual(telemetry, {
    autoRouted: true,
    firstToolPath: "code_execution",
    routedToCodeExecution: true,
    codeExecutionAttempts: 1,
    recoveryAttemptCount: 0,
    terminalState: null,
  });
  assert.deepEqual(recovery, {
    eligible: false,
    attempted: false,
    failureClass: null,
  });
});
