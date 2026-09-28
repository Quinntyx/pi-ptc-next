import type { ToolInfo } from "../contracts/tool-types";
import {
  buildMultilinePythonSignature,
  buildPythonParamMetadata,
  getPythonHelperName,
  getPythonReturnType,
} from "./python-tool-contract";

function buildParamsDictionary(paramNames: string[]): string {
  if (paramNames.length === 0) {
    return "    params = {}";
  }

  return `    params = _ptc_drop_none({\n${paramNames
    .map((paramName) => `        ${JSON.stringify(paramName)}: ${paramName}`)
    .join(",\n")}\n    })`;
}

function buildGenericToolWrapper(tool: ToolInfo): string {
  const pythonName = getPythonHelperName(tool);
  const returnType = getPythonReturnType(tool);
  const params = buildPythonParamMetadata(tool);
  const signature = buildMultilinePythonSignature(pythonName, returnType, params);
  const paramsDict = buildParamsDictionary(params.map((entry) => entry.name));

  return `${signature}
${paramsDict}
    return await _rpc_call(${JSON.stringify(tool.name)}, params)`;
}

function buildReadWrapper(): string {
  return `async def read(
    path: str,
    *,
    offset: Optional[int] = None,
    limit: Optional[int] = None,
) -> str:
    params = _ptc_drop_none({
        "path": path,
        "offset": offset,
        "limit": limit,
    })
    return await _rpc_call("read", params)`;
}

export function generateToolWrappers(tools: ToolInfo[]): string {
  const imports = `from typing import Optional, List, Dict, Any, TypedDict, Union`;
  const helpers = `

class GrepMatch(TypedDict):
    path: str
    line: int
    text: str
    kind: str

class GrepResult(TypedDict):
    matches: List[GrepMatch]
    matchLimitReached: Optional[int]

class BashResult(TypedDict):
    stdout: str
    stderr: str
    exitCode: int

class EditResult(TypedDict):
    ok: bool
    summary: str
    diff: Optional[str]

class WriteResult(TypedDict):
    ok: bool
    summary: str


def _ptc_drop_none(params: Dict[str, Any]) -> Dict[str, Any]:
    return {key: value for key, value in params.items() if value is not None}
`;

  const wrappers = tools.map((tool) => {
    if (tool.name === "read") {
      return buildReadWrapper();
    }
    return buildGenericToolWrapper(tool);
  });

  return `${imports}${helpers}\n\n${wrappers.join("\n\n")}`;
}
