import type { Theme } from "@mariozechner/pi-coding-agent";
import type { SubagentAgentRow, SubagentRuntimeSnapshot } from "../contracts/execution-types";
/**
 * Shimmer sweep for a running action word, shared with the activity tree's label sweep
 * (published on pi-tool-tree's API). Renders muted when that extension is absent.
 */
function shimmerWord(word: string, theme: Theme): string {
	if (!word) return "";
	const activity = (globalThis as any)[Symbol.for("pi-tool-tree:api")];
	if (typeof activity?.shimmerText === "function") return activity.shimmerText(word, theme);
	return theme.fg("muted", word);
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

/**
 * Rows relevant to the exec currently being streamed. An interpreter can be
 * long-lived and its registry holds agents from earlier chunks (earlier PTC
 * calls), so the viewer keeps:
 *  - agents spawned in this exec, and
 *  - agents of earlier execs that are still running (their results are still
 *    awaited)
 * and drops everything settled before this exec began.
 */
export function relevantAgents(snapshot: SubagentRuntimeSnapshot | undefined, execId?: string): SubagentAgentRow[] {
  if (!snapshot || !Array.isArray(snapshot.agents)) {
    return [];
  }
  if (!execId) {
    return snapshot.agents; // no scoping context (e.g. the global runtime API)
  }
  return snapshot.agents.filter(
    (agent) =>
      agent.execScope === execId ||
      agent.status === "running" ||
      agent.status === "starting" ||
      agent.status === "queued",
  );
}

function renderSubagentFan(snapshot: SubagentRuntimeSnapshot | undefined, theme: Theme, execId?: string): string[] {
  if (!snapshot || !Array.isArray(snapshot.agents) || snapshot.agents.length === 0) {
    return [];
  }

  // Animation and elapsed time run on the wall clock. The snapshot's timestamp is
  // only used to extrapolate the values it carries: pinning `now` to it (as this
  // once did) froze the shimmer between snapshots, so it advanced at the ~1 Hz
  // rate of subagent_state frames instead of the repaint rate.
  const wallNow = Date.now();
  const drift = snapshot.timestamp ? Math.max(0, wallNow - snapshot.timestamp) : 0;
  const agents = relevantAgents(snapshot, execId);
  if (agents.length === 0) {
    return [];
  }
  // Totals describe the filtered view, not the whole (possibly long-lived)
  // interpreter registry.
  const totals = {
    queued: agents.filter((a) => a.status === "queued").length,
    running: agents.filter((a) => a.status === "running" || a.status === "starting").length,
    settled: agents.filter((a) => a.status === "settled").length,
    failed: agents.filter((a) => ["failed", "dead", "stopped", "cancelled"].includes(a.status)).length,
  };
  const groups = snapshot.groups ?? {};
  const groupOrder: string[] = [];
  for (const agent of agents) {
    const group = agent.group ?? "";
    if (!groupOrder.includes(group)) groupOrder.push(group);
  }
  // ungrouped agents always render last
  const withEmpty = groupOrder.filter((g) => g !== "").concat(groupOrder.filter((g) => g === ""));

  const lines: string[] = [];
  for (const group of withEmpty) {
    const groupAgents = agents.filter((a) => (a.group ?? "") === group);
    const startedAt = groups[group] ?? Math.min(...groupAgents.map((a) => a.startedAt ?? wallNow));
    if (group) {
  
      const runningCount = groupAgents.filter((a) => a.status === "running" || a.status === "starting").length;
      const head = runningCount > 0
        ? `${theme.fg("success", "●")} ${theme.fg("accent", group)} ${theme.fg("muted", `· ${formatAgentSeconds(wallNow - startedAt)}`)}`
        : `${theme.fg("success", "●")} ${theme.fg("muted", group)} ${theme.fg("muted", `· ${formatAgentSeconds(wallNow - startedAt)}`)}`;
      lines.push(`    ${head}`);
    }

    groupAgents.forEach((agent, index) => {
      const last = index === groupAgents.length - 1;
      const branch = last ? "╰" : "├";
      const rail = (s: string) => theme.fg("muted", s);
      const gutter = agent.awaited ? theme.fg("accent", "  ▶ ") : "    ";

      if (agent.status === "queued") {
        lines.push(`${gutter}${theme.fg("muted", branch)} ${theme.fg("muted", "… " + agent.name)}`);
        lines.push(`    ${theme.fg("muted", last ? "  " : "│ ")}${theme.fg("muted", "╰ waiting for a pool slot")}`);
        lines.push("");
        return;
      }

      if (agent.status === "starting") {
        lines.push(`${gutter}${theme.fg("muted", branch)} ${theme.fg("muted", "○ " + agent.name)}`);
        lines.push(`    ${theme.fg("muted", last ? "  " : "│ ")}${theme.fg("muted", "╰ starting…")}`);
        lines.push("");
        return;
      }

      const running = agent.status === "running";
      const light = running ? theme.fg("success", "●") : agent.status === "settled" ? theme.fg("success", "✓") : theme.fg("warning", "!");
      // Running values tick with the wall clock between snapshots; settled ones are final.
      const elapsedMs = (agent.elapsedMs ?? 0) + (running ? drift : 0);
      const labelElapsedMs =
        agent.labelElapsedMs === null || agent.labelElapsedMs === undefined
          ? null
          : agent.labelElapsedMs + (running ? drift : 0);

      // agent row: name · elapsed · tool calls · ctx
      const segments = [
        theme.fg("muted", `· ${formatAgentSeconds(elapsedMs)}`),
        agentCallsSegment(agent.toolCalls, theme),
        formatCtx(agent.ctx, theme),
      ].filter(Boolean);
      lines.push(`${gutter}${theme.fg("muted", branch)} ${light} ${theme.fg("text", agent.name)} ${segments.join("")}`);

      // detail line: shimmering action word · label elapsed · calls · thinking · live tool
      const word = agent.label ?? agent.phase;
      const detailBits: string[] = [];
      if (word) {
        detailBits.push(running ? shimmerWord(word, theme) : theme.fg("muted", word));
      }
      if (labelElapsedMs) {
        detailBits.push(theme.fg("muted", ` · ${formatAgentSeconds(labelElapsedMs)}`));
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
  const queued = totals.queued ?? 0;
  const running = totals.running ?? agents.filter((a) => a.status === "running" || a.status === "starting").length;
  const settled = totals.settled ?? agents.filter((a) => a.status === "settled").length;
  const failed = totals.failed ?? agents.filter((a) => ["failed", "dead", "stopped", "cancelled"].includes(a.status)).length;
  const parts: string[] = [];
  if (queued) parts.push(theme.fg("muted", `… ${queued} queued`));
  if (running) parts.push(theme.fg("success", `● ${running} running`));
  if (settled) parts.push(theme.fg("success", `✓ ${settled} done`));
  if (failed) parts.push(theme.fg("warning", `! ${failed} stopped/failed`));
  lines.push(theme.fg("muted", "subagents: ") + parts.join(theme.fg("muted", " · ")));
  return lines;
}

export function renderSubagentPanel(
  snapshot: SubagentRuntimeSnapshot | undefined,
  theme: Theme,
  execId?: string
): string[] {
  return renderSubagentFan(snapshot, theme, execId);
}
