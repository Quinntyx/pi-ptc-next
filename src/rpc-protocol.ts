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
  if (isString(value.output)) {
    const images = Array.isArray(value.images) ? (value.images as any) : undefined;
    return { type: "complete", output: value.output, images };
  }

  throw new PtcProtocolError("Invalid complete frame: expected string output.");
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

export class RpcProtocol {
  private lineReader: readline.Interface;
  private completionPromise: Promise<CodeExecutionResult>;
  private completionResolve!: (value: CodeExecutionResult) => void;
  private completionReject!: (error: Error) => void;
  private stderr = "";
  private stdout = "";
  private userCodeLines: string[];
  private completed = false;
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

  constructor(
    private proc: ChildProcess,
    private runTool: RunTool,
    userCode: string,
    private signal?: AbortSignal,
    private onUpdate?: AgentToolUpdateCallback<unknown>
  ) {
    this.userCodeLines = userCode.split("\n");
    this.lineReader = readline.createInterface({
      input: proc.stdout!,
      crlfDelay: Infinity,
    });

    this.completionPromise = new Promise((resolve, reject) => {
      this.completionResolve = resolve;
      this.completionReject = reject;
    });

    this.lineReader.on("line", (line) => {
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
      this.stderr += data.toString();
    });

    proc.on("exit", (code, exitSignal) => {
      if (this.completed) {
        return;
      }

      const exitDescriptor = exitSignal ? `signal ${exitSignal}` : code === null ? "unknown status" : `code ${code}`;
      const stderrSuffix = this.stderr.trim() ? `\n${this.stderr.trim()}` : "";
      this.unexpectedExitMessage = `Python process exited with ${exitDescriptor} before completing the RPC protocol.${stderrSuffix}`;
    });

    proc.on("error", (err) => {
      this.rejectOnce(new PtcTransportError(`Python process transport error: ${err.message}`));
    });

    if (signal) {
      signal.addEventListener(
        "abort",
        () => {
          this.terminateProcess();
          this.rejectOnce(new PtcAbortError("Execution aborted"));
        },
        { once: true }
      );
    }
  }

  private terminateProcess(): void {
    this.proc.kill("SIGTERM");
    setTimeout(() => {
      if (this.proc.exitCode === null) {
        this.proc.kill("SIGKILL");
      }
    }, 5000);
  }

  private appendStdout(text: string): void {
    if (!text) {
      return;
    }

    this.stdout = this.stdout ? `${this.stdout}${text}` : text;
  }

  private resolveOnce(result: CodeExecutionResult): void {
    if (this.completed) {
      return;
    }
    this.completed = true;
    this.completionResolve(result);
  }

  private rejectOnce(error: Error): void {
    if (this.completed) {
      return;
    }
    this.completed = true;
    this.completionReject(error);
  }

  private rejectUnexpectedTransport(message: string): void {
    this.rejectOnce(new PtcTransportError(message));
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
    const msg = this.parseMessage(line);

    switch (msg.type) {
      case "tool_call":
        await this.handleToolCall(msg);
        break;

      case "execution_progress":
        this.currentLine = msg.line;
        this.totalLines = msg.total_lines;
        this.activeTool = undefined;
        if (this.onUpdate) {
          this.onUpdate({
            content: [
              {
                type: "text",
                text: `Executing line ${msg.line}/${msg.total_lines}`,
              },
            ],
            details: this.buildExecutionDetails(),
          });
        }
        break;

      case "stdout":
        this.appendStdout(msg.text);
        break;

      case "complete": {
        const finalOutput = this.stdout ? `${this.stdout}${msg.output}`.trim() : msg.output;
        this.resolveOnce({
          output: finalOutput,
          images: msg.images,
          details: this.buildExecutionDetails(),
        });
        break;
      }

      case "error":
        this.rejectOnce(new PtcPythonError(msg.message, msg.traceback));
        break;

      case "update":
        if (this.onUpdate) {
          this.onUpdate({
            content: [{ type: "text", text: msg.message }],
            details: this.buildExecutionDetails(),
          });
        }
        break;
    }
  }

  private async handleToolCall(msg: Extract<RpcMessage, { type: "tool_call" }>): Promise<void> {
    this.nestedToolCalls += 1;
    this.nestedToolNames.push(msg.tool);
    this.activeTool = msg.tool;

    if (this.onUpdate) {
      this.onUpdate({
        content: [{ type: "text", text: `Calling ${msg.tool}()` }],
        details: this.buildExecutionDetails(),
      });
    }

    try {
      const result = await this.runTool(msg.tool, msg.params, msg.id);
      const normalized = normalizeToolResult(msg.tool, result as { content?: Array<Record<string, unknown>>; details?: unknown });
      this.nestedResultCount += 1;
      this.nestedResultChars += normalized.estimatedChars;

      this.send({
        type: "tool_result",
        id: msg.id,
        value: normalized.value,
      });
    } catch (error) {
      this.nestedErrors += 1;
      this.send({
        type: "tool_result",
        id: msg.id,
        error: serializeError(error),
      });
    } finally {
      this.activeTool = undefined;
    }
  }

  private send(msg: RpcMessage): void {
    if (this.proc.stdin && !this.proc.stdin.destroyed) {
      this.proc.stdin.write(JSON.stringify(msg) + "\n");
    }
  }

  async waitForCompletion(timeoutMs?: number): Promise<CodeExecutionResult> {
    if (timeoutMs === undefined) {
      return this.completionPromise;
    }

    return await Promise.race([
      this.completionPromise,
      new Promise<CodeExecutionResult>((_, reject) => {
        const timeoutId = setTimeout(() => {
          this.terminateProcess();
          reject(
            new PtcTimeoutError(
              `Execution timed out after ${Math.round(timeoutMs / 1000)} seconds`
            )
          );
        }, timeoutMs);

        this.completionPromise.finally(() => clearTimeout(timeoutId)).catch(() => undefined);
      }),
    ]);
  }
}
