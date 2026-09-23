import readline from "readline";
import { randomUUID } from "crypto";
import * as fs from "fs";
import * as path from "path";
import type { ChildProcess } from "child_process";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import {
  PtcAbortError,
  PtcProtocolError,
  PtcPythonError,
  PtcTimeoutError,
} from "./execution/execution-errors";
import { normalizeToolResult } from "./tool-adapters";
import { buildSessionPrelude } from "./execution/session-prelude";
import { loadPythonRuntimeSources } from "./execution/runtime-assets";
import type {
  CodeExecutionResult,
  ExecutionDetails,
  SandboxManager,
  ScriptExportResult,
  SubagentRuntimeSnapshot,
} from "./contracts/execution-types";
import type { PtcSettings } from "./contracts/settings";
import type { ToolUpdateCallback } from "./contracts/tool-types";
import type { ToolRegistry } from "./tool-registry";
import { generateToolWrappers } from "./tools/tool-wrapper";
import { debugLog, estimateTokensFromChars, validateUserCode } from "./utils";

export type { ScriptExportResult } from "./contracts/execution-types";

export interface SessionExecOptions {
  cwd: string;
  ctx?: ExtensionContext;
  signal?: AbortSignal;
  onUpdate?: ToolUpdateCallback;
  parentToolCallId?: string;
}

export interface SessionSummary {
  id: string;
  createdAt: number;
  lastUsedAt: number;
  chunks: number;
  hasPendingBackground: boolean;
  running: boolean;
}

export interface BackgroundCompletion {
  sessionId: string;
  execId: string;
  result: CodeExecutionResult;
}

export class PythonSessionError extends Error {}
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
  maxOutputChars: number;
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

class PersistentSessionProtocol {
  private stdout = "";
  private stdoutCharsSeen = 0;
  private stderr = "";
  private stderrCharsSeen = 0;
  private currentLine?: number;
  private totalLines?: number;
  private activeTool?: string;
  private chunkLines: string[] = [];
  private execId = "";
  private execStartedAt = Date.now();
  private execResolve?: (result: CodeExecutionResult) => void;
  private execReject?: (error: Error) => void;
  private execTimeout?: NodeJS.Timeout;
  private backgrounded = false;
  private updateHandler?: ToolUpdateCallback;
  private execTimeoutMs?: number;
  private currentExecPromiseField: Promise<CodeExecutionResult> | null = null;
  private nestedToolCalls = 0;
  private nestedToolNames: string[] = [];
  private nestedResultChars = 0;
  private nestedResultCount = 0;
  private nestedErrors = 0;
  private readonly reader: readline.Interface;
  private readyResolve?: () => void;
  private readyReject?: (error: Error) => void;
  private execRejectRef?: (error: Error) => void;
  private scriptExportId = "";
  private scriptExportResolve?: (result: ScriptExportResult) => void;
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
    this.execResolve = undefined;
    if (this.execTimeout) {
      clearTimeout(this.execTimeout);
      this.execTimeout = undefined;
    }
    this.execRejectRef?.(error);
  }

  private buildDetails(overrides?: Partial<ExecutionDetails>): ExecutionDetails {
    return {
      execId: this.execId,
      nestedToolCalls: this.nestedToolCalls,
      nestedToolNames: [...this.nestedToolNames],
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
        this.emitUpdate();
        try {
          const result = await this.runTool(tool, msg.params, callId);
          const normalized = normalizeToolResult(
            tool,
            result as { content?: Array<Record<string, unknown>>; details?: unknown }
          );
          this.nestedResultChars += normalized.estimatedChars;
          this.nestedResultCount += 1;
          this.send({ type: "tool_result", id: callId, value: normalized.value });
        } catch (error) {
          this.nestedErrors += 1;
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
        const observedChars = this.stdoutCharsSeen + finalOutput.length;
        const totalChars = Math.max(observedChars, (msg.total_output_chars as number) ?? observedChars);
        this.finish({
          output: this.buildFinalOutput(finalOutput, totalChars),
          images: (msg.images as never[] | undefined) ?? undefined,
          details: this.buildDetails({ execId: this.execId }),
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
        this.finish(new PtcPythonError(rawMessage, traceback));
        return;
      }

      case "subagent_state": {
        this.options.onSubagentSnapshot?.(this.execId, msg.snapshot as SubagentRuntimeSnapshot);
        this.emitUpdate({ subagentSnapshot: msg.snapshot as SubagentRuntimeSnapshot });
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
   * only known when the caller invokes python_exec.
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
    if (this.backgrounded) {
      return; // no active tool call to stream updates into
    }
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

  private buildFinalOutput(finalText: string, totalChars: number): string {
    const remaining = this.options.maxOutputChars - this.stdout.length;
    const retainedFinal = remaining > 0 ? finalText.slice(0, Math.max(0, remaining)) : "";
    const retained = this.stdoutCharsSeen > 0 ? `${this.stdout}${retainedFinal}`.trim() : retainedFinal;
    if (totalChars <= this.options.maxOutputChars) {
      return retained;
    }
    return `${retained}\n\n[Output truncated - showing first ${this.options.maxOutputChars} characters of ${totalChars}]`;
  }

  private appendStdout(text: string): void {
    if (!text) {
      return;
    }
    this.stdoutCharsSeen += text.length;
    const remaining = this.options.maxOutputChars - this.stdout.length;
    if (remaining > 0) {
      this.stdout += text.slice(0, remaining);
    }
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
  async exec(code: string, timeoutMs: number | undefined, backgrounded: boolean): Promise<CodeExecutionResult> {
    if (this.execResolve) {
      // Serialization is the manager's job; this is defense in depth so two
      // overlapping execs can never clobber each other's promise state.
      throw new PtcProtocolError(
        "python session is busy: another chunk is already executing (python_exec calls are serialized per session)"
      );
    }
    this.execId = `exec_${randomUUID().replace(/-/g, "").slice(0, 10)}`;
    this.execStartedAt = Date.now();
    this.chunkLines = code.split("\n");
    this.stdout = "";
    this.stdoutCharsSeen = 0;
    this.currentLine = undefined;
    this.totalLines = undefined;
    this.activeTool = undefined;
    this.backgrounded = backgrounded;

    const promise = new Promise<CodeExecutionResult>((resolve, reject) => {
      this.execResolve = resolve;
      this.execReject = reject;
      this.execRejectRef = reject;
    });
    this.currentExecPromiseField = promise;

    this.execTimeoutMs = timeoutMs;
    this.armExecTimeout();

    this.send({ type: "exec", id: this.execId, code, user_code_line_count: this.chunkLines.length });
    return promise;
  }

  currentExecId(): string | null {
    return this.execResolve || this.backgrounded ? this.execId : null;
  }

  /** Ask the interpreter to write the cumulative cells to disk (AST-aware). */
  async exportScript(cells: string[], targetPath: string, timeoutMs: number | undefined): Promise<ScriptExportResult> {
    this.scriptExportId = `export_${randomUUID().replace(/-/g, "").slice(0, 10)}`;
    const promise = new Promise<ScriptExportResult>((resolve, reject) => {
      this.scriptExportResolve = resolve;
      this.scriptExportReject = reject;
    });

    let timeout: NodeJS.Timeout | undefined;
    if (timeoutMs !== undefined) {
      timeout = setTimeout(() => {
        this.scriptExportReject?.(new Error(`Script export timed out after ${Math.round(timeoutMs / 1000)} seconds`));
      }, timeoutMs);
      timeout.unref?.();
    }
    void promise.finally(() => {
      if (timeout) {
        clearTimeout(timeout);
      }
    });

    this.send({ type: "export_script", id: this.scriptExportId, path: targetPath, cells });
    return promise;
  }

  currentExecPromise(): Promise<CodeExecutionResult> | null {
    return this.execResolve || this.backgrounded ? this.currentExecPromiseField ?? null : null;
  }

  /** Convert the running exec to a background run (stops streaming updates). */
  setBackgrounded(flag: boolean): void {
    this.backgrounded = flag;
    if (flag) {
      // Emit one final update so the render collapses cleanly.
      this.emitUpdate();
      this.backgrounded = true;
    }
  }

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

interface SessionRecord {
  id: string;
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
  background: Map<string, { code: string; status: "pending" | "done" | "error"; result?: CodeExecutionResult }>;
  latestSnapshot: SubagentRuntimeSnapshot | null;
}

export interface PythonSessionManagerHooks {
  onSubagentSnapshot?: (sessionId: string, execId: string, snapshot: SubagentRuntimeSnapshot) => void;
  onBackgroundComplete?: (completion: BackgroundCompletion) => void;
  /** Report for a chunk interrupted after pi had already aborted the tool call. */
  onInterrupted?: (sessionId: string, text: string) => void;
}

export class PythonSessionManager {
  private sessions = new Map<string, SessionRecord>();
  private recency: string[] = [];

  constructor(
    private sandboxManager: SandboxManager,
    private toolRegistry: ToolRegistry,
    private settings: PtcSettings,
    private extensionRoot: string,
    private hooks: PythonSessionManagerHooks = {}
  ) {}

  list(): SessionSummary[] {
    return [...this.sessions.values()]
      .sort((a, b) => this.recencyIndex(b.id) - this.recencyIndex(a.id))
      .map((session) => ({
        id: session.id,
        createdAt: session.createdAt,
        lastUsedAt: session.lastUsedAt,
        chunks: session.chunks.length,
        hasPendingBackground: [...session.background.values()].some((entry) => entry.status === "pending"),
        running: Boolean(session.protocol.currentExecId()),
      }));
  }

  private recencyIndex(id: string): number {
    const index = this.recency.indexOf(id);
    return index === -1 ? -1 : index;
  }

  get(id: string): boolean {
    return this.sessions.has(id);
  }

  getSubagentSnapshot(sessionId: string): SubagentRuntimeSnapshot | null {
    return this.sessions.get(sessionId)?.latestSnapshot ?? null;
  }

  latestSubagentSnapshot(): SubagentRuntimeSnapshot | null {
    for (let index = this.recency.length - 1; index >= 0; index--) {
      const snapshot = this.sessions.get(this.recency[index])?.latestSnapshot;
      if (snapshot) {
        return snapshot;
      }
    }
    return null;
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

  async provision(options: {
    cwd: string;
    ctx: ExtensionContext;
    signal?: AbortSignal;
    onUpdate?: ToolUpdateCallback;
    parentToolCallId?: string;
    script?: string;
  }): Promise<{ id: string; scriptError?: PtcPythonError }> {
    const liveCount = [...this.sessions.values()].filter((session) => !session.killed).length;
    if (liveCount >= this.settings.maxPythonSessions) {
      throw new PythonSessionError(
        `python session limit reached (${this.settings.maxPythonSessions}). Live sessions: ${
          this.list().map((s) => s.id).join(", ") || "(none)"
        }`
      );
    }

    const sessionId = randomUUID().replace(/-/g, "").slice(0, 12);
    const { cwd } = options;
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
      maxOutputChars: this.settings.maxOutputChars,
      hostWorkspaceRoot: cwd,
      runtimeWorkspaceRoot: this.sandboxManager.getRuntimeWorkspaceRoot(cwd),
      autoimportSubagents: !process.env.PI_SUBAGENT_DEPTH,
    });

    // The spawner library reads PI_SUBAGENTS_PROFILE from the interpreter's env;
    // process.env is inherited by the sandbox spawn, so publish the override here.
    if (this.settings.subagentsProfile) {
      process.env.PI_SUBAGENTS_PROFILE = this.settings.subagentsProfile;
    }

    const proc = this.sandboxManager.spawn(prelude, cwd);
    const protocol = new PersistentSessionProtocol(proc, callableToolRuntime.runTool, {
      maxOutputChars: this.settings.maxOutputChars,
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
      background: new Map(),
      latestSnapshot: null,
    };

    await protocol.waitReady(15_000);

    this.sessions.set(sessionId, record);
    this.recency = this.recency.filter((id) => id !== sessionId);
    this.recency.push(sessionId);

    let scriptError: PtcPythonError | undefined;
    if (options.script) {
      try {
        await this.execChunk(record, options.script, false, options.onUpdate);
      } catch (error) {
        if (error instanceof PtcPythonError) {
          scriptError = error;
        } else {
          throw error;
        }
      }
    }

    return { id: sessionId, scriptError };
  }

  /** Foreground exec: serialized per session, streams updates, blocks. */
  /**
   * Foreground exec: serialized per session. pi may dispatch several python_exec
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
            text: "Queued: another python_exec chunk is still running in this session",
          },
        ],
        details: { sessionId: record.id },
      });
    }
    record.pendingJobs += 1;
    const job = record.queue.then(
      () => this.execChunk(record, code, false, options.onUpdate, options.signal),
      () => this.execChunk(record, code, false, options.onUpdate, options.signal)
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

  /** Background exec: queues the chunk, returns the exec id immediately. */
  async execBackground(
    sessionId: string,
    code: string,
    options: SessionExecOptions
  ): Promise<{ execId: string }> {
    const record = this.require(sessionId);
    validateUserCode(code);

    let resolveExecId!: (execId: string) => void;
    let rejectExecId!: (error: Error) => void;
    const execIdPromise = new Promise<string>((resolve, reject) => {
      resolveExecId = resolve;
      rejectExecId = reject;
    });

    const run = async (): Promise<void> => {
      if (record.killed || record.proc.exitCode !== null) {
        throw new PythonSessionError(`python session ${record.id} is no longer running; provision a new one`);
      }
      record.lastUsedAt = Date.now();
      record.chunks.push(code);
      const execPromise = record.protocol.exec(code, this.settings.executionTimeoutMs, true);
      const execId = record.protocol.currentExecId() ?? "unknown";
      record.background.set(execId, { code, status: "pending" });
      resolveExecId(execId);
      let result: CodeExecutionResult;
      try {
        result = await execPromise;
        const entry = record.background.get(execId);
        if (entry) {
          entry.status = "done";
          entry.result = result;
        }
      } catch (error) {
        result = {
          output: error instanceof Error ? error.message : String(error),
          details: {
            nestedToolCalls: 0,
            nestedToolNames: [],
            nestedResultChars: 0,
            nestedResultCount: 0,
            nestedErrors: 1,
            durationMs: 0,
            estimatedAvoidedTokens: 0,
            execId,
          },
        };
        const entry = record.background.get(execId);
        if (entry) {
          entry.status = "error";
          entry.result = result;
        }
      }
      this.hooks.onBackgroundComplete?.({ sessionId: record.id, execId, result });
    };

    record.queue = record.queue
      .then(run)
      .catch((error) => {
        rejectExecId(error instanceof Error ? error : new Error(String(error)));
      });

    return { execId: await execIdPromise };
  }

  /** Wait for a backgrounded exec to finish (python_exec wait_for). */
  async waitForExec(sessionId: string, execId: string): Promise<CodeExecutionResult> {
    const record = this.require(sessionId);
    const entry = record.background.get(execId);
    if (!entry) {
      const known = [...record.background.keys()].join(", ") || "(none)";
      throw new PythonSessionError(`Unknown background exec ${execId} in session ${sessionId}. Known: ${known}`);
    }
    if (entry.result) {
      return entry.result;
    }
    const deadline = Date.now() + this.settings.executionTimeoutMs;
    while (!entry.result && Date.now() < deadline) {
      if (record.killed) {
        throw new PythonSessionError(`python session ${sessionId} was disposed while waiting for ${execId}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    if (!entry.result) {
      throw new PythonSessionError(`Timed out waiting for background exec ${execId}`);
    }
    return entry.result;
  }

  pendingBackground(sessionId: string): Array<{ execId: string; status: string }> {
    const record = this.sessions.get(sessionId);
    if (!record) {
      return [];
    }
    return [...record.background.entries()].map(([execId, entry]) => ({ execId, status: entry.status }));
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
   * Convert the currently-running foreground exec into a background run
   * ("User manually backgrounded this ptc run"). Returns its exec id, or null
   * when nothing is executing in the session.
   */
  async markBackgrounded(sessionId: string): Promise<string | null> {
    const record = this.sessions.get(sessionId);
    if (!record) {
      return null;
    }
    const execId = record.protocol.currentExecId();
    const execPromise = record.protocol.currentExecPromise();
    if (!execId || !execPromise) {
      return null;
    }
    record.protocol.setBackgrounded(true);
    const entry: { code: string; status: "pending" | "done" | "error"; result?: CodeExecutionResult } = { code: "", status: "pending" };
    record.background.set(execId, entry);
    void execPromise
      .then((result: CodeExecutionResult) => {
        entry.status = "done";
        entry.result = result;
        this.hooks.onBackgroundComplete?.({ sessionId: record.id, execId, result });
      })
      .catch((error: unknown) => {
        entry.status = "error";
        entry.result = {
          output: error instanceof Error ? error.message : String(error),
          details: {
            nestedToolCalls: 0,
            nestedToolNames: [],
            nestedResultChars: 0,
            nestedResultCount: 0,
            nestedErrors: 1,
            durationMs: 0,
            estimatedAvoidedTokens: 0,
            execId,
          },
        };
        this.hooks.onBackgroundComplete?.({ sessionId: record.id, execId, result: entry.result });
      });
    return execId;
  }

  private async execChunk(
    record: SessionRecord,
    code: string,
    backgrounded: boolean,
    onUpdate?: ToolUpdateCallback,
    signal?: AbortSignal
  ): Promise<CodeExecutionResult> {
    validateUserCode(code);
    if (record.killed || record.proc.exitCode !== null) {
      throw new PythonSessionError(`python session ${record.id} is no longer running; provision a new one`);
    }
    if (signal?.aborted) {
      throw new PtcAbortError("python_exec aborted before the chunk started");
    }
    record.lastUsedAt = Date.now();
    record.chunks.push(code);
    record.protocol.setUpdateHandler(onUpdate);

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
      return await record.protocol.exec(code, this.settings.executionTimeoutMs, backgrounded);
    } finally {
      if (abortListener && signal) {
        signal.removeEventListener("abort", abortListener);
      }
      record.protocol.setUpdateHandler(undefined);
      record.lastUsedAt = Date.now();
    }
  }

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
    const dir = options.path ? path.dirname(options.path) : path.join(options.cwd, ".pi", "scripts");
    const baseName = options.path
      ? path.basename(options.path)
      : options.name
        ? options.name.endsWith(".py")
          ? options.name
          : `${options.name}.py`
        : `ptc-session-${record.id}.py`;
    let target = path.resolve(options.cwd, path.join(dir, baseName));
    let counter = 2;
    while (fs.existsSync(target)) {
      target = path.join(dir, baseName.replace(/(\.py)?$/, (match) => `-${counter}.py`));
      counter += 1;
    }

    const result = await record.queue.then(
      () => record.protocol.exportScript(record.chunks.map((code) => code.trimEnd()), target, this.settings.executionTimeoutMs),
      () => record.protocol.exportScript(record.chunks.map((code) => code.trimEnd()), target, this.settings.executionTimeoutMs)
    );
    return result;
  }

  /** Most recent session with a running or pending exec, for /ptc defaults. */
  mostRecentActive(): SessionSummary | null {
    const summaries = this.list();
    return summaries.filter((s) => s.running || s.hasPendingBackground)[0] ?? null;
  }

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

  async disposeAll(): Promise<void> {
    await Promise.all([...this.sessions.keys()].map((id) => this.dispose(id)));
  }

  private require(sessionId: string): SessionRecord {
    const record = this.sessions.get(sessionId);
    if (!record) {
      throw new UnknownSessionError(sessionId, this.list().map((s) => s.id));
    }
    return record;
  }
}
