/**
 * Typed execution errors. Subclasses classify failures for the recovery
 * classifier; `PtcPythonError` wraps a Python-side exception (message plus
 * optional traceback, with the raw message kept on `rawMessage`) and
 * `PtcNestedToolError` wraps a tool call that failed inside the cell.
 */

/** Render a Python failure as a single message, appending the traceback when present. */
function formatPythonErrorMessage(message: string, traceback?: string): string {
  if (traceback) {
    return `Python execution error:\n${message}\n\nTraceback:\n${traceback}`;
  }
  return `Python execution error: ${message}`;
}

/** Base class for PTC execution failures; `name` is set to the concrete subclass name. */
export class PtcExecutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** The cell was aborted via its AbortSignal (user interrupt). */
export class PtcAbortError extends PtcExecutionError {}
/** The execution timeout elapsed (see the recovery classifier for handling). */
export class PtcTimeoutError extends PtcExecutionError {}
/** The RPC pipe to the kernel broke or the kernel died. */
export class PtcTransportError extends PtcExecutionError {}
/** An unexpected/malformed RPC frame arrived from the kernel. */
export class PtcProtocolError extends PtcExecutionError {}

/** A Python-level exception raised by the executed code. */
export class PtcPythonError extends PtcExecutionError {
  /** The exception message without the "Python execution error" framing. */
  readonly rawMessage: string;

  constructor(
    message: string,
    readonly traceback?: string
  ) {
    super(formatPythonErrorMessage(message, traceback));
    this.rawMessage = message;
  }
}

/** A tool call bridged from inside a cell failed; `payload` carries type/message/stack. */
export class PtcNestedToolError extends PtcExecutionError {
  constructor(
    readonly payload: {
      type: string;
      message: string;
      stack?: string;
    }
  ) {
    super(payload.stack ? `${payload.message}\n${payload.stack}` : payload.message);
  }
}
