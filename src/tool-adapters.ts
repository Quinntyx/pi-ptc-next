import type { NormalizedToolResult } from "./contracts/execution-types";

interface ToolExecutionResult {
  content?: Array<{ type?: string; text?: string } | Record<string, unknown>>;
  details?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Concatenate the `text` items of a tool result's content array (non-text items contribute nothing). */
function extractTextContent(result: ToolExecutionResult): string {
  const content = Array.isArray(result.content) ? result.content : [];
  return content
    .map((item) => {
      if (isRecord(item) && item.type === "text" && typeof item.text === "string") {
        return item.text;
      }
      return "";
    })
    .join("");
}

/**
 * Rough size of a value in characters (strings count directly, everything else
 * is its JSON serialization; non-serializable values fall back to String()).
 */
function estimateChars(value: unknown): number {
  if (typeof value === "string") {
    return value.length;
  }

  if (value === null || value === undefined) {
    return 0;
  }

  try {
    return JSON.stringify(value).length;
  } catch {
    return String(value).length;
  }
}

const TRUNCATION_NOTICE_LINE_RE =
  /^\[(?:Showing lines \d|Use offset=|\d+ more lines in file|\d+ (?:results|entries|matches) limit reached|\d[\d.]*[KMG]?B limit reached|Some lines truncated to \d+ chars|Output truncated\b)/;

/** Split into trimmed non-empty lines, dropping the given sentinel strings and pi truncation notices. */
function splitNonEmptyLines(text: string, emptyMarkers: string[] = []): string[] {
  const trimmed = text.trim();
  if (!trimmed || emptyMarkers.includes(trimmed)) {
    return [];
  }

  return trimmed
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .filter((line) => !TRUNCATION_NOTICE_LINE_RE.test(line));
}

/**
 * Returns the tool's text output with truncation notices removed.
 *
 * Prefer pi's structured details over notice-format knowledge. A truncation
 * detail carries the exact pre-notice content; result/entry/match limit details
 * confirm that pi appended one trailing bracketed notice, which can then be
 * removed without interpreting its wording. Regex filtering is only the
 * compatibility fallback for hosts that omit structured details.
 */
function extractCleanText(result: ToolExecutionResult, limitDetailKeys: string[] = []): string {
  const text = extractTextContent(result);
  if (!isRecord(result.details)) {
    return text;
  }
  const details = result.details;

  if (isRecord(details.truncation) && typeof details.truncation.content === "string") {
    return details.truncation.content;
  }

  if (limitDetailKeys.some((key) => typeof details[key] === "number")) {
    return text.replace(/(?:\r?\n)+\[[^\r\n]*\]\s*$/, "");
  }

  return text;
}

interface ParsedGrepMatch {
  [key: string]: unknown;
  path: string;
  line: number;
  text: string;
  kind: "match" | "context";
}

/** Parses a `path:line: text` (match) or `path-line- text` (context) line relative to a known path. */
function parseGrepLineRelativeTo(line: string, filePath: string): ParsedGrepMatch | null {
  const colonPrefix = `${filePath}:`;
  if (line.startsWith(colonPrefix)) {
    const match = line.slice(colonPrefix.length).match(/^(\d+):\s?(.*)$/);
    if (match) {
      return { path: filePath, line: Number.parseInt(match[1], 10), text: match[2], kind: "match" };
    }
  }

  const hyphenPrefix = `${filePath}-`;
  if (line.startsWith(hyphenPrefix)) {
    const match = line.slice(hyphenPrefix.length).match(/^(\d+)-\s?(.*)$/);
    if (match) {
      return { path: filePath, line: Number.parseInt(match[1], 10), text: match[2], kind: "context" };
    }
  }

  return null;
}

/**
 * Best-effort parse of one grep output line without a known file anchor.
 * Match lines anchor on the last `:<digits>:` and context lines on the last
 * `-<digits>-`; returns null when the line fits neither shape.
 */
function parseGrepLineGeneric(line: string): ParsedGrepMatch | null {
  // Match lines: anchor on the LAST `:<digits>:` so paths containing
  // hyphen-digit segments (`v2-2024-report.md:12: x`) are not split early.
  const match = line.match(/^(.*):(\d+):\s?(.*)$/);
  if (match) {
    return {
      path: match[1],
      line: Number.parseInt(match[2], 10),
      text: match[3],
      kind: "match",
    };
  }

  // Context lines use `path-line- text`; the greedy path keeps hyphen-digit
  // paths whole (pi never emits a bare `-` separator before the line number).
  const context = line.match(/^(.+)-(\d+)-\s?(.*)$/);
  if (context) {
    return {
      path: context[1],
      line: Number.parseInt(context[2], 10),
      text: context[3],
      kind: "context",
    };
  }

  return null;
}

/**
 * Parse pi's grep text output back into structured matches: continuation lines
 * are resolved against the most recently confirmed path, and "No matches found"
 * yields an empty list.
 */
function parseGrepMatches(text: string): Array<Record<string, unknown>> {
  const trimmed = text.trim();
  if (!trimmed || trimmed === "No matches found") {
    return [];
  }

  const matches: Array<Record<string, unknown>> = [];
  let currentPath: string | null = null;

  for (const line of trimmed.split(/\r?\n/)) {
    // Prefer parsing relative to the most recently confirmed path: anchoring on
    // the known path keeps paths with `:digits:` / `-digits-` segments intact.
    if (currentPath !== null) {
      const relative = parseGrepLineRelativeTo(line, currentPath);
      if (relative) {
        matches.push(relative);
        continue;
      }
    }
    const generic = parseGrepLineGeneric(line);
    if (generic) {
      currentPath = generic.path;
      matches.push(generic);
    }
  }

  return matches;
}

/**
 * Convert a host tool result into the plain JSON value a cell receives via the
 * RPC bridge. Results carrying `details.ptcValue` pass through untouched; known
 * builtin tools get typed shapes (find/ls → string lists, grep → {matches,
 * matchLimitReached}, bash → {stdout, stderr, exitCode}, edit/write → summaries
 * with optional diff); anything else degrades to its raw text. `estimatedChars`
 * is the approximate serialized size of `value`.
 */
export function normalizeToolResult(toolName: string, result: ToolExecutionResult): NormalizedToolResult {
  if (isRecord(result.details) && "ptcValue" in result.details) {
    const ptcValue = result.details.ptcValue;
    return {
      value: ptcValue,
      estimatedChars: estimateChars(ptcValue),
    };
  }

  const text = extractTextContent(result);

  switch (toolName) {
    case "read":
      return { value: text, estimatedChars: text.length };

    case "find":
    case "glob": {
      const lines = splitNonEmptyLines(extractCleanText(result, ["resultLimitReached"]), ["No files found matching pattern"]);
      return { value: lines, estimatedChars: estimateChars(lines) };
    }

    case "ls": {
      const lines = splitNonEmptyLines(extractCleanText(result, ["entryLimitReached"]), ["(empty directory)"]);
      return { value: lines, estimatedChars: estimateChars(lines) };
    }

    case "grep": {
      const matches = parseGrepMatches(extractCleanText(result, ["matchLimitReached"]));
      // Surface pi's structured truncation signal so Python can tell truncated
      // result sets from complete ones (review item M3).
      const matchLimitReached =
        isRecord(result.details) && typeof result.details.matchLimitReached === "number"
          ? result.details.matchLimitReached
          : null;
      const value = { matches, matchLimitReached };
      return { value, estimatedChars: estimateChars(value) };
    }

    case "bash": {
      const value = {
        stdout: text,
        stderr: "",
        exitCode: 0,
      };
      return { value, estimatedChars: estimateChars(value) };
    }

    case "edit": {
      const diff = isRecord(result.details) && typeof result.details.diff === "string" ? result.details.diff : null;
      const value = {
        ok: true,
        summary: text,
        diff,
      };
      return { value, estimatedChars: estimateChars(value) };
    }

    case "write": {
      const value = {
        ok: true,
        summary: text,
      };
      return { value, estimatedChars: estimateChars(value) };
    }

    default:
      return { value: text, estimatedChars: text.length };
  }
}
