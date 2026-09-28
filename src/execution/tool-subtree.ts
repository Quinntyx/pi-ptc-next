import type { Theme } from "@earendil-works/pi-coding-agent";
import type { NestedToolCallRecord } from "../contracts/execution-types";

const MAX_RENDERED_CALLS = 12;

/**
 * Subtree renderer for the Pi tools a cell called through the RPC bridge — the
 * tool-call analogue of the subagent panel. One line per call with a short
 * target summary and the outcome; grouped rendering stays the host's job.
 */
export function renderNestedToolTree(
  records: NestedToolCallRecord[] | undefined,
  theme: Theme | undefined
): string[] {
  if (!records || records.length === 0) return [];
  const paint = (color: Parameters<Theme["fg"]>[0], text: string) =>
    theme ? theme.fg(color, text) : text;

  const lines: string[] = [paint("muted", `tools (${records.length} call${records.length === 1 ? "" : "s"})`)];
  const shown = records.slice(0, MAX_RENDERED_CALLS);
  for (const record of shown) {
    const glyph = record.ok ? paint("success", "✓") : paint("error", "!");
    const ms = typeof record.ms === "number" && record.ms >= 0 ? paint("muted", ` ${formatMs(record.ms)}`) : "";
    const target = record.target ? paint("muted", ` ${record.target}`) : "";
    lines.push(`  ↳ ${record.name}${target} ${glyph}${ms}`);
  }
  const hidden = records.length - shown.length;
  if (hidden > 0) {
    lines.push(paint("muted", `  … ${hidden} more call${hidden === 1 ? "" : "s"}`));
  }
  return lines;
}

function formatMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1).replace(/\.0$/, "")}s`;
}
