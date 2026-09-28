import type { TSchema } from "@sinclair/typebox";
import type { PtcToolOptions, ToolInfo } from "../contracts/tool-types";

interface BuiltinToolContract {
  isReadOnly: boolean;
  pythonReturnType: string;
  helperSignature?: string;
}

const BUILTIN_TOOL_CONTRACTS: Record<string, BuiltinToolContract> = {
  read: {
    isReadOnly: true,
    pythonReturnType: "str",
    helperSignature: "read(path: str, *, offset: Optional[int] = None, limit: Optional[int] = None) -> str",
  },
  find: {
    isReadOnly: true,
    pythonReturnType: "List[str]",
  },
  glob: {
    isReadOnly: true,
    pythonReturnType: "List[str]",
  },
  grep: {
    isReadOnly: true,
    pythonReturnType: "GrepResult",
  },
  ls: {
    isReadOnly: true,
    pythonReturnType: "List[str]",
  },
  bash: {
    isReadOnly: false,
    pythonReturnType: "BashResult",
  },
  edit: {
    isReadOnly: false,
    pythonReturnType: "EditResult",
  },
  write: {
    isReadOnly: false,
    pythonReturnType: "WriteResult",
  },
};

const RESERVED_PYTHON_HELPER_NAMES = new Set([
  "ptc",
  "_rpc_call",
  "_ptc_drop_none",
  "read",
  "find",
  "glob",
  "grep",
  "ls",
  "bash",
  "edit",
  "write",
]);

/** Names of the known builtin tools (used to reject custom-tool name collisions). */
export const BUILTIN_TOOL_NAMES: ReadonlySet<string> = new Set(Object.keys(BUILTIN_TOOL_CONTRACTS));

export interface PythonParamMetadata {
  name: string;
  signature: string;
  keywordOnly: boolean;
}

export function getBuiltinToolContract(toolName: string): BuiltinToolContract | undefined {
  return BUILTIN_TOOL_CONTRACTS[toolName];
}

export function classifyBuiltinTool(toolName: string, ptc?: PtcToolOptions): { isReadOnly: boolean } {
  if (typeof ptc?.readOnly === "boolean") {
    return { isReadOnly: ptc.readOnly };
  }

  return { isReadOnly: getBuiltinToolContract(toolName)?.isReadOnly ?? false };
}

export function isOptionalSchema(schema: TSchema): boolean {
  const anyOf = (schema as { anyOf?: TSchema[] }).anyOf;
  return Array.isArray(anyOf)
    ? anyOf.some((entry) => (entry as { type?: string }).type === "null")
    : false;
}

export function extractNonNullSchema(schema: TSchema): TSchema {
  const anyOf = (schema as { anyOf?: TSchema[] }).anyOf;
  if (!Array.isArray(anyOf)) {
    return schema;
  }

  return anyOf.find((entry) => (entry as { type?: string }).type !== "null") ?? schema;
}

function collapseUnionTypes(types: string[]): string {
  const unique = [...new Set(types.filter(Boolean))];
  if (unique.length === 0) {
    return "Any";
  }
  if (unique.length === 1) {
    return unique[0];
  }
  return `Union[${unique.join(", ")}]`;
}

export function schemaToPythonType(schema: TSchema): string {
  const anyOf = (schema as { anyOf?: TSchema[] }).anyOf;
  if (Array.isArray(anyOf) && anyOf.length > 0) {
    const nonNullEntries = anyOf.filter((entry) => (entry as { type?: string }).type !== "null");
    return collapseUnionTypes(nonNullEntries.map((entry) => schemaToPythonType(entry)));
  }

  const kind = (schema as { type?: string }).type;
  switch (kind) {
    case "string":
      return "str";
    case "number":
      return "float";
    case "integer":
      return "int";
    case "boolean":
      return "bool";
    case "array": {
      const items = (schema as { items?: TSchema }).items;
      const itemType = items ? schemaToPythonType(items) : "Any";
      return `List[${itemType}]`;
    }
    case "object":
      return "Dict[str, Any]";
    case "null":
      return "None";
    default:
      return "Any";
  }
}

export function getPythonHelperName(tool: ToolInfo): string {
  return tool.ptc?.pythonName || tool.name;
}

export function validatePythonHelperNames(tools: ToolInfo[]): void {
  const seen = new Map<string, string>();

  for (const tool of tools) {
    const pythonName = getPythonHelperName(tool);
    const existingTool = seen.get(pythonName);
    if (existingTool) {
      throw new Error(`Duplicate Python helper name '${pythonName}' for tools '${existingTool}' and '${tool.name}'`);
    }
    if (RESERVED_PYTHON_HELPER_NAMES.has(pythonName) && pythonName !== tool.name) {
      throw new Error(`Python helper name '${pythonName}' is reserved and cannot be used by tool '${tool.name}'`);
    }
    seen.set(pythonName, tool.name);
  }
}

export function getPythonReturnType(tool: ToolInfo): string {
  return getBuiltinToolContract(tool.name)?.pythonReturnType ?? "Any";
}

export function buildPythonParamMetadata(tool: ToolInfo): PythonParamMetadata[] {
  const params = ((tool.parameters as { properties?: Record<string, TSchema> })?.properties) || {};
  const required = new Set(((tool.parameters as { required?: string[] })?.required) || []);

  return Object.entries(params).map(([paramName, paramSchema]) => {
    const schema = paramSchema as TSchema;
    const optional = !required.has(paramName) || isOptionalSchema(schema);
    const actualSchema = isOptionalSchema(schema) ? extractNonNullSchema(schema) : schema;
    const pythonType = schemaToPythonType(actualSchema);
    return {
      name: paramName,
      keywordOnly: optional,
      signature: optional ? `${paramName}: Optional[${pythonType}] = None` : `${paramName}: ${pythonType}`,
    };
  });
}

function splitPythonParams(params: PythonParamMetadata[]): {
  required: PythonParamMetadata[];
  optional: PythonParamMetadata[];
} {
  return {
    required: params.filter((entry) => !entry.keywordOnly),
    optional: params.filter((entry) => entry.keywordOnly),
  };
}

export function buildInlinePythonSignature(
  pythonName: string,
  returnType: string,
  params: PythonParamMetadata[]
): string {
  const { required, optional } = splitPythonParams(params);
  const parts: string[] = [];

  if (required.length > 0) {
    parts.push(required.map((entry) => entry.signature).join(", "));
  }
  if (optional.length > 0) {
    parts.push("*");
    parts.push(optional.map((entry) => entry.signature).join(", "));
  }

  return `${pythonName}(${parts.join(", ")}) -> ${returnType}`;
}

export function buildMultilinePythonSignature(
  pythonName: string,
  returnType: string,
  params: PythonParamMetadata[]
): string {
  const { required, optional } = splitPythonParams(params);

  let signature = `async def ${pythonName}(`;
  if (required.length > 0) {
    signature += `\n    ${required.map((entry) => entry.signature).join(",\n    ")}`;
    if (optional.length > 0) {
      signature += `,\n    *,\n    ${optional.map((entry) => entry.signature).join(",\n    ")}`;
    }
  } else if (optional.length > 0) {
    signature += `\n    *,\n    ${optional.map((entry) => entry.signature).join(",\n    ")}`;
  }

  return `${signature}\n) -> ${returnType}:`;
}

export function describePythonHelper(tool: ToolInfo): string {
  const pythonName = getPythonHelperName(tool);
  const builtinSignature = getBuiltinToolContract(tool.name)?.helperSignature;
  if (builtinSignature) {
    return builtinSignature.replace(/^read\(/, `${pythonName}(`);
  }

  const returnType = getPythonReturnType(tool);
  const params = buildPythonParamMetadata(tool);
  return buildInlinePythonSignature(pythonName, returnType, params);
}

export function describePythonHelpers(tools: ToolInfo[]): string[] {
  return tools.map((tool) => describePythonHelper(tool));
}
