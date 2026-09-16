import type { Theme } from "@mariozechner/pi-coding-agent";
import type { SubagentRuntimeSnapshot } from "../contracts/execution-types";
// Shimmer sweep (pi-tool-tree style): a highlight band slides across the word.
function shimmerWord(word: string, theme: Theme, now: number): string {
  if (!word) return "";
  const step = Math.floor(now / 120);
  const n = word.length;
  const head = (step % (n + 6)) - 3;
  let out = "";
  for (let i = 0; i < n; i++) {
    const dist = Math.abs(i - head);
    if (dist <= 1) {
      out += theme.fg("accent", word[i]!);
    } else if (dist <= 3) {
      out += theme.fg("accent", word[i]!);
    } else {
      out += word[i]!;
    }
  }
  return out;
}

const PTC_CTX_LIMIT_FALLBACK = 200_000;

function formatCtx(ctx: { tokens?: number | null; limit?: number | null; percent?: number | null } | null | undefined, theme: Theme): string {
  if (!ctx || ctx.tokens === undefined || ctx.tokens === null) return "";
  const tokens = ctx.tokens;
  const fmt = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}m` : `${Math.round(n / 1000)}k`);
  const limit = ctx.limit ?? 200_000;
  const percent = ctx.percent !== undefined && ctx.percent !== null ? Math.round(ctx.percent) : Math.round((tokens / limit) * 100);
  return theme.fg("muted", ` · ctx ${fmt(tokens)}/${fmt(limit)} (${percent}%)`);
}

function formatAgentSeconds(ms: number | undefined | null): string {
  if (ms === undefined || ms === null) return "";
  if (ms < 1000) return "<1s";
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1).replace(/\.0$/, "")}s`;
  return `${Math.floor(s / 60)}m ${String(Math.floor(s % 60)).padStart(2, "0")}s`;
}

function agentCallsSegment(calls: number | null | undefined, theme: Theme): string {
  if (!calls) return "";
  return theme.fg("muted", ` · ${calls} tool call${calls === 1 ? "" : "s"}`);
}

function renderSubagentFan(snapshot: SubagentRuntimeSnapshot | undefined, theme: Theme): string[] {
  if (!snapshot || !Array.isArray(snapshot.agents) || snapshot.agents.length === 0) {
    return [];
  }

  const now = snapshot.timestamp && Date.now() - snapshot.timestamp < 5_000 ? snapshot.timestamp : Date.now();
  const agents = snapshot.agents;
  const groups = snapshot.groups ?? {};
  const groupOrder: string[] = [];
  for (const agent of agents) {
    const group = agent.group ?? "";
    if (!groupOrder.includes(group)) groupOrder.push(group);
  }
  // ungrouped agents always render last
  const withEmpty = groupOrder.filter((g) => g !== "").concat(groupOrder.filter((g) => g === ""));

  const lines: string[] = [];
  const totals = snapshot.totals ?? {};
  for (const group of withEmpty) {
    const groupAgents = agents.filter((a) => (a.group ?? "") === group);
    const startedAt = groups[group] ?? Math.min(...groupAgents.map((a) => a.startedAt ?? now));
    if (group) {
  
      const runningCount = groupAgents.filter((a) => a.status === "running" || a.status === "starting").length;
      const head = runningCount > 0
        ? `${theme.fg("success", "●")} ${theme.fg("accent", group)} ${theme.fg("muted", `· ${formatAgentSeconds(now - startedAt)}`)}`
        : `${theme.fg("success", "●")} ${theme.fg("muted", group)} ${theme.fg("muted", `· ${formatAgentSeconds(now - startedAt)}`)}`;
      lines.push(`    ${head}`);
    }

    groupAgents.forEach((agent, index) => {
      const last = index === groupAgents.length - 1;
      const branch = last ? "╰" : "├";
      const rail = (s: string) => theme.fg("muted", s);
      const gutter = agent.awaited ? theme.fg("accent", "▶ ") : "    ";

      if (agent.status === "starting") {
        lines.push(`${gutter}${theme.fg("muted", branch)} ${theme.fg("muted", "○ " + agent.name)}`);
        lines.push(`    ${theme.fg("muted", last ? "  " : "│ ")}${theme.fg("muted", "╰ starting…")}`);
        lines.push("");
        return;
      }

      const running = agent.status === "running";
      const light = running ? theme.fg("success", "●") : agent.status === "settled" ? theme.fg("success", "✓") : theme.fg("warning", "!");

      // agent row: name · elapsed · tool calls · ctx
      const segments = [
        theme.fg("muted", `· ${formatAgentSeconds(agent.elapsedMs)}`),
        agentCallsSegment(agent.toolCalls, theme),
        formatCtx(agent.ctx, theme),
      ].filter(Boolean);
      lines.push(`${gutter}${theme.fg("muted", branch)} ${light} ${theme.fg("text", agent.name)} ${segments.join("")}`);

      // detail line: shimmering action word · label elapsed · calls · thinking · live tool
      const word = agent.label ?? agent.phase;
      const detailBits: string[] = [];
      if (word) {
        detailBits.push(running ? shimmerWord(word, theme, now) : theme.fg("muted", word));
      }
      if (agent.labelElapsedMs) {
        detailBits.push(theme.fg("muted", ` · ${formatAgentSeconds(agent.labelElapsedMs)}`));
      }
      if (agent.labelCalls) {
        detailBits.push(theme.fg("muted", ` · ${agent.labelCalls} tool call${agent.labelCalls === 1 ? "" : "s"}`));
      }
      if (agent.thinkingMs) {
        detailBits.push(theme.fg("muted", ` · thinking ${formatAgentSeconds(agent.thinkingMs)}`));
      }
      if (agent.liveTool) {
        detailBits.push(theme.fg("muted", ` · ${agent.liveTool.length > 48 ? `${agent.liveTool.slice(0, 45)}...` : agent.liveTool}`));
      }
      if (detailBits.length > 0) {
        const detailRail = last ? "  " : "│ ";
        lines.push(`    ${theme.fg("muted", detailRail)}${theme.fg("muted", "╰")} ${detailBits.join("")}`);
      }

      if (!last) {
        lines.push(`    ${theme.fg("muted", "│")}`);
      }
    });
    lines.push("");
  }

  // footer summary
  const running = totals.running ?? agents.filter((a) => a.status === "running" || a.status === "starting").length;
  const settled = totals.settled ?? agents.filter((a) => a.status === "settled").length;
  const failed = totals.failed ?? agents.filter((a) => ["failed", "dead", "stopped"].includes(a.status)).length;
  const parts: string[] = [];
  if (running) parts.push(theme.fg("success", `● ${running} running`));
  if (settled) parts.push(theme.fg("success", `✓ ${settled} done`));
  if (failed) parts.push(theme.fg("warning", `! ${failed} stopped/failed`));
  lines.push(theme.fg("muted", "subagents: ") + parts.join(theme.fg("muted", " · ")));
  return lines;
}

export function renderSubagentPanel(snapshot: SubagentRuntimeSnapshot | undefined, theme: Theme): string[] {
  return renderSubagentFan(snapshot, theme);
}
