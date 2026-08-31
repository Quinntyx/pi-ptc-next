import { PtcAbortError, PtcPythonError } from "./execution/execution-errors";
import { RpcProtocol } from "./rpc-protocol";
import { loadPythonRuntimeSources } from "./execution/runtime-assets";
import type { CodeExecutionResult, ExecutionOptions, SandboxManager } from "./contracts/execution-types";
import type { PtcSettings } from "./contracts/settings";
import type { ToolRegistry } from "./tool-registry";
import { generateToolWrappers } from "./tools/tool-wrapper";
import { validateUserCode } from "./utils";

export class CodeExecutor {
  constructor(
    private sandboxManager: SandboxManager,
    private toolRegistry: ToolRegistry,
    private settings: PtcSettings,
    private extensionRoot: string
  ) {}

  private loadRuntimeFiles(): { rpcCode: string; runtimeCode: string } {
    return loadPythonRuntimeSources(this.extensionRoot);
  }

  private buildCombinedCode(
    userCode: string,
    toolWrappers: string,
    rpcCode: string,
    runtimeCode: string,
    hostWorkspaceRoot: string,
    runtimeWorkspaceRoot: string
  ): string {
    const indentedUserCode = userCode
      .split("\n")
      .map((line) => `    ${line}`)
      .join("\n");

    return `
${rpcCode}

${toolWrappers}

PTC_MAX_PARALLEL_TOOL_CALLS = ${this.settings.maxParallelToolCalls}
PTC_MAX_OUTPUT_CHARS = ${this.settings.maxOutputChars}
PTC_HOST_WORKSPACE_ROOT = ${JSON.stringify(hostWorkspaceRoot)}
PTC_RUNTIME_WORKSPACE_ROOT = ${JSON.stringify(runtimeWorkspaceRoot)}
PTC_USER_CODE_LINE_COUNT = ${userCode.split("\n").length}

${runtimeCode}

# User code
async def user_main():
${indentedUserCode}

# Execute
import asyncio
asyncio.run(_runtime_main(user_main))
`;
  }

  async execute(userCode: string, options: ExecutionOptions): Promise<CodeExecutionResult> {
    const { cwd, ctx, signal, onUpdate, parentToolCallId } = options;
    validateUserCode(userCode);

    if (signal?.aborted) {
      throw new PtcAbortError("Execution aborted before the Python process was started");
    }

    // One internal signal covers caller cancellation plus protocol failures and
    // timeouts, so nested host tools are cancelled with their Python caller.
    const executionController = new AbortController();
    const handleCallerAbort = () => executionController.abort(signal?.reason);
    signal?.addEventListener("abort", handleCallerAbort, { once: true });
    let rpc: RpcProtocol | undefined;

    try {
      const callableToolRuntime = this.toolRegistry.createCallableToolRuntime(cwd, this.settings, {
        ctx,
        signal: executionController.signal,
        parentToolCallId,
      });
      const toolWrappers = generateToolWrappers(callableToolRuntime.tools);
      const { rpcCode, runtimeCode } = this.loadRuntimeFiles();
      const runtimeWorkspaceRoot = this.sandboxManager.getRuntimeWorkspaceRoot(cwd);
      const combinedCode = this.buildCombinedCode(
        userCode,
        toolWrappers,
        rpcCode,
        runtimeCode,
        cwd,
        runtimeWorkspaceRoot
      );
      const proc = this.sandboxManager.spawn(combinedCode, cwd);
      rpc = new RpcProtocol(
        proc,
        callableToolRuntime.runTool,
        userCode,
        executionController.signal,
        onUpdate,
        {
          maxOutputChars: this.settings.maxOutputChars,
          onFailure: (error) => executionController.abort(error),
          terminateProcess: (terminationSignal) =>
            this.sandboxManager.terminate?.(proc, terminationSignal) ?? proc.kill(terminationSignal),
        }
      );

      const result = await rpc.waitForCompletion(this.settings.executionTimeoutMs);
      return {
        output: result.output,
        images: result.images,
        details: result.details,
      };
    } catch (error) {
      if (error instanceof PtcPythonError || error instanceof Error) {
        throw error;
      }
      throw new Error(String(error));
    } finally {
      signal?.removeEventListener("abort", handleCallerAbort);
      await rpc?.dispose();
    }
  }
}
