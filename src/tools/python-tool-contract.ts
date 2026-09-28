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
  /** Rendered parameter annotation, e.g. `path: str` or `limit: Optional[int] = None`. */
  signature: string;
  /** True when the param is optional and rendered keyword-only (after `*`). */
  keywordOnly: boolean;
}

/** Per-builtin metadata (read-only flag, Python return type, optional hand-written signature); undefined for unknown tools. */
export function getBuiltinToolContract(toolName: string): BuiltinToolContract | undefined {
  return BUILTIN_TOOL_CONTRACTS[toolName];
}

/** Read-only classification: explicit `ptc.readOnly` wins, else the builtin contract, else false. */
export function classifyBuiltinTool(toolName: string, ptc?: PtcToolOptions): { isReadOnly: boolean } {
  if (typeof ptc?.readOnly === "boolean") {
    return { isReadOnly: ptc.readOnly };
  }

  return { isReadOnly: getBuiltinToolContract(toolName)?.isReadOnly ?? false };
}

/** True when the schema is a `T | null` union (i.e. the parameter accepts None). */
export function isOptionalSchema(schema: TSchema): boolean {
  const anyOf = (schema as { anyOf?: TSchema[] }).anyOf;
  return Array.isArray(anyOf)
    ? anyOf.some((entry) => (entry as { type?: string }).type === "null")
    : false;
}

/** Strip the `null` member from a `T | null` union schema; non-unions pass through. */
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

/**
 * Map a TypeBox schema to a Python type annotation (`str`, `int`, `float`,
 * `bool`, `List[T]`, `Dict[str, Any]`, `None`); unions become `Union[...]`
 * (null members dropped) and unknown shapes degrade to `Any`.
 */
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

/** The name the helper gets inside cells: `ptc.pythonName` if set, else the tool name. */
export function getPythonHelperName(tool: ToolInfo): string {
  return tool.ptc?.pythonName || tool.name;
}

/**
 * Reject duplicate Python helper names across the tool set, and helper names
 * that shadow the builtin helpers or PTC machinery (`ptc`, `_rpc_call`, …)
 * when claimed by a differently named tool. Throws with the offending names.
 */
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

/** Python return type for a tool: the builtin contract's type, else `Any`. */
export function getPythonReturnType(tool: ToolInfo): string {
  return getBuiltinToolContract(tool.name)?.pythonReturnType ?? "Any";
}

/**
 * Per-parameter Python metadata derived from the tool's JSON schema. Params
 * that are not required, or whose schema accepts null, become keyword-only
 * with `Optional[T] = None` (null members stripped from the type).
 */
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

/** Single-line signature (helper documentation), required params first, optional ones after `*`. */
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

/** Multi-line `async def` source rendered into the generated tool wrappers. */
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

/**
 * One-line signature for a tool's Python helper. Builtins with a
 * hand-written signature (currently `read`) use it; everything else is
 * synthesized from the tool's schema.
 */
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

/** Signatures for the full helper surface shown in the exec_cell description. */
export function describePythonHelpers(tools: ToolInfo[]): string[] {
  return tools.map((tool) => describePythonHelper(tool));
}
