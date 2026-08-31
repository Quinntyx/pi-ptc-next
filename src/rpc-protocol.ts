import { ChildProcess } from "child_process";
import readline from "readline";
import type { AgentToolUpdateCallback } from "@mariozechner/pi-coding-agent";
import {
  PtcAbortError,
  PtcProtocolError,
  PtcPythonError,
  PtcTimeoutError,
  PtcTransportError,
} from "./execution/execution-errors";
import { normalizeToolResult } from "./tool-adapters";
import { estimateTokensFromChars } from "./utils";
import type { CodeExecutionResult, ExecutionDetails, RpcErrorPayload, RpcMessage } from "./contracts/execution-types";

type RunTool = (toolName: string, params: unknown, nestedCallId: string) => Promise<unknown>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isRpcErrorPayload(value: unknown): value is RpcErrorPayload {
  return isRecord(value) && isString(value.type) && isString(value.message) && (value.stack === undefined || isString(value.stack));
}

type RpcMessageType = RpcMessage["type"];
type RpcMessageValidator<TType extends RpcMessageType> = (
  value: Record<string, unknown>
) => Extract<RpcMessage, { type: TType }>;

function validateToolCallMessage(value: Record<string, unknown>): Extract<RpcMessage, { type: "tool_call" }> {
  if (isString(value.id) && isString(value.tool) && isRecord(value.params)) {
    return {
      type: "tool_call",
      id: value.id,
      tool: value.tool,
      params: value.params,
    };
  }

  throw new PtcProtocolError("Invalid tool_call frame: expected string id/tool and object params.");
}

function validateToolResultMessage(value: Record<string, unknown>): Extract<RpcMessage, { type: "tool_result" }> {
  if (!isString(value.id)) {
    throw new PtcProtocolError("Invalid tool_result frame: expected string id.");
  }
  if (value.error !== undefined && !isRpcErrorPayload(value.error)) {
    throw new PtcProtocolError("Invalid tool_result frame: error must match RpcErrorPayload.");
  }

  return {
    type: "tool_result",
    id: value.id,
    value: value.value,
    error: value.error,
  };
}

function validateExecutionProgressMessage(
  value: Record<string, unknown>
): Extract<RpcMessage, { type: "execution_progress" }> {
  if (typeof value.line === "number" && typeof value.total_lines === "number") {
    return {
      type: "execution_progress",
      line: value.line,
      total_lines: value.total_lines,
    };
  }

  throw new PtcProtocolError("Invalid execution_progress frame: expected numeric line and total_lines.");
}

function validateStdoutMessage(value: Record<string, unknown>): Extract<RpcMessage, { type: "stdout" }> {
  if (isString(value.text)) {
    return { type: "stdout", text: value.text };
  }

  throw new PtcProtocolError("Invalid stdout frame: expected string text.");
}

function validateCompleteMessage(value: Record<string, unknown>): Extract<RpcMessage, { type: "complete" }> {
  const totalOutputChars = value.total_output_chars;
  if (
    isString(value.output) &&
    (totalOutputChars === undefined ||
      (typeof totalOutputChars === "number" && Number.isFinite(totalOutputChars) && totalOutputChars >= 0))
  ) {
    const images = Array.isArray(value.images) ? (value.images as any) : undefined;
    return {
      type: "complete",
      output: value.output,
      images,
      total_output_chars: totalOutputChars,
    };
  }

  throw new PtcProtocolError(
    "Invalid complete frame: expected string output and optional non-negative total_output_chars."
  );
}

function validateErrorMessage(value: Record<string, unknown>): Extract<RpcMessage, { type: "error" }> {
  if (isString(value.message) && (value.traceback === undefined || isString(value.traceback))) {
    return {
      type: "error",
      message: value.message,
      traceback: value.traceback,
    };
  }

  throw new PtcProtocolError("Invalid error frame: expected string message and optional traceback.");
}

function validateUpdateMessage(value: Record<string, unknown>): Extract<RpcMessage, { type: "update" }> {
  if (isString(value.message)) {
    return { type: "update", message: value.message };
  }

  throw new PtcProtocolError("Invalid update frame: expected string message.");
}

const RPC_MESSAGE_VALIDATORS: { [K in RpcMessageType]: RpcMessageValidator<K> } = {
  tool_call: validateToolCallMessage,
  tool_result: validateToolResultMessage,
  execution_progress: validateExecutionProgressMessage,
  stdout: validateStdoutMessage,
  complete: validateCompleteMessage,
  error: validateErrorMessage,
  update: validateUpdateMessage,
};

function validateRpcMessage(value: unknown): RpcMessage {
  if (!isRecord(value) || !isString(value.type)) {
    throw new PtcProtocolError("RPC frame must be an object with a string type field.");
  }

  if (!(value.type in RPC_MESSAGE_VALIDATORS)) {
    throw new PtcProtocolError(`Unknown RPC frame type: ${value.type}`);
  }

  return RPC_MESSAGE_VALIDATORS[value.type as RpcMessageType](value);
}

function serializeError(error: unknown): RpcErrorPayload {
  if (error instanceof Error) {
    return {
      type: error.name,
      message: error.message,
      stack: error.stack,
    };
  }

  return {
    type: "Error",
    message: String(error),
  };
}

const DEFAULT_MAX_OUTPUT_CHARS = 100_000;
const MAX_STDERR_CHARS = 64_000;
const EXIT_FRAME_GRACE_MS = 100;
const NATURAL_EXIT_GRACE_MS = 250;
const TERMINATION_GRACE_MS = 1_000;

export interface RpcProtocolOptions {
  maxOutputChars?: number;
  /** Abort nested host tools when the Python execution fails or times out. */
  onFailure?: (error: Error) => void;
  /** Sandbox-aware termination (for example, killing a local process group). */
  terminateProcess?: (signal: NodeJS.Signals) => boolean;
}

export class RpcProtocol {
  private lineReader: readline.Interface;
  private completionPromise: Promise<CodeExecutionResult>;
  private completionResolve!: (value: CodeExecutionResult) => void;
  private completionReject!: (error: Error) => void;
  private processExitPromise: Promise<void>;
  private processExitResolve!: () => void;
  private stderr = "";
  private stderrCharsSeen = 0;
  private stdout = "";
  private stdoutCharsSeen = 0;
  private userCodeLines: string[];
  private completed = false;
  private succeeded = false;
  private processExited = false;
  private unexpectedExitMessage: string | null = null;
  private startedAt = Date.now();
  private nestedToolCalls = 0;
  private nestedToolNames: string[] = [];
  private nestedResultChars = 0;
  private nestedResultCount = 0;
  private nestedErrors = 0;
  private currentLine?: number;
  private totalLines?: number;
  private activeTool?: string;
  private executionTimeout?: NodeJS.Timeout;
  private exitFrameTimer?: NodeJS.Timeout;
  private forceKillTimer?: NodeJS.Timeout;
  private abortHandler?: () => void;
  private readonly maxOutputChars: number;

  constructor(
    private proc: ChildProcess,
    private runTool: RunTool,
    userCode: string,
    private signal?: AbortSignal,
    private onUpdate?: AgentToolUpdateCallback<unknown>,
    private options: RpcProtocolOptions = {}
  ) {
    this.userCodeLines = userCode.split("\n");
    this.maxOutputChars = Number.isFinite(options.maxOutputChars) && (options.maxOutputChars as number) > 0
      ? Math.floor(options.maxOutputChars as number)
      : DEFAULT_MAX_OUTPUT_CHARS;

    if (!proc.stdout) {
      throw new PtcTransportError("Python process did not expose stdout for the RPC protocol.");
    }

    this.lineReader = readline.createInterface({
      input: proc.stdout,
      crlfDelay: Infinity,
    });

    this.completionPromise = new Promise((resolve, reject) => {
      this.completionResolve = resolve;
      this.completionReject = reject;
    });
    // Keep lifecycle cleanup safe even when a caller abandons or replaces the
    // waiter; consumers awaiting the original promise still receive the error.
    void this.completionPromise.catch(() => undefined);
    this.processExitPromise = new Promise((resolve) => {
      this.processExitResolve = resolve;
    });

    this.lineReader.on("line", (line) => {
      if (this.completed) {
        return;
      }
      void this.handleLine(line).catch((error) => {
        this.rejectOnce(error instanceof Error ? error : new PtcProtocolError(String(error)));
      });
    });
    this.lineReader.on("close", () => {
      if (this.completed) {
        return;
      }

      this.rejectUnexpectedTransport(
        this.unexpectedExitMessage || "RPC stdout closed before a terminal protocol message was received."
      );
    });

    proc.stderr?.on("data", (data) => {
      const text = data.toString();
      this.stderrCharsSeen += text.length;
      const remaining = MAX_STDERR_CHARS - this.stderr.length;
      if (remaining > 0) {
        this.stderr += text.slice(0, remaining);
      }
    });

    proc.stdin?.on("error", (error) => {
      this.rejectOnce(new PtcTransportError(`Python process stdin failed: ${error.message}`));
    });

    proc.on("exit", (code, exitSignal) => {
      this.processExited = true;
      this.processExitResolve();
      this.clearForceKillTimer();

      if (this.completed) {
        return;
      }

      const exitDescriptor = exitSignal ? `signal ${exitSignal}` : code === null ? "unknown status" : `code ${code}`;
      this.unexpectedExitMessage = `Python process exited with ${exitDescriptor} before completing the RPC protocol.`;

      // `exit` can precede the final buffered stdout frame. Give readline a
      // brief chance to parse it, but do not wait forever when a grandchild
      // inherited stdout and keeps the pipe open.
      this.exitFrameTimer = setTimeout(() => {
        if (!this.completed) {
          this.rejectUnexpectedTransport(this.buildUnexpectedExitMessage());
        }
      }, EXIT_FRAME_GRACE_MS);
    });

    proc.on("error", (error) => {
      this.processExited = true;
      this.processExitResolve();
      this.rejectOnce(new PtcTransportError(`Python process transport error: ${error.message}`), false);
    });

    if (signal) {
      this.abortHandler = () => {
        this.rejectOnce(new PtcAbortError("Execution aborted"));
      };
      if (signal.aborted) {
        queueMicrotask(this.abortHandler);
      } else {
        signal.addEventListener("abort", this.abortHandler, { once: true });
      }
    }
  }

  private isProcessRunning(): boolean {
    return !this.processExited && this.proc.exitCode === null && this.proc.signalCode === null;
  }

  private clearForceKillTimer(): void {
    if (this.forceKillTimer) {
      clearTimeout(this.forceKillTimer);
      this.forceKillTimer = undefined;
    }
  }

  private clearSettlementResources(): void {
    if (this.executionTimeout) {
      clearTimeout(this.executionTimeout);
      this.executionTimeout = undefined;
    }
    if (this.exitFrameTimer) {
      clearTimeout(this.exitFrameTimer);
      this.exitFrameTimer = undefined;
    }
    if (this.signal && this.abortHandler) {
      this.signal.removeEventListener("abort", this.abortHandler);
      this.abortHandler = undefined;
    }
  }

  private sendSignal(signal: NodeJS.Signals): boolean {
    if (!this.isProcessRunning()) {
      return false;
    }

    try {
      return this.options.terminateProcess
        ? this.options.terminateProcess(signal)
        : this.proc.kill(signal);
    } catch {
      return false;
    }
  }

  private terminateProcess(): void {
    if (!this.sendSignal("SIGTERM")) {
      return;
    }

    this.clearForceKillTimer();
    this.forceKillTimer = setTimeout(() => {
      if (this.isProcessRunning()) {
        this.sendSignal("SIGKILL");
      }
    }, TERMINATION_GRACE_MS);
    this.forceKillTimer.unref?.();
  }

  private buildUnexpectedExitMessage(): string {
    const base = this.unexpectedExitMessage || "Python process exited before completing the RPC protocol.";
    const stderr = this.stderr.trim();
    const truncated = this.stderrCharsSeen > this.stderr.length
      ? `\n[stderr truncated - showing first ${MAX_STDERR_CHARS} characters of ${this.stderrCharsSeen}]`
      : "";
    return `${base}${stderr ? `\n${stderr}` : ""}${truncated}`;
  }

  private appendStdout(text: string): void {
    if (!text) {
      return;
    }

    this.stdoutCharsSeen += text.length;
    const remaining = this.maxOutputChars - this.stdout.length;
    if (remaining > 0) {
      this.stdout += text.slice(0, remaining);
    }
  }

  private buildFinalOutput(finalText: string, reportedTotalChars?: number): string {
    const observedChars = this.stdoutCharsSeen + finalText.length;
    const totalChars = Math.max(observedChars, reportedTotalChars ?? observedChars);
    const remaining = this.maxOutputChars - this.stdout.length;
    const retainedFinal = remaining > 0 ? finalText.slice(0, remaining) : "";
    const retained = this.stdoutCharsSeen > 0 ? `${this.stdout}${retainedFinal}`.trim() : retainedFinal;

    if (totalChars <= this.maxOutputChars) {
      return retained;
    }
    return `${retained}\n\n[Output truncated - showing first ${this.maxOutputChars} characters of ${totalChars}]`;
  }

  private resolveOnce(result: CodeExecutionResult): void {
    if (this.completed) {
      return;
    }
    this.completed = true;
    this.succeeded = true;
    this.clearSettlementResources();
    this.completionResolve(result);
  }

  private rejectOnce(error: Error, terminate = true): void {
    if (this.completed) {
      return;
    }
    this.completed = true;
    this.clearSettlementResources();

    try {
      this.options.onFailure?.(error);
    } catch {
      // Failure cleanup is best-effort and must not replace the original error.
    }
    if (terminate) {
      this.terminateProcess();
    }
    this.completionReject(error);
  }

  private rejectUnexpectedTransport(message: string): void {
    this.rejectOnce(new PtcTransportError(message), this.isProcessRunning());
  }

  private buildExecutionDetails(overrides?: Partial<ExecutionDetails>): ExecutionDetails {
    return {
      nestedToolCalls: this.nestedToolCalls,
      nestedToolNames: [...this.nestedToolNames],
      nestedResultChars: this.nestedResultChars,
      nestedResultCount: this.nestedResultCount,
      nestedErrors: this.nestedErrors,
      durationMs: Date.now() - this.startedAt,
      estimatedAvoidedTokens: estimateTokensFromChars(this.nestedResultChars),
      currentLine: this.currentLine,
      totalLines: this.totalLines,
      userCode: this.userCodeLines,
      activeTool: this.activeTool,
      ...overrides,
    };
  }

  private parseMessage(line: string): RpcMessage {
    try {
      return validateRpcMessage(JSON.parse(line) as unknown);
    } catch (error) {
      if (error instanceof PtcProtocolError) {
        throw new PtcProtocolError(`${error.message} Line: ${line}`);
      }
      const detail = error instanceof Error ? error.message : String(error);
      throw new PtcProtocolError(`Invalid RPC message from Python stdout: ${detail}. Line: ${line}`);
    }
  }

  private async handleLine(line: string): Promise<void> {
    if (this.completed) {
      return;
    }
    const msg = this.parseMessage(line);

    switch (msg.type) {
      case "tool_call":
        await this.handleToolCall(msg);
        break;

      case "execution_progress":
        this.currentLine = msg.line;
        this.totalLines = msg.total_lines;
        this.activeTool = undefined;
        this.onUpdate?.({
          content: [{ type: "text", text: `Executing line ${msg.line}/${msg.total_lines}` }],
          details: this.buildExecutionDetails(),
        });
        break;

      case "stdout":
        this.appendStdout(msg.text);
        break;

      case "complete":
        this.resolveOnce({
          output: this.buildFinalOutput(msg.output, msg.total_output_chars),
          images: msg.images,
          details: this.buildExecutionDetails(),
        });
        break;

      case "error":
        this.rejectOnce(new PtcPythonError(msg.message, msg.traceback));
        break;

      case "update":
        this.onUpdate?.({
          content: [{ type: "text", text: msg.message }],
          details: this.buildExecutionDetails(),
        });
        break;
    }
  }

  private async handleToolCall(msg: Extract<RpcMessage, { type: "tool_call" }>): Promise<void> {
    this.nestedToolCalls += 1;
    this.nestedToolNames.push(msg.tool);
    this.activeTool = msg.tool;

    this.onUpdate?.({
      content: [{ type: "text", text: `Calling ${msg.tool}()` }],
      details: this.buildExecutionDetails(),
    });

    let response: RpcMessage;
    try {
      const result = await this.runTool(msg.tool, msg.params, msg.id);
      const normalized = normalizeToolResult(
        msg.tool,
        result as { content?: Array<Record<string, unknown>>; details?: unknown }
      );
      this.nestedResultCount += 1;
      this.nestedResultChars += normalized.estimatedChars;
      response = { type: "tool_result", id: msg.id, value: normalized.value };
    } catch (error) {
      this.nestedErrors += 1;
      response = { type: "tool_result", id: msg.id, error: serializeError(error) };
    } finally {
      this.activeTool = undefined;
    }

    if (!this.completed) {
      this.send(response);
    }
  }

  private send(msg: RpcMessage): void {
    if (!this.proc.stdin || this.proc.stdin.destroyed || this.proc.stdin.writableEnded) {
      throw new PtcTransportError("Python process stdin closed before a tool result could be delivered.");
    }

    let serialized: string;
    try {
      serialized = JSON.stringify(msg);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new PtcProtocolError(`Failed to serialize tool result: ${detail}`);
    }
    this.proc.stdin.write(`${serialized}\n`);
  }

  async waitForCompletion(timeoutMs?: number): Promise<CodeExecutionResult> {
    if (timeoutMs !== undefined && !this.executionTimeout && !this.completed) {
      this.executionTimeout = setTimeout(() => {
        this.rejectOnce(
          new PtcTimeoutError(`Execution timed out after ${Math.round(timeoutMs / 1000)} seconds`)
        );
      }, timeoutMs);
    }
    return this.completionPromise;
  }

  private waitForProcessExit(timeoutMs: number): Promise<boolean> {
    if (!this.isProcessRunning()) {
      return Promise.resolve(true);
    }

    return new Promise((resolve) => {
      let settled = false;
      const finish = (exited: boolean) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        resolve(exited);
      };
      const timer = setTimeout(() => finish(!this.isProcessRunning()), timeoutMs);
      void this.processExitPromise.then(() => finish(true));
    });
  }

  /** Ensure the child has exited (and therefore been reaped) before returning. */
  async dispose(): Promise<void> {
    this.clearSettlementResources();

    if (this.succeeded && this.isProcessRunning()) {
      // No more tool responses are expected after a terminal complete frame.
      // Closing stdin also lets Python's reader task observe EOF during cleanup.
      this.proc.stdin?.end();
      await this.waitForProcessExit(NATURAL_EXIT_GRACE_MS);
    }

    if (this.isProcessRunning()) {
      this.terminateProcess();
      await this.waitForProcessExit(TERMINATION_GRACE_MS + 100);
    }

    if (this.isProcessRunning()) {
      this.sendSignal("SIGKILL");
      await this.waitForProcessExit(TERMINATION_GRACE_MS);
    }

    this.clearForceKillTimer();
    this.lineReader.close();
  }
}
