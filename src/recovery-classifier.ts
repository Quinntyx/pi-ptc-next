import type { RecoveryFailureClass } from "./recovery-state";

export type RecoveryKind = RecoveryFailureClass;

const KNOWN_ASYNC_HELPERS = [
  "read",
  "glob",
  "find",
  "grep",
  "ls",
  "ptc.read_many",
  "ptc.read_tree",
  "ptc.find_files",
  "ptc.find_files_abs",
  "ptc.read_text",
] as const;

const helperPattern = KNOWN_ASYNC_HELPERS.map((name) => escapeRegExp(name)).join("|");
// (?<![.\w]) excludes attribute access (open(p).read(), f.find(x)) and word tails.
const helperCallPattern = new RegExp(`(?<![.\\w])(?:${helperPattern})\\s*\\(`);
const awaitedHelperCallPattern = new RegExp(`\\bawait\\s+(?:${helperPattern})\\s*\\(`);
const iteratedHelperPatterns = [
  new RegExp(`\\b(?:sorted|list|tuple|set)\\s*\\([^\\n]*(?<![.\\w])(?:${helperPattern})\\s*\\(`),
  new RegExp(`\\bfor\\b[^\\n]*\\bin\\b[^\\n]*(?<![.\\w])(?:${helperPattern})\\s*\\(`),
  new RegExp(`(?<![.\\w])(?:${helperPattern})\\s*\\([^\\n]*\\)\\s*\\[`),
  new RegExp(`^[^#\\n=]+,\\s*[^#\\n=]+=\\s*(?:\\*\\s*)?(?<![.\\w])(?:${helperPattern})\\s*\\(`),
  // Common iteration/aggregation wrappers: "\n".join(read(f)), sum/min/max(glob(p)), dict(zip(...)).
  new RegExp(`\\b(?:sum|min|max|any|all|len|dict|zip|map|filter|enumerate)\\s*\\([^\\n]*(?<![.\\w])(?:${helperPattern})\\s*\\(`),
  new RegExp(`\\bjoin\\s*\\([^\\n]*(?<![.\\w])(?:${helperPattern})\\s*\\(`),
] as const;
// Must require coroutine/never-awaited markers: a bare "await" in a traceback echo
// or "SyntaxError: 'await' outside function" is not evidence of a missing await.
const missingAwaitDiagnosticPattern = /\bcoroutine\b|was never awaited/i;
const iteratedCoroutineDiagnosticPattern =
  /'coroutine' object is not iterable|'coroutine' object is not subscriptable|cannot unpack non-iterable coroutine object/i;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Quote-aware comment stripper: truncates at "#" only when it appears outside a
// string literal, so evidence like f"#chunk-{read(path)}" is preserved.
function stripComment(line: string): string {
  let result = "";
  let quote: string | null = null;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (quote !== null) {
      result += ch;
      if (ch === "\\") {
        i += 1;
        if (i < line.length) {
          result += line[i];
        }
        continue;
      }
      if (ch === quote) {
        quote = null;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      result += ch;
      continue;
    }
    if (ch === "#") {
      break;
    }
    result += ch;
  }
  return result.trim();
}

function getEvidenceLines(traceback?: string, code?: string): string[] {
  return [traceback, code]
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .flatMap((value) => value.split("\n"))
    .map(stripComment)
    .filter((line) => line.length > 0);
}

function hasDirectUnawaitedHelperCall(lines: string[]): boolean {
  return lines.some((line) => {
    if (!helperCallPattern.test(line) || awaitedHelperCallPattern.test(line)) {
      return false;
    }

    return !iteratedHelperPatterns.some((pattern) => pattern.test(line));
  });
}

function hasIteratedUnawaitedHelperUse(lines: string[]): boolean {
  return lines.some((line) => !awaitedHelperCallPattern.test(line) && iteratedHelperPatterns.some((pattern) => pattern.test(line)));
}

export function classifyCodeExecutionFailure(
  message: string,
  traceback?: string,
  code?: string
): RecoveryFailureClass | null {
  const evidenceLines = getEvidenceLines(traceback, code);
  const diagnostics = [message, traceback]
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .join("\n");

  if (missingAwaitDiagnosticPattern.test(diagnostics) && hasDirectUnawaitedHelperCall(evidenceLines)) {
    return "missing-await";
  }

  if (iteratedCoroutineDiagnosticPattern.test(diagnostics) && hasIteratedUnawaitedHelperUse(evidenceLines)) {
    return "async-wrapper-iterated";
  }

  return null;
}

export function buildCodeExecutionRecoveryPrompt(kind: RecoveryKind): string {
  switch (kind) {
    case "missing-await":
      return "PTC recovery: You called an async helper without await. Helpers like read, glob, find, grep, and ls are async wrappers. Await each helper call before using its result.";
    case "async-wrapper-iterated":
      return "PTC recovery: You used an async helper result before awaiting it. Helpers like read, glob, find, grep, and ls are async wrappers. Await the helper call before iterating, sorting, slicing, indexing, or unpacking the result.";
  }
}
