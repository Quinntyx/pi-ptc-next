import readline from "readline";
import { randomUUID } from "crypto";
import * as fs from "fs";
import * as path from "path";
import { homedir } from "os";
import type { ChildProcess } from "child_process";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import {
  PtcAbortError,
  PtcProtocolError,
  PtcPythonError,
  PtcTimeoutError,
} from "./execution/execution-errors";
import { normalizeToolResult } from "./tool-adapters";
import { sectionize } from "./utils";
import { existsSync } from "fs";
import { venvPythonPath, waitForSubagentsEnv } from "./subagents-env";
import { buildSessionPrelude } from "./execution/session-prelude";
import { loadPythonRuntimeSources } from "./execution/runtime-assets";
import type {
  CodeExecutionResult,
  KernelDigest,
  ExecutionDetails,
  PythonSessionManagerHooks,
  SandboxManager,
  ScriptExportResult,
  SessionExecOptions,
  SessionSummary,
  SubagentRuntimeSnapshot,
} from "./contracts/execution-types";
import type { PtcSettings } from "./contracts/settings";
import type { ToolUpdateCallback } from "./contracts/tool-types";
import type { ToolRegistry } from "./tool-registry";
import { generateToolWrappers } from "./tools/tool-wrapper";
import {
  appendPythonErrorHelp,
  debugLog,
  estimateTokensFromChars,
  sliceCellOutput,
  validateUserCode,
} from "./utils";

export type {
  PythonSessionManagerHooks,
  ScriptExportResult,
  SessionExecOptions,
  SessionSummary,
} from "./contracts/execution-types";

export class PythonSessionError extends Error {}

/** A sourcing (provision-time prefix-cell) failure, recorded against the copied cell. */
export interface SourceExecutionError {
  cellIdx: number;
  message: string;
  traceback?: string;
}

/** Result of copying a session notebook into the reusable PTC library. */
export interface SkillNotebookPromotionResult {
  name: string;
  path: string;
  notebookPath: string;
  overwritten: boolean;
}

/** Thrown when an operation names a session id that is not live; the message lists live ids. */
export class UnknownSessionError extends PythonSessionError {
  constructor(public requestedId: string, availableIds: string[]) {
    super(
      `Unknown python session: ${requestedId}. Live sessions: ${
        availableIds.length ? availableIds.join(", ") : "(none)"
      }`
    );
  }
}

type RunTool = (toolName: string, params: unknown, nestedCallId: string) => Promise<unknown>;

// ---------------------------------------------------------------------------
// Persistent protocol: per-exec request/response against a long-lived interpreter.
// ---------------------------------------------------------------------------

interface PersistentProtocolOptions {
  terminateProcess: (signal: NodeJS.Signals) => boolean;
  /** Send a signal to the interpreter (SIGINT mirrors Ctrl-C). */
  sendSignal: (signal: NodeJS.Signals) => void;
  onSubagentSnapshot?: (execId: string, snapshot: SubagentRuntimeSnapshot) => void;
  /**
   * Fired when an interrupted chunk settles after the tool call was already
   * aborted by pi: pi rejects the call with its own AbortError immediately (it
   * races the abort signal), so the Python stack has to reach the model as a
   * queued message instead of a tool result.
   */
  onInterruptedReport?: (text: string) => void;
}

/** How long to wait for the interrupted chunk to report back before forcing it. */
const INTERRUPT_GRACE_MS = 5_000;

type InterruptKind = "abort" | "timeout";

/**
 * One long-lived interpreter subprocess speaking the persistent NDJSON
 * protocol (exec / tool_call / exec_done frames). Tracks per-exec state,
 * serializes one exec at a time, routes nested tool calls, and applies
 * Ctrl-C-style interrupts with a forced-kill fallback.
 */
class PersistentSessionProtocol {
  private stdout = "";
  private stderr = "";
  private stderrCharsSeen = 0;
  private currentLine?: number;
  private totalLines?: number;
  private activeTool?: string;
  private chunkLines: string[] = [];
  private execId = "";
  private execStartedAt = Date.now();
  private notebookPath: string | undefined = undefined;
  private cellFile: string | undefined = undefined;
  private sourceCellIndex: number | undefined = undefined;
  private initialCellCount: number | undefined = undefined;
  // Final subagent snapshot of the running exec; stamped onto exec_done so the
  // completed tool render keeps the subagent panel (live updates carry it, the
  // final frame used to drop it).
  private lastSubagentSnapshot?: SubagentRuntimeSnapshot;
  private execResolve?: (result: CodeExecutionResult) => void;
  private execReject?: (error: Error) => void;
  private execTimeout?: NodeJS.Timeout;
  private updateHandler?: ToolUpdateCallback;
  private execTimeoutMs?: number;
  private nestedToolCalls = 0;
  private nestedToolNames: string[] = [];
  // Per-call records for the model/user-facing tool subtree (name, one-line
  // target summary, outcome). Reset at the start of each exec.
  private nestedCallRecords: Array<{ name: string; target?: string; ok: boolean; ms: number }> = [];
  private nestedResultChars = 0;
  private nestedResultCount = 0;
  private nestedErrors = 0;
  private readonly reader: readline.Interface;
  private readyResolve?: () => void;
  private readyReject?: (error: Error) => void;
  private scriptExportId = "";
  private scriptExportResolve?: (result: ScriptExportResult) => void;
  private inspectId = "";
  private inspectResolve?: (digest: KernelDigest) => void;
  private inspectReject?: (error: Error) => void;
  private scriptExportReject?: (error: Error) => void;
  private pendingInterrupt?: { kind: InterruptKind; message: string };
  private interruptGraceTimer?: NodeJS.Timeout;

  constructor(
    private proc: ChildProcess,
    private runTool: RunTool,
    private options: PersistentProtocolOptions
  ) {
    if (!proc.stdout) {
      throw new PtcProtocolError("Session interpreter did not expose stdout.");
    }
    this.reader = readline.createInterface({ input: proc.stdout, crlfDelay: Infinity });
    this.reader.on("line", (line) => {
      void this.handleLine(line).catch(() => undefined);
    });
    proc.stderr?.on("data", (data: { toString(): string }) => {
      const text = data.toString();
      this.stderrCharsSeen += text.length;
      if (this.stderr.length < 64_000) {
        this.stderr += text.slice(0, 64_000 - this.stderr.length);
      }
    });
    proc.once("exit", () => {
      this.failAllPending(
        new PtcProtocolError(`python session interpreter exited before finishing exec ${this.execId}.${this.stderrTail()}`)
      );
    });
    proc.once("error", (error) => {
      this.failAllPending(
        new PtcProtocolError(`python session interpreter failed: ${error.message}.${this.stderrTail()}`)
      );
    });
  }

  /** Resolves on the first session_ready frame; rejects if the process dies first. */
  waitReady(timeoutMs: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.readyReject = undefined;
        this.readyResolve = undefined;
        reject(new PythonSessionError(`python session did not become ready within ${timeoutMs}ms${this.stderrTail()}`));
      }, timeoutMs);
      timeout.unref?.();
      const exitCheck = setInterval(() => {
        if (this.proc.exitCode !== null || this.proc.signalCode !== null) {
          clearInterval(exitCheck);
          clearTimeout(timeout);
          this.readyResolve = undefined;
          this.readyReject = undefined;
          reject(new PythonSessionError(`python session exited during startup${this.stderrTail()}`));
        }
      }, 200);
      exitCheck.unref?.();
      this.readyResolve = () => {
        clearInterval(exitCheck);
        clearTimeout(timeout);
        resolve();
      };
      this.readyReject = (error: Error) => {
        clearInterval(exitCheck);
        clearTimeout(timeout);
        reject(error);
      };
    });
  }

  private resolveReady(): void {
    const resolve = this.readyResolve;
    this.readyResolve = undefined;
    this.readyReject = undefined;
    resolve?.();
  }

  private failAllPending(error: Error): void {
    const rejectReady = this.readyReject;
    const rejectExec = this.execReject;
    const rejectInspect = this.inspectReject;
    const rejectExport = this.scriptExportReject;

    this.readyResolve = undefined;
    this.readyReject = undefined;
    this.execResolve = undefined;
    this.execReject = undefined;
    this.inspectId = "";
    this.inspectResolve = undefined;
    this.inspectReject = undefined;
    this.scriptExportId = "";
    this.scriptExportResolve = undefined;
    this.scriptExportReject = undefined;
    this.clearExecTimeout();
    if (this.interruptGraceTimer) {
      clearTimeout(this.interruptGraceTimer);
      this.interruptGraceTimer = undefined;
    }
    this.pendingInterrupt = undefined;

    rejectReady?.(error);
    rejectExec?.(error);
    rejectInspect?.(error);
    rejectExport?.(error);
  }

  private buildDetails(overrides?: Partial<ExecutionDetails>): ExecutionDetails {
    return {
      execId: this.execId,
      nestedToolCalls: this.nestedToolCalls,
      nestedToolNames: [...this.nestedToolNames],
      nestedCallRecords: [...this.nestedCallRecords],
      nestedResultChars: this.nestedResultChars,
      nestedResultCount: this.nestedResultCount,
      nestedErrors: this.nestedErrors,
      durationMs: Date.now() - this.execStartedAt,
      estimatedAvoidedTokens: estimateTokensFromChars(this.nestedResultChars),
      currentLine: this.currentLine,
      totalLines: this.totalLines,
      userCode: this.chunkLines,
      activeTool: this.activeTool,
      ...overrides,
    };
  }

  private finish(result: CodeExecutionResult | Error): void {
    const resolve = this.execResolve;
    const reject = this.execReject;
    this.execResolve = undefined;
    this.execReject = undefined;
    this.clearExecTimeout();
    if (this.interruptGraceTimer) {
      clearTimeout(this.interruptGraceTimer);
      this.interruptGraceTimer = undefined;
    }
    this.pendingInterrupt = undefined;
    if (!resolve || !reject) {
      return; // already finished or superseded
    }
    if (result instanceof Error) {
      reject(result);
    } else {
      resolve(result);
    }
  }

  private async handleLine(line: string): Promise<void> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (error) {
      debugLog(`[ptc-session] unparseable frame: ${error}`);
      return;
    }
    if (!parsed || typeof parsed !== "object") {
      return;
    }
    const msg = parsed as Record<string, unknown> & { type?: string };

    // Any frame from the interpreter proves it is alive; push the idle window out.
    this.armExecTimeout();

    switch (msg.type) {
      case "session_ready":
        this.resolveReady();
        return;

      case "tool_call": {
        const tool = msg.tool as string;
        const callId = msg.id as string;
        this.nestedToolCalls += 1;
        this.nestedToolNames.push(tool);
        this.activeTool = tool;
        const callStartedAt = Date.now();
        this.emitUpdate();
        try {
          const result = await this.runTool(tool, msg.params, callId);
          const normalized = normalizeToolResult(
            tool,
            result as { content?: Array<Record<string, unknown>>; details?: unknown }
          );
          this.nestedResultChars += normalized.estimatedChars;
          this.nestedResultCount += 1;
          this.nestedCallRecords.push({
            name: tool,
            target: summarizeToolTarget(msg.params),
            ok: true,
            ms: Date.now() - callStartedAt,
          });
          this.send({ type: "tool_result", id: callId, value: normalized.value });
        } catch (error) {
          this.nestedErrors += 1;
          this.nestedCallRecords.push({
            name: tool,
            target: summarizeToolTarget(msg.params),
            ok: false,
            ms: Date.now() - callStartedAt,
          });
          this.send({
            type: "tool_result",
            id: callId,
            error: {
              type: error instanceof Error ? error.name : "Error",
              message: error instanceof Error ? error.message : String(error),
            },
          });
        } finally {
          this.activeTool = undefined;
        }
        return;
      }

      case "execution_progress":
        this.currentLine = msg.line as number;
        this.totalLines = msg.total_lines as number;
        this.emitUpdate();
        return;

      case "stdout":
        this.appendStdout(msg.text as string);
        return;

      case "exec_done": {
        if (msg.id !== this.execId) {
          // A frame from a superseded exec must never resolve the current one.
          return;
        }
        const finalOutput = msg.output as string;
        const cellIdx = typeof msg.cell === "number" && Number.isInteger(msg.cell) && msg.cell > 0
          ? msg.cell
          : undefined;
        const echo = typeof msg.echo === "string" ? msg.echo : undefined;
        const kernelText = typeof msg.kernel_text === "string" ? msg.kernel_text : undefined;
        const subagentsText = typeof msg.subagents_text === "string" ? msg.subagents_text : undefined;
        const toolsText = typeof msg.tools_text === "string" ? msg.tools_text : undefined;
        const sectioned = echo !== undefined || kernelText !== undefined || subagentsText !== undefined || toolsText !== undefined;
        this.finish({
          output: this.buildFinalOutput(finalOutput, {
            echo,
            kernelText,
            subagentsText,
            toolsText,
            cellIdx,
          }),
          images: (msg.images as never[] | undefined) ?? undefined,
          details: this.buildDetails({
            execId: this.execId,
            cellIdx,
            sectioned,
            subagentSnapshot: this.lastSubagentSnapshot,
          }),
        });
        return;
      }

      case "exec_error": {
        if (msg.id !== this.execId) {
          return; // stale frame from a torn-down exec
        }
        const rawMessage = msg.message as string;
        const traceback = msg.traceback as string | undefined;
        const interrupt = this.pendingInterrupt;
        if (interrupt) {
          // The chunk reported back after our SIGINT: surface the interrupt with
          // the Python stack so the caller can see where it stopped.
          this.pendingInterrupt = undefined;
          const line = typeof msg.line === "number" ? msg.line : undefined;
          const source = typeof msg.source === "string" && msg.source ? msg.source : undefined;
          const error = this.buildInterruptError(interrupt, rawMessage, traceback, line, source);
          this.finish(error);
          if (interrupt.kind === "abort") {
            this.options.onInterruptedReport?.(error.message);
          }
          return;
        }
        this.finish(new PtcPythonError(rawMessage, appendPythonErrorHelp(traceback, rawMessage)));
        return;
      }

      case "subagent_state": {
        this.lastSubagentSnapshot = msg.snapshot as SubagentRuntimeSnapshot;
        this.options.onSubagentSnapshot?.(this.execId, msg.snapshot as SubagentRuntimeSnapshot);
        this.emitUpdate({ subagentSnapshot: msg.snapshot as SubagentRuntimeSnapshot });
        return;
      }

      case "kernel_inspected": {
        if (msg.id !== this.inspectId) {
          return; // stale frame
        }
        const resolveInspect = this.inspectResolve;
        this.inspectResolve = undefined;
        this.inspectReject = undefined;
        this.inspectId = "";
        resolveInspect?.(msg.digest as KernelDigest);
        return;
      }

      case "script_exported": {
        if (msg.id !== this.scriptExportId) {
          return; // stale frame
        }
        const resolve = this.scriptExportResolve;
        const reject = this.scriptExportReject;
        this.scriptExportResolve = undefined;
        this.scriptExportReject = undefined;
        this.scriptExportId = "";
        if (msg.error) {
          reject?.(new PythonSessionError(msg.error as string));
        } else {
          resolve?.({ path: msg.path as string, cells: msg.cells as number, wrappedAsync: msg.wrapped_async === true });
        }        return;
      }

      default:
        return;
    }
  }

  /**
   * Route partial updates to the active tool call. The update handler is set per
   * exec (not at construction) because the tool call that streams the renders is
   * only known when the caller invokes exec_cell.
   */
  setUpdateHandler(handler: ToolUpdateCallback | undefined): void {
    this.updateHandler = handler;
  }

  /**
   * Idle-timeout handling. `executionTimeoutMs` is shared with ordinary execution,
   * but for a persistent session it measures *silence*, not total runtime: every
   * frame the interpreter emits (progress, stdout, nested tool calls, and in
   * particular subagent activity updates) re-arms the timer. A long fan-out is
   * therefore limited only by how long no agent reports anything at all.
   */
  private clearExecTimeout(): void {
    if (this.execTimeout) {
      clearTimeout(this.execTimeout);
      this.execTimeout = undefined;
    }
  }

  private armExecTimeout(): void {
    if (this.execTimeoutMs === undefined || !this.execResolve) {
      return; // no exec in flight (or timeouts disabled)
    }
    this.clearExecTimeout();
    const windowMs = this.execTimeoutMs;
    this.execTimeout = setTimeout(() => {
      this.execTimeout = undefined;
      // Interrupt the chunk instead of killing the session: the caller gets the
      // Python stack where it was stuck, and the session stays interactive.
      this.interrupt(
        "timeout",
        `Python session idle for ${Math.round(windowMs / 1000)} seconds with no activity ` +
          "(no progress, output, or subagent updates)"
      );
    }, windowMs);
    this.execTimeout.unref?.();
  }

  /**
   * Stop the running chunk the way Ctrl-C would: SIGINT into the interpreter,
   * which surfaces as KeyboardInterrupt/CancelledError inside the chunk. The
   * process and its namespace survive, so the caller can inspect state and retry.
   */
  interrupt(kind: InterruptKind, message: string): void {
    if (!this.execResolve) {
      return; // nothing running
    }
    this.pendingInterrupt = { kind, message };
    this.clearExecTimeout();
    this.options.sendSignal("SIGINT");

    // If the chunk cannot be interrupted (stuck in an uninterruptible native
    // call), force the process down rather than leaving the call hanging.
    if (this.interruptGraceTimer) {
      clearTimeout(this.interruptGraceTimer);
    }
    this.interruptGraceTimer = setTimeout(() => {
      this.interruptGraceTimer = undefined;
      const interrupt = this.pendingInterrupt;
      if (!interrupt || !this.execResolve) {
        return;
      }
      this.pendingInterrupt = undefined;
      this.options.terminateProcess("SIGKILL");
      const error = this.buildInterruptError(interrupt, "interpreter did not respond to the interrupt", undefined);
      this.finish(error);
      if (interrupt.kind === "abort") {
        this.options.onInterruptedReport?.(error.message);
      }
    }, INTERRUPT_GRACE_MS);
    this.interruptGraceTimer.unref?.();
  }

  private buildInterruptError(
    interrupt: { kind: InterruptKind; message: string },
    pythonMessage: string,
    traceback: string | undefined,
    line?: number,
    source?: string
  ): Error {
    const where = line
      ? `  chunk line ${line}${source ? `: ${source}` : ""}`
      : undefined;
    const stack = traceback ? `\n\nPython traceback:\n${traceback.trimEnd()}` : "";
    const text =
      (interrupt.kind === "timeout"
        ? `${interrupt.message}; the running chunk was interrupted (the session is still alive).`
        : "Execution aborted (Ctrl-C); the running chunk was interrupted (the session is still alive).") +
      (where ? `\nStopped at:\n${where}` : "") +
      `\nPython said: ${pythonMessage}` +
      stack;
    return interrupt.kind === "timeout" ? new PtcTimeoutError(text) : new PtcAbortError(text);
  }

  private emitUpdate(extra?: Partial<ExecutionDetails>): void {
    this.updateHandler?.({
      content: [{ type: "text", text: this.describeProgress() }],
      details: this.buildDetails(extra),
    });
  }

  private describeProgress(): string {
    if (this.activeTool) {
      return `Calling ${this.activeTool}()`;
    }
    if (this.currentLine !== undefined && this.totalLines) {
      return `Executing line ${this.currentLine}/${this.totalLines}`;
    }
    return "Executing";
  }

  /**
   * Compose the model-visible result. New-format runtimes send the segments
   * separately (`echo`, `kernel_text`, `subagents_text`); the host owns the
   * structure: markers at column 0, every cell-produced line indented two
   * spaces, so provenance is positional rather than prefix-trust. A runtime
   * without the structured fields (stale interpreter) falls back to the legacy
   * stdout+text concatenation.
   */
  private buildFinalOutput(
    finalText: string,
    sections?: { echo?: string; kernelText?: string; subagentsText?: string; toolsText?: string; cellIdx?: number }
  ): string {
    if (!sections || (sections.echo === undefined && sections.kernelText === undefined && sections.subagentsText === undefined && sections.toolsText === undefined)) {
      return this.stdout ? `${this.stdout}${finalText}`.trim() : finalText;
    }
    const parts: string[] = [];
    if (this.stdout.trim()) parts.push(sectionize("output", this.stdout));
    // The value segment replicates the legacy composition (result text, then
    // the Out[n] echo) under one section; the header carries the Out[n] label.
    const valueParts: string[] = [];
    if (finalText.trim()) valueParts.push(finalText);
    if (sections.echo !== undefined) {
      valueParts.push(sections.cellIdx !== undefined ? `Out[${sections.cellIdx}]: ${sections.echo}` : `Out[?]: ${sections.echo}`);
    }
    if (valueParts.length > 0) {
      const name = sections.cellIdx !== undefined ? `return (Out[${sections.cellIdx}])` : "return";
      parts.push(sectionize(name, valueParts.join("\n\n")));
    }
    if (sections.kernelText?.trim()) parts.push(sectionize("kernel", sections.kernelText));
    if (sections.subagentsText?.trim()) parts.push(sectionize("subagents", sections.subagentsText));
      if (sections.toolsText?.trim()) parts.push(sectionize("tools", sections.toolsText));
    if (parts.length === 0) return finalText;
    return parts.join("\n");
  }

  private appendStdout(text: string): void {
    // Python owns the emergency spool ceiling. Retain the complete framed text
    // here; model-facing collapsing happens once, in exec_cell.
    if (text) this.stdout += text;
  }

  private send(msg: Record<string, unknown>): void {
    if (!this.proc.stdin || this.proc.stdin.destroyed || this.proc.stdin.writableEnded) {
      throw new PtcProtocolError("Session interpreter stdin closed before a frame could be delivered.");
    }
    this.proc.stdin.write(`${JSON.stringify(msg)}\n`);
  }

  private stderrTail(): string {
    const tail = this.stderr.trim();
    return tail ? ` stderr: ${tail.slice(-2_000)}` : "";
  }

  /**
   * Reject the exec that is currently in flight (used when a queued exec is
   * discarded before it starts).
   */
  rejectInFlight(error: Error): void {
    this.finish(error);
  }

  /** Run one chunk. The caller serializes (one exec at a time). */
  async exec(code: string, timeoutMs: number | undefined): Promise<CodeExecutionResult> {
    if (this.execResolve) {
      // Serialization is the manager's job; this is defense in depth so two
      // overlapping execs can never clobber each other's promise state.
      throw new PtcProtocolError(
        "python kernel is busy: another cell is already executing (exec_cell calls are serialized per kernel)"
      );
    }
    this.execId = `exec_${randomUUID().replace(/-/g, "").slice(0, 10)}`;
    this.execStartedAt = Date.now();
    this.chunkLines = code.split("\n");
    this.stdout = "";
    this.currentLine = undefined;
    this.totalLines = undefined;
    this.activeTool = undefined;
    this.lastSubagentSnapshot = undefined;
    this.nestedCallRecords = [];

    const sourcePath = this.cellFile;
    const sourceCellIndex = this.sourceCellIndex;
    const initialCellCount = this.initialCellCount;
    this.cellFile = undefined;
    this.sourceCellIndex = undefined;
    this.initialCellCount = undefined;
    this.send({
      type: "exec",
      id: this.execId,
      code,
      user_code_line_count: this.chunkLines.length,
      notebook: this.notebookPath,
      source_path: sourcePath,
      source_cell_index: sourceCellIndex,
      initial_cell_count: initialCellCount,
    });

    // Do not arm protocol state until send succeeds. A closed/broken stdin must
    // fail this call without leaving the session permanently "busy".
    const promise = new Promise<CodeExecutionResult>((resolve, reject) => {
      this.execResolve = resolve;
      this.execReject = reject;
    });
    this.execTimeoutMs = timeoutMs;
    this.armExecTimeout();
    return promise;
  }

  /** The id of the exec currently in flight, or null when idle. */
  currentExecId(): string | null {
    return this.execResolve ? this.execId : null;
  }

  /** Ask the interpreter to write the cumulative cells to disk (AST-aware). */
  async exportScript(cells: string[], targetPath: string, timeoutMs: number | undefined): Promise<ScriptExportResult> {
    const exportId = `export_${randomUUID().replace(/-/g, "").slice(0, 10)}`;
    this.send({ type: "export_script", id: exportId, path: targetPath, cells });

    this.scriptExportId = exportId;
    const promise = new Promise<ScriptExportResult>((resolve, reject) => {
      this.scriptExportResolve = resolve;
      this.scriptExportReject = reject;
    });

    let timeout: NodeJS.Timeout | undefined;
    if (timeoutMs !== undefined) {
      timeout = setTimeout(() => {
        if (this.scriptExportId !== exportId) {
          return;
        }
        const reject = this.scriptExportReject;
        this.scriptExportId = "";
        this.scriptExportResolve = undefined;
        this.scriptExportReject = undefined;
        reject?.(new Error(`Script export timed out after ${Math.round(timeoutMs / 1000)} seconds`));
      }, timeoutMs);
      timeout.unref?.();
    }
    void promise.then(
      () => timeout && clearTimeout(timeout),
      () => timeout && clearTimeout(timeout)
    );
    return promise;
  }

  /** Ask the interpreter for a structured snapshot of the user namespace. */
  async inspectKernel(timeoutMs: number | undefined): Promise<KernelDigest> {
    if (this.execResolve) {
      throw new PythonSessionError("kernel is busy executing a cell; inspect after it finishes");
    }
    const inspectId = `inspect_${randomUUID().replace(/-/g, "").slice(0, 10)}`;
    this.send({ type: "inspect", id: inspectId });

    this.inspectId = inspectId;
    const promise = new Promise<KernelDigest>((resolve, reject) => {
      this.inspectResolve = resolve;
      this.inspectReject = reject;
    });
    let timeout: NodeJS.Timeout | undefined;
    if (timeoutMs !== undefined) {
      timeout = setTimeout(() => {
        if (this.inspectId !== inspectId) {
          return;
        }
        const reject = this.inspectReject;
        this.inspectId = "";
        this.inspectResolve = undefined;
        this.inspectReject = undefined;
        reject?.(new Error(`kernel inspect timed out after ${Math.round(timeoutMs / 1000)} seconds`));
      }, timeoutMs);
      timeout.unref?.();
    }
    void promise.then(
      () => timeout && clearTimeout(timeout),
      () => timeout && clearTimeout(timeout)
    );
    return promise;
  }

  setNotebookPath(notebookPath: string | undefined): void {
    this.notebookPath = notebookPath;
  }

  setCellFile(cellFile: string | undefined): void {
    this.cellFile = cellFile;
  }

  setSourceCellIndex(sourceCellIndex: number | undefined): void {
    this.sourceCellIndex = sourceCellIndex;
  }

  setInitialCellCount(initialCellCount: number | undefined): void {
    this.initialCellCount = initialCellCount;
  }

  /**
   * End the protocol: close stdin (so the interpreter's reader sees EOF) and
   * stop consuming stdout. Does not kill the process — termination is the
   * manager's terminateSession job.
   */
  async dispose(): Promise<void> {
    this.clearExecTimeout();
    try {
      this.proc.stdin?.end();
    } catch {
      // best-effort
    }
    this.reader.close();
  }
}

// ---------------------------------------------------------------------------
// Session manager
// ---------------------------------------------------------------------------

interface SessionSpawnOptions {
  code: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
}

interface NotebookCell extends Record<string, unknown> {
  cell_type?: string;
  source?: unknown;
}

interface PreparedSource {
  path: string;
  kind: "notebook" | "python";
  cells: NotebookCell[];
  pythonCode?: string;
  prefixCellCount: number;
}

function notebookText(value: unknown): string {
  if (Array.isArray(value)) return value.map((part) => String(part)).join("");
  return typeof value === "string" ? value : "";
}

function parseNotebookDocument(text: string, sourcePath: string): { document: Record<string, unknown>; cells: NotebookCell[] } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch (error) {
    throw new PythonSessionError(
      `could not parse source notebook ${sourcePath}: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new PythonSessionError(`source notebook ${sourcePath} is not a JSON object`);
  }
  const document = parsed as Record<string, unknown>;
  if (!Array.isArray(document.cells)) {
    throw new PythonSessionError(`source notebook ${sourcePath} has no cells array`);
  }
  const cells = document.cells.map((cell, index) => {
    if (!cell || typeof cell !== "object" || Array.isArray(cell)) {
      throw new PythonSessionError(`source notebook ${sourcePath} has an invalid cell at position ${index + 1}`);
    }
    return cell as NotebookCell;
  });
  return { document, cells };
}

function emptyNotebookDocument(): string {
  return `${JSON.stringify({
    cells: [],
    metadata: {
      kernelspec: { display_name: "Python 3 (ptc kernel)", language: "python", name: "python3" },
      language_info: { name: "python" },
    },
    nbformat: 4,
    nbformat_minor: 5,
  }, null, 1)}\n`;
}

function sanitizeSkillNotebookName(name: string): string {
  const withoutExtension = name.trim().replace(/\.ipynb$/i, "");
  const sanitized = withoutExtension
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!sanitized) {
    throw new PythonSessionError("promotion name must contain at least one letter or number");
  }
  return sanitized;
}

function extractNotebookCellOutput(cell: Record<string, unknown>): string {
  const metadata = cell.metadata;
  if (metadata && typeof metadata === "object" && !Array.isArray(metadata)) {
    const fullOutput = (metadata as Record<string, unknown>).ptc_full_output;
    if (typeof fullOutput === "string") return fullOutput;
  }

  const outputs = Array.isArray(cell.outputs) ? cell.outputs : [];
  const parts: string[] = [];
  for (const rawOutput of outputs) {
    if (!rawOutput || typeof rawOutput !== "object" || Array.isArray(rawOutput)) continue;
    const output = rawOutput as Record<string, unknown>;
    if (output.output_type === "stream") {
      parts.push(notebookText(output.text));
    } else if (output.output_type === "execute_result") {
      const data = output.data;
      const text = data && typeof data === "object" && !Array.isArray(data)
        ? notebookText((data as Record<string, unknown>)["text/plain"])
        : "";
      const count = typeof output.execution_count === "number" ? output.execution_count : cell.execution_count;
      parts.push(`Out[${String(count)}]: ${text}`);
    } else if (output.output_type === "error") {
      const traceback = notebookText(output.traceback);
      parts.push(traceback || `${String(output.ename ?? "Error")}: ${String(output.evalue ?? "")}`);
    }
  }
  return parts.join(parts.length > 1 ? "\n\n" : "");
}

/**
 * One-line identifying summary of a bridged tool call's primary parameter
 * (path, pattern, command, ...) for the tool subtree renderer.
 */
function summarizeToolTarget(params: unknown): string | undefined {
  try {
    if (!params || typeof params !== "object") return undefined;
    const record = params as Record<string, unknown>;
    const preferred = ["path", "file_path", "pattern", "command", "notebook", "name", "query"];
    for (const key of preferred) {
      const value = record[key];
      if (typeof value === "string" && value.trim()) return truncateTarget(value.trim());
    }
    for (const value of Object.values(record)) {
      if (typeof value === "string" && value.trim()) return truncateTarget(value.trim());
    }
    return undefined;
  } catch {
    return undefined;
  }
}

function truncateTarget(value: string): string {
  return value.length > 48 ? `${value.slice(0, 47)}...` : value;
}

interface SessionRecord {
  id: string;
  notebookPath?: string;
  proc: ChildProcess;
  protocol: PersistentSessionProtocol;
  chunks: string[];
  createdAt: number;
  lastUsedAt: number;
  killed: boolean;
  /** Serializes the python-side exec loop: one chunk runs at a time. */
  queue: Promise<void>;
  /** Foreground jobs accepted but not yet settled (queued-call detection). */
  pendingJobs: number;
  latestSnapshot: SubagentRuntimeSnapshot | null;
  /** Total copied prefix cells, including markdown. */
  prefixCellCount: number;
  /** Number of source code chunks attempted during provisioning. */
  prefixChunkCount: number;
  sourcedFrom?: string;
}

/**
 * Owns the set of live persistent Python kernels: provisioning (optionally
 * sourcing a notebook/script), serialized foreground exec, notebook-backed
 * cell output reads, script export/promotion, subagent snapshot fan-out, and
 * lifecycle (interrupt/kill/dispose).
 */
export class PythonSessionManager {
  private sessions = new Map<string, SessionRecord>();
  private recency: string[] = [];
  /** Set after the first provision() has waited (once) for venv provisioning. */
  private envGateSettled = false;

  constructor(
    private sandboxManager: SandboxManager,
    private toolRegistry: ToolRegistry,
    private settings: PtcSettings,
    private extensionRoot: string,
    private hooks: PythonSessionManagerHooks = {}
  ) {}

  /**
   * Live sessions sorted most-recently-used first. `chunks` counts user-visible
   * cells: copied prefix cells plus user-executed chunks (provisioning retry
   * chunks excluded).
   */
  list(): SessionSummary[] {
    return [...this.sessions.values()]
      .sort((a, b) => this.recencyIndex(b.id) - this.recencyIndex(a.id))
      .map((session) => ({
        id: session.id,
        createdAt: session.createdAt,
        lastUsedAt: session.lastUsedAt,
        chunks: session.prefixCellCount + Math.max(0, session.chunks.length - session.prefixChunkCount),
        running: Boolean(session.protocol.currentExecId()),
        notebookPath: session.notebookPath,
      }));
  }

  private recencyIndex(id: string): number {
    const index = this.recency.indexOf(id);
    return index === -1 ? -1 : index;
  }

  /** Whether a session id is live. */
  get(id: string): boolean {
    return this.sessions.has(id);
  }

  /** Latest subagent snapshot recorded for one session, or null. */
  getSubagentSnapshot(sessionId: string): SubagentRuntimeSnapshot | null {
    return this.sessions.get(sessionId)?.latestSnapshot ?? null;
  }

  /** Most recent non-null subagent snapshot across all sessions (MRU order). */
  latestSubagentSnapshot(): SubagentRuntimeSnapshot | null {
    for (let index = this.recency.length - 1; index >= 0; index--) {
      const snapshot = this.sessions.get(this.recency[index])?.latestSnapshot;
      if (snapshot) {
        return snapshot;
      }
    }
    return null;
  }

  /** Structured snapshot of a kernel's user-created namespace. */
  async inspectKernel(
    sessionId: string,
    options: { timeoutMs?: number } = {}
  ): Promise<KernelDigest> {
    const record = this.require(sessionId);
    return record.protocol.inspectKernel(options.timeoutMs);
  }

  /** Read a 1-based cell output from a kernel's notebook (default: most recently used). */
  async readCellOutput(
    cellIdx: number,
    options: { kernel?: string; offset?: number; limit?: number } = {}
  ): Promise<{ text: string; notebookPath: string; cellIdx: number }> {
    if (!Number.isInteger(cellIdx) || cellIdx < 1) {
      throw new PythonSessionError("cellIdx must be a positive 1-based integer");
    }
    let record: SessionRecord | undefined;
    if (options.kernel) {
      record = this.sessions.get(options.kernel);
      if (!record) {
        const live = this.list().map((s) => s.id).join(", ") || "(none)";
        throw new PythonSessionError(`unknown kernel ${options.kernel} (live kernels: ${live})`);
      }
    } else {
      // Default: the most recently used notebook-backed kernel.
      record = [...this.sessions.values()]
        .filter((session) => !session.killed && session.notebookPath)
        .sort((a, b) => b.lastUsedAt - a.lastUsedAt)[0];
    }
    if (!record?.notebookPath) {
      throw new PythonSessionError("no notebook-backed kernel is available");
    }

    let document: unknown;
    try {
      document = JSON.parse(await fs.promises.readFile(record.notebookPath, "utf8")) as unknown;
    } catch (error) {
      throw new PythonSessionError(
        `could not read notebook ${record.notebookPath}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
    if (!document || typeof document !== "object" || !Array.isArray((document as { cells?: unknown }).cells)) {
      throw new PythonSessionError(`notebook ${record.notebookPath} has no valid cells array`);
    }
    const cells = (document as { cells: unknown[] }).cells.filter(
      (cell): cell is Record<string, unknown> => Boolean(cell) && typeof cell === "object" && !Array.isArray(cell)
    );
    const cell = cells.find((candidate) => candidate.execution_count === cellIdx);
    if (!cell) {
      throw new PythonSessionError(
        `cell ${cellIdx} is not present in ${record.notebookPath} (${cells.length} cells recorded)`
      );
    }
    const fullOutput = extractNotebookCellOutput(cell);
    return {
      text: sliceCellOutput(fullOutput, { cellIdx, ...options }),
      notebookPath: record.notebookPath,
      cellIdx,
    };
  }

  /** All subagent snapshots across sessions (sessions may each have their own). */
  allSubagentSnapshots(): Array<{ sessionId: string; snapshot: SubagentRuntimeSnapshot }> {
    const result: Array<{ sessionId: string; snapshot: SubagentRuntimeSnapshot }> = [];
    for (const id of this.recency) {
      const snapshot = this.sessions.get(id)?.latestSnapshot;
      if (snapshot) {
        result.push({ sessionId: id, snapshot });
      }
    }
    return result;
  }

  /**
   * Resolve the PTC notebook library directory: settings.libraryDir, then
   * PTC_LIBRARY_DIR (both `~/`-expanded), then `<pi agent dir>/ptc-library`.
   */
  resolveLibraryDir(): string {
    const configured = this.settings.libraryDir?.trim() || process.env.PTC_LIBRARY_DIR?.trim();
    if (configured) {
      const expanded = configured === "~" || configured.startsWith(`~${path.sep}`)
        ? path.join(homedir(), configured.slice(2))
        : configured;
      return path.resolve(expanded);
    }
    const agentDir = process.env.PI_CODING_AGENT_DIR?.trim() || path.join(homedir(), ".config", "pi");
    return path.resolve(agentDir, "ptc-library");
  }

  private resolveSourcePath(source: string, cwd: string): string {
    const requested = source.trim();
    if (!requested) {
      throw new PythonSessionError("source must not be empty");
    }

    if (path.isAbsolute(requested)) {
      return requested;
    }

    const isBareName = path.basename(requested) === requested;
    if (isBareName) {
      const libraryDir = this.resolveLibraryDir();
      const extension = path.extname(requested).toLowerCase();
      const candidates = extension
        ? [path.join(libraryDir, requested)]
        : [path.join(libraryDir, `${requested}.ipynb`), path.join(libraryDir, `${requested}.py`)];
      const libraryMatch = candidates.find((candidate) => fs.existsSync(candidate));
      if (libraryMatch) return libraryMatch;
    }

    return path.resolve(cwd, requested);
  }

  private async prepareSource(
    source: string | undefined,
    cwd: string,
    notebookPath: string | undefined
  ): Promise<PreparedSource | undefined> {
    if (!source) return undefined;
    if (!notebookPath) {
      throw new PythonSessionError("provisioning from source requires a destination notebookPath");
    }

    const sourcePath = this.resolveSourcePath(source, cwd);
    const extension = path.extname(sourcePath).toLowerCase();
    if (extension !== ".ipynb" && extension !== ".py") {
      throw new PythonSessionError(`source must be a .ipynb or .py file: ${sourcePath}`);
    }

    let sourceText: string;
    try {
      sourceText = await fs.promises.readFile(sourcePath, "utf8");
    } catch (error) {
      throw new PythonSessionError(
        `could not read source ${sourcePath}: ${error instanceof Error ? error.message : String(error)}`
      );
    }

    const destination = path.resolve(cwd, notebookPath);
    if (path.resolve(sourcePath) === destination) {
      throw new PythonSessionError("source and destination notebook must be different files; the source is never modified");
    }
    await fs.promises.mkdir(path.dirname(destination), { recursive: true });

    if (extension === ".ipynb") {
      const { cells } = parseNotebookDocument(sourceText, sourcePath);
      await fs.promises.copyFile(sourcePath, destination);
      return { path: sourcePath, kind: "notebook", cells, prefixCellCount: cells.length };
    }

    await fs.promises.writeFile(destination, emptyNotebookDocument(), "utf8");
    return {
      path: sourcePath,
      kind: "python",
      cells: [],
      pythonCode: sourceText,
      prefixCellCount: 1,
    };
  }

  private spawnSession(code: string, cwd: string): ChildProcess {
    const env: NodeJS.ProcessEnv = { ...process.env };
    if (this.settings.subagentsProfile) {
      env.PI_SUBAGENTS_PROFILE = this.settings.subagentsProfile;
    }

    // The current sandbox API takes one options object. Keep a compatibility
    // path for older SandboxManager implementations while the contract migration
    // lands; their synchronous spawn captures the scoped value before restore.
    if (this.sandboxManager.spawn.length <= 1) {
      const spawnWithOptions = this.sandboxManager.spawn as unknown as (
        options: SessionSpawnOptions
      ) => ChildProcess;
      return spawnWithOptions.call(this.sandboxManager, { code, cwd, env });
    }

    if (!this.settings.subagentsProfile) {
      return this.sandboxManager.spawn(code, cwd);
    }
    const previous = process.env.PI_SUBAGENTS_PROFILE;
    try {
      process.env.PI_SUBAGENTS_PROFILE = this.settings.subagentsProfile;
      return this.sandboxManager.spawn(code, cwd);
    } finally {
      if (previous === undefined) {
        delete process.env.PI_SUBAGENTS_PROFILE;
      } else {
        process.env.PI_SUBAGENTS_PROFILE = previous;
      }
    }
  }

  /**
   * Spawn and ready a persistent kernel. `notebookPath` (required for a
   * durable record) is bound to the kernel; `source` (.ipynb or .py) is copied
   * to the destination and its code cells executed as prefix cells before
   * returning; `script` runs as one legacy seeding cell. Sourcing/script
   * failures do not throw — they are returned as sourceError/scriptError and
   * the kernel stays usable.
   */
  async provision(options: {
    cwd: string;
    ctx: ExtensionContext;
    signal?: AbortSignal;
    onUpdate?: ToolUpdateCallback;
    parentToolCallId?: string;
    script?: string;
    notebookPath?: string;
    source?: string;
  }): Promise<{
    id: string;
    sourcedFrom?: string;
    sourceError?: SourceExecutionError;
    scriptError?: PtcPythonError;
  }> {
    // Back-burner: limit disabled 2026-09-26 — revisit for provisioning churn per docs/BACK-BURNER.md §2
    // Keep maxPythonSessions parsing for compatibility, but do not reject new kernels here.

    // Venv readiness gate: on a fresh install the background pi_subagents
    // provisioning may still be creating the shared venv. Wait (bounded) for
    // it to settle before the first spawn, so resolvePythonExecutable() picks
    // the venv instead of locking the session onto system python3 while
    // provisioned packages live elsewhere. Skipped when the interpreter is
    // pinned or the venv already exists.
    if (!this.envGateSettled) {
      this.envGateSettled = true;
      if (!process.env.PTC_PYTHON_EXECUTABLE && !existsSync(venvPythonPath())) {
        await waitForSubagentsEnv();
      }
    }

    const sessionId = randomUUID().replace(/-/g, "").slice(0, 12);
    const { cwd } = options;
    const notebookPath = options.notebookPath ? path.resolve(cwd, options.notebookPath) : undefined;
    const preparedSource = await this.prepareSource(options.source, cwd, notebookPath);
    const callableToolRuntime = this.toolRegistry.createCallableToolRuntime(cwd, this.settings, {
      ctx: options.ctx,
      signal: options.signal,
      parentToolCallId: options.parentToolCallId,
    });
    const { rpcCode, runtimeCode, sessionCode } = loadPythonRuntimeSources(this.extensionRoot);
    const prelude = buildSessionPrelude({
      sessionId,
      toolWrappers: generateToolWrappers(callableToolRuntime.tools),
      runtime: { rpcCode, runtimeCode, sessionCode },
      maxParallelToolCalls: this.settings.maxParallelToolCalls,
      // session-prelude's legacy field name feeds the runtime's sole emergency
      // capture valve; it is no longer a model-facing output limit.
      maxOutputChars: this.settings.maxSpoolChars,
      hostWorkspaceRoot: cwd,
      runtimeWorkspaceRoot: this.sandboxManager.getRuntimeWorkspaceRoot(cwd),
      autoimportSubagents: !process.env.PI_SUBAGENT_DEPTH,
    });

    const proc = this.spawnSession(prelude, cwd);
    const protocol = new PersistentSessionProtocol(proc, callableToolRuntime.runTool, {
      terminateProcess: (signal) => this.sandboxManager.terminate?.(proc, signal) ?? proc.kill(signal),
      sendSignal: (signal) => {
        this.sandboxManager.terminate?.(proc, signal) ?? proc.kill(signal);
      },
      onSubagentSnapshot: (execId, snapshot) => {
        record.latestSnapshot = snapshot;
        this.hooks.onSubagentSnapshot?.(sessionId, execId, snapshot);
      },
      onInterruptedReport: (text) => {
        // Kept for callers that cannot observe the tool result; pi records our
        // interrupt error as the tool result, so nothing is queued by default.
        this.hooks.onInterrupted?.(sessionId, text);
      },
    });

    const record: SessionRecord = {
      id: sessionId,
      proc,
      protocol,
      chunks: [],
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      killed: false,
      queue: Promise.resolve(),
      pendingJobs: 0,
      latestSnapshot: null,
      notebookPath,
      prefixCellCount: preparedSource?.prefixCellCount ?? 0,
      prefixChunkCount: 0,
      sourcedFrom: preparedSource?.path,
    };

    const reap = () => this.reapSession(record);
    proc.once("exit", reap);
    proc.once("error", reap);

    try {
      await protocol.waitReady(15_000);
      if (record.killed || proc.exitCode !== null || proc.signalCode !== null) {
        throw new PythonSessionError("python session exited during startup");
      }
    } catch (error) {
      record.killed = true;
      this.terminateSession(record);
      await protocol.dispose().catch(() => undefined);
      throw error;
    }
    if (notebookPath) {
      protocol.setNotebookPath(notebookPath);
    }
    if (preparedSource) {
      // The first frame tells the runtime that copied markdown and code cells
      // occupy the prefix numbering range. It is consumed once by the protocol.
      protocol.setInitialCellCount(preparedSource.prefixCellCount);
    }

    this.sessions.set(sessionId, record);
    this.recency = this.recency.filter((id) => id !== sessionId);
    this.recency.push(sessionId);

    let sourceError: SourceExecutionError | undefined;
    if (preparedSource) {
      const sourceCells = preparedSource.kind === "python"
        ? [{ code: preparedSource.pythonCode ?? "", index: 0, file: preparedSource.path }]
        : preparedSource.cells
            .map((cell, index) => ({ cell, index }))
            .filter(({ cell }) => cell.cell_type === "code")
            .map(({ cell, index }) => ({ code: notebookText(cell.source), index, file: undefined }));

      for (const sourceCell of sourceCells) {
        record.prefixChunkCount += 1;
        try {
          await this.execChunk(
            record,
            sourceCell.code,
            options.onUpdate,
            options.signal,
            sourceCell.file,
            undefined,
            sourceCell.index
          );
        } catch (error) {
          sourceError = {
            cellIdx: sourceCell.index + 1,
            message: error instanceof Error ? error.message : String(error),
            traceback: error instanceof PtcPythonError ? error.traceback : undefined,
          };
          break;
        }
      }
    }

    let scriptError: PtcPythonError | undefined;
    if (options.script) {
      try {
        await this.execChunk(record, options.script, options.onUpdate);
      } catch (error) {
        if (error instanceof PtcPythonError) {
          scriptError = error;
        } else {
          throw error;
        }
      }
    }

    return { id: sessionId, sourcedFrom: preparedSource?.path, sourceError, scriptError };
  }

  /**
   * Foreground exec: serialized per session. pi may dispatch several exec_cell
   * calls in one assistant message (parallel tool calls), and a session has one
   * interpreter and one exec loop — so every call must queue behind the previous
   * one instead of racing it.
   */
  async execForeground(
    sessionId: string,
    code: string,
    options: SessionExecOptions
  ): Promise<CodeExecutionResult> {
    const record = this.require(sessionId);
    if (record.pendingJobs > 0 && options.onUpdate) {
      // pi dispatches parallel tool calls at once; the second chunk cannot start
      // until the first finishes. Say so instead of showing a silent pending row.
      options.onUpdate({
        content: [
          {
            type: "text",
            text: "Queued: another exec_cell cell is still running in this kernel",
          },
        ],
        details: { sessionId: record.id },
      });
    }
    record.pendingJobs += 1;
    const job = record.queue.then(
      () => this.execChunk(record, code, options.onUpdate, options.signal, options.file, options.notebookPath),
      () => this.execChunk(record, code, options.onUpdate, options.signal, options.file, options.notebookPath)
    );
    // Advance the queue regardless of this job's outcome so a failed exec cannot
    // wedge every later call on the session.
    record.queue = job.then(
      () => undefined,
      () => undefined
    );
    void job.then(
      () => {
        record.pendingJobs -= 1;
      },
      () => {
        record.pendingJobs -= 1;
      }
    );
    return job;
  }

  /**
   * Interrupt the chunk running in a session (Ctrl-C semantics). The interpreter
   * and its namespace survive; the running tool call reports the abort with the
   * Python stack. Returns false when nothing was running.
   */
  interruptRunning(sessionId: string): boolean {
    const record = this.sessions.get(sessionId);
    if (!record || !record.protocol.currentExecId()) {
      return false;
    }
    record.protocol.interrupt("abort", "interrupted from /ptc");
    return true;
  }

  /**
   * Run one chunk inside a session: validate user code (sourced library cells
   * are exempt), bump recency, wire the abort signal to a Ctrl-C-style
   * interrupt, and await the protocol's result.
   */
  private async execChunk(
    record: SessionRecord,
    code: string,
    onUpdate?: ToolUpdateCallback,
    signal?: AbortSignal,
    cellFile?: string,
    notebookPath?: string,
    sourceCellIndex?: number
  ): Promise<CodeExecutionResult> {
    // Sourced library cells must be recorded even when they contain code that
    // ordinary model-authored cells reject before execution. Let the runtime
    // report/record those failures against the copied prefix cell.
    if (sourceCellIndex === undefined) {
      validateUserCode(code);
    }
    if (record.killed || record.proc.exitCode !== null) {
      throw new PythonSessionError(`python session ${record.id} is no longer running; provision a new one`);
    }
    if (signal?.aborted) {
      throw new PtcAbortError("exec_cell aborted before the cell started");
    }
    record.lastUsedAt = Date.now();
    this.recency = this.recency.filter((id) => id !== record.id);
    this.recency.push(record.id);
    record.chunks.push(code);
    record.protocol.setUpdateHandler(onUpdate);
    if (notebookPath) record.notebookPath = notebookPath;
    record.protocol.setNotebookPath(record.notebookPath);
    if (cellFile) {
      record.protocol.setCellFile(cellFile);
    }
    if (sourceCellIndex !== undefined) {
      record.protocol.setSourceCellIndex(sourceCellIndex);
    }

    // An aborted tool call interrupts the running chunk (Ctrl-C semantics) and
    // leaves the session interactive, so its namespace and any subagents the
    // chunk spawned can still be used by later chunks.
    let abortListener: (() => void) | undefined;
    if (signal) {
      abortListener = () => {
        record.protocol.interrupt("abort", "tool call aborted");
      };
      signal.addEventListener("abort", abortListener, { once: true });
      if (signal.aborted) abortListener();
    }

    try {
      return await record.protocol.exec(code, this.settings.executionTimeoutMs);
    } finally {
      if (abortListener && signal) {
        signal.removeEventListener("abort", abortListener);
      }
      record.protocol.setUpdateHandler(undefined);
      record.lastUsedAt = Date.now();
    }
  }

  /** Copy a complete notebook artifact into the reusable PTC library. */
  async promoteToSkillNotebook(options: {
    name: string;
    notebookPath?: string;
    overwrite?: boolean;
    cwd?: string;
  }): Promise<SkillNotebookPromotionResult> {
    const cwd = options.cwd ?? process.cwd();
    const recentRecord = [...this.recency]
      .reverse()
      .map((id) => this.sessions.get(id))
      .find((record): record is SessionRecord => Boolean(record?.notebookPath && !record.killed));
    const notebookPath = options.notebookPath
      ? path.resolve(cwd, options.notebookPath)
      : recentRecord?.notebookPath;
    if (!notebookPath) {
      throw new PythonSessionError(
        "no session notebook is available; pass notebookPath or provision a notebook-backed kernel first"
      );
    }
    if (path.extname(notebookPath).toLowerCase() !== ".ipynb") {
      throw new PythonSessionError(`promotion source must be a .ipynb notebook: ${notebookPath}`);
    }

    const sourceRecord = [...this.sessions.values()].find(
      (record) => record.notebookPath && path.resolve(record.notebookPath) === path.resolve(notebookPath)
    );
    if (sourceRecord) {
      await sourceRecord.queue;
    }

    let notebookTextOnDisk: string;
    try {
      notebookTextOnDisk = await fs.promises.readFile(notebookPath, "utf8");
    } catch (error) {
      throw new PythonSessionError(
        `could not read notebook ${notebookPath}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
    parseNotebookDocument(notebookTextOnDisk, notebookPath);

    const name = sanitizeSkillNotebookName(options.name);
    const libraryDir = this.resolveLibraryDir();
    const targetPath = path.join(libraryDir, `${name}.ipynb`);
    const overwritten = fs.existsSync(targetPath);
    if (overwritten && !options.overwrite) {
      throw new PythonSessionError(
        `library notebook already exists: ${targetPath}; pass overwrite: true to replace it`
      );
    }
    if (path.resolve(notebookPath) === path.resolve(targetPath)) {
      if (!options.overwrite) {
        throw new PythonSessionError(
          `library notebook already exists: ${targetPath}; pass overwrite: true to replace it`
        );
      }
      return { name, path: targetPath, notebookPath, overwritten: true };
    }

    await fs.promises.mkdir(libraryDir, { recursive: true });
    try {
      await fs.promises.copyFile(
        notebookPath,
        targetPath,
        options.overwrite ? 0 : fs.constants.COPYFILE_EXCL
      );
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EEXIST") {
        throw new PythonSessionError(
          `library notebook already exists: ${targetPath}; pass overwrite: true to replace it`
        );
      }
      throw error;
    }
    return { name, path: targetPath, notebookPath, overwritten };
  }

  /** Legacy script export retained for API callers; notebook promotion is preferred. */
  async toScript(
    sessionId: string,
    options: { cwd: string; path?: string; name?: string }
  ): Promise<ScriptExportResult> {
    const record = this.require(sessionId);
    if (record.chunks.length === 0) {
      throw new PythonSessionError(`python session ${sessionId} has no executed code to export`);
    }

    // Overwrite-guard resolution happens host-side so the target is known to
    // the caller; the interpreter performs the AST-aware export write.
    const dir = options.path ? path.dirname(options.path) : path.join(".pi", "scripts");
    const baseName = options.path
      ? path.basename(options.path)
      : options.name
        ? options.name.endsWith(".py")
          ? options.name
          : `${options.name}.py`
        : `ptc-session-${record.id}.py`;
    const extension = path.extname(baseName);
    const stem = extension ? baseName.slice(0, -extension.length) : baseName;
    let candidate = baseName;
    let target = path.resolve(options.cwd, dir, candidate);
    let counter = 2;
    while (fs.existsSync(target)) {
      candidate = extension === ".py"
        ? `${stem}-${counter}.py`
        : `${stem}-${counter}${extension}`;
      target = path.resolve(options.cwd, dir, candidate);
      counter += 1;
    }

    const result = await record.queue.then(
      () => record.protocol.exportScript(record.chunks.map((code) => code.trimEnd()), target, this.settings.executionTimeoutMs),
      () => record.protocol.exportScript(record.chunks.map((code) => code.trimEnd()), target, this.settings.executionTimeoutMs)
    );
    return result;
  }

  /** Most recent session with a running exec, for /ptc defaults. */
  mostRecentActive(): SessionSummary | null {
    return this.list().find((session) => session.running) ?? null;
  }

  /** Kill one session: end the protocol, then SIGTERM → SIGKILL the process. */
  async dispose(sessionId: string): Promise<void> {
    const record = this.sessions.get(sessionId);
    if (!record) {
      return;
    }
    record.killed = true;
    this.sessions.delete(sessionId);
    this.recency = this.recency.filter((id) => id !== sessionId);
    await record.protocol.dispose();
    this.terminateSession(record);
  }

  private reapSession(record: SessionRecord): void {
    record.killed = true;
    if (this.sessions.get(record.id) === record) {
      this.sessions.delete(record.id);
      this.recency = this.recency.filter((id) => id !== record.id);
    }
  }

  private terminateSession(record: SessionRecord): void {
    const terminate = (signal: NodeJS.Signals) => {
      try {
        const result = this.sandboxManager.terminate?.(record.proc, signal);
        if (result === undefined || result === false) {
          record.proc.kill(signal);
        }
      } catch {
        // best-effort teardown
      }
    };
    terminate("SIGTERM");
    const forceKill = setTimeout(() => {
      if (record.proc.exitCode === null && record.proc.signalCode === null) {
        terminate("SIGKILL");
      }
    }, 1_000);
    forceKill.unref?.();
  }

  /** Dispose every live session (used at session shutdown / extension reload). */
  async disposeAll(): Promise<void> {
    await Promise.all([...this.sessions.keys()].map((id) => this.dispose(id)));
  }

  /** Look up a live session or throw UnknownSessionError listing live ids. */
  private require(sessionId: string): SessionRecord {
    const record = this.sessions.get(sessionId);
    if (!record) {
      throw new UnknownSessionError(sessionId, this.list().map((s) => s.id));
    }
    return record;
  }
}
