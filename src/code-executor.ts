import { PtcPythonError } from "./execution/execution-errors";
import { RpcProtocol } from "./rpc-protocol";
import { loadPythonRuntimeSources } from "./execution/runtime-assets";
import type { CodeExecutionResult, ExecutionOptions, SandboxManager } from "./contracts/execution-types";
import type { PtcSettings } from "./contracts/settings";
import type { ToolRegistry } from "./tool-registry";
import { generateToolWrappers } from "./tools/tool-wrapper";
import { truncateOutput, validateUserCode } from "./utils";

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

    const callableToolRuntime = this.toolRegistry.createCallableToolRuntime(cwd, this.settings, {
      ctx,
      signal,
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
    const rpc = new RpcProtocol(proc, callableToolRuntime.runTool, userCode, signal, onUpdate);

    try {
      const result = await rpc.waitForCompletion(this.settings.executionTimeoutMs);
      return {
        output: truncateOutput(result.output, this.settings.maxOutputChars),
        images: result.images,
        details: result.details,
      };
    } catch (error) {
      if (error instanceof PtcPythonError || error instanceof Error) {
        throw error;
      }
      throw new Error(String(error));
    }
  }
}
