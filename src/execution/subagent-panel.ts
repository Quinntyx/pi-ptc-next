import type { Theme, ThemeColor } from "@mariozechner/pi-coding-agent";
import { shimmerText } from "./shimmer";
import type {
  SubagentAgentRow,
  SubagentPoolStageState,
  SubagentRuntimeSnapshot,
} from "../contracts/execution-types";

const PTC_CTX_LIMIT_FALLBACK = 200_000;
const MAX_QUEUED_ROWS = 2;
const TERMINAL_FAILURES = new Set(["failed", "dead", "stopped", "cancelled"]);

function paint(theme: Theme | undefined, color: ThemeColor, text: string): string {
  return theme ? theme.fg(color, text) : text;
}

function subdued(theme: Theme | undefined, text: string): string {
  // `dim` is explicitly the theme's "more subtle than muted" semantic color.
  return paint(theme, "dim", text);
}

/**
 * Shimmer sweep for a running action word. Uses the vendored painter
 * (`./shimmer.ts`, ported from pi-tool-tree) so the animation is identical
 * with or without that extension; falls back to muted paint without a theme.
 */
function shimmerWord(word: string, theme: Theme): string {
  if (!word) return "";
  if (!theme) return word;
  return shimmerText(word, theme);
}

function isDone(agent: SubagentAgentRow): boolean {
  return agent.status === "settled" || agent.status === "closed";
}

function isFailed(agent: SubagentAgentRow): boolean {
  return TERMINAL_FAILURES.has(agent.status);
}

function isIdle(agent: SubagentAgentRow): boolean {
  if (agent.status !== "running") return false;
  if (agent.idle === true) return true;
  // Defensive compatibility with snapshots produced before the explicit idle
  // bit: pi-tool-tree commonly reports this label between retained turns.
  return (agent.label ?? agent.phase)?.toLowerCase() === "idle";
}

function isExecuting(agent: SubagentAgentRow): boolean {
  return agent.status === "starting" || (agent.status === "running" && !isIdle(agent));
}

type AgentCtx = { tokens?: number | null; limit?: number | null; percent?: number | null };

function formatCtxValue(ctx: AgentCtx | null | undefined): string {
  if (!ctx || ctx.tokens === undefined || ctx.tokens === null) return "";
  const fmt = (n: number) =>
    n >= 1_000_000
      ? `${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}m`
      : `${Math.round(n / 1000)}k`;
  const limit = ctx.limit ?? PTC_CTX_LIMIT_FALLBACK;
  const calculatedPercent = limit > 0 ? Math.round((ctx.tokens / limit) * 100) : 0;
  const percent =
    ctx.percent !== undefined && ctx.percent !== null ? Math.round(ctx.percent) : calculatedPercent;
  return `ctx ${fmt(ctx.tokens)}/${fmt(limit)} (${percent}%)`;
}

function formatCtx(ctx: AgentCtx | null | undefined, theme?: Theme): string {
  const value = formatCtxValue(ctx);
  return value ? subdued(theme, ` · ${value}`) : "";
}

function formatAgentSeconds(ms: number | undefined | null): string {
  if (ms === undefined || ms === null) return "";
  const safeMs = Math.max(0, ms);
  const seconds = safeMs / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  return `${Math.floor(seconds / 60)}m ${String(Math.floor(seconds % 60)).padStart(2, "0")}s`;
}

function agentCallsSegment(calls: number | null | undefined, theme?: Theme): string {
  if (!calls) return "";
  return subdued(theme, ` · ${calls} tool call${calls === 1 ? "" : "s"}`);
}

function stageForGroup(
  snapshot: SubagentRuntimeSnapshot,
  group: string,
): SubagentPoolStageState | undefined {
  return (snapshot.pools ?? []).flatMap((pool) => pool.stages ?? []).find((stage) => stage.name === group);
}

function stageBusyMs(stage: SubagentPoolStageState, wallNow: number): number | null {
  if (stage.busyMs === undefined && stage.activeSince === undefined) return null;
  return Math.max(0, stage.busyMs ?? 0) +
    (stage.activeSince !== undefined && stage.activeSince !== null
      ? Math.max(0, wallNow - stage.activeSince)
      : 0);
}

function groupElapsedMs(
  snapshot: SubagentRuntimeSnapshot,
  group: string,
  agents: SubagentAgentRow[],
  startedAt: number,
  wallNow: number,
): number {
  const stage = stageForGroup(snapshot, group);
  if (stage) {
    const busy = stageBusyMs(stage, wallNow);
    if (busy !== null) return busy;
  }
  if (agents.some(isExecuting)) return Math.max(0, wallNow - startedAt);
  // No task is executing, so freeze at the furthest completed/busy endpoint
  // represented by this group rather than continuing to age the group itself.
  return Math.max(
    0,
    ...agents.map((agent) =>
      Math.max(0, (agent.startedAt ?? startedAt) + (agent.elapsedMs ?? agent.busyMs ?? 0) - startedAt),
    ),
  );
}

function sortAgents(agents: SubagentAgentRow[]): SubagentAgentRow[] {
  const rank = (agent: SubagentAgentRow): number => {
    if (agent.status === "starting" || agent.status === "running") return 0;
    if (agent.status === "queued") return 1;
    return 2;
  };
  return [...agents].sort(
    (a, b) => rank(a) - rank(b) || (a.startedAt ?? Number.MAX_SAFE_INTEGER) - (b.startedAt ?? Number.MAX_SAFE_INTEGER),
  );
}

/** Rows relevant to the exec currently being streamed. */
export function relevantAgents(
  snapshot: SubagentRuntimeSnapshot | undefined,
  execId?: string,
): SubagentAgentRow[] {
  if (!snapshot || !Array.isArray(snapshot.agents)) return [];
  if (!execId) return snapshot.agents;
  return snapshot.agents.filter(
    (agent) =>
      agent.execScope === execId ||
      agent.status === "running" ||
      agent.status === "starting" ||
      agent.status === "queued",
  );
}

function renderSubagentFan(
  snapshot: SubagentRuntimeSnapshot | undefined,
  theme: Theme,
  execId?: string,
): string[] {
  const declaredStages = (snapshot?.pools ?? [])
    .filter((pool) => pool.status !== "closed")
    .flatMap((pool) => pool.stages ?? []);
  if (!snapshot || !Array.isArray(snapshot.agents) || (snapshot.agents.length === 0 && declaredStages.length === 0)) {
    return [];
  }

  const wallNow = Date.now();
  const drift = snapshot.timestamp ? Math.max(0, wallNow - snapshot.timestamp) : 0;
  const agents = relevantAgents(snapshot, execId);
  if (agents.length === 0 && declaredStages.length === 0) return [];

  const totals = {
    queued: agents.filter((agent) => agent.status === "queued").length,
    running: agents.filter(isExecuting).length,
    idle: agents.filter(isIdle).length,
    settled: agents.filter(isDone).length,
    failed: agents.filter(isFailed).length,
  };
  const groups = snapshot.groups ?? {};
  const groupOrder: string[] = [];
  for (const agent of agents) {
    const group = agent.group ?? "";
    if (!groupOrder.includes(group)) groupOrder.push(group);
  }
  const orderedGroups = groupOrder.filter(Boolean).concat(groupOrder.filter((group) => !group));

  const lines: string[] = [];
  let queuedRowsShown = 0;
  let hiddenQueued = 0;
  for (const group of orderedGroups) {
    const allGroupAgents = sortAgents(agents.filter((agent) => (agent.group ?? "") === group));
    const groupAgents = allGroupAgents.filter((agent) => {
      if (agent.status !== "queued") return true;
      if (queuedRowsShown < MAX_QUEUED_ROWS) {
        queuedRowsShown += 1;
        return true;
      }
      hiddenQueued += 1;
      return false;
    });
    const startedAt = groups[group] ?? Math.min(...allGroupAgents.map((agent) => agent.startedAt ?? wallNow));
    if (group) {
      const executing = allGroupAgents.some(isExecuting);
      const elapsed = formatAgentSeconds(groupElapsedMs(snapshot, group, allGroupAgents, startedAt, wallNow));
      const head = executing
        ? `${theme.fg("success", "●")} ${theme.fg("accent", group)} ${subdued(theme, `· ${elapsed}`)}`
        : `${theme.fg("success", "●")} ${theme.fg("muted", group)} ${subdued(theme, `· ${elapsed}`)}`;
      lines.push(`    ${head}`);
    }

    groupAgents.forEach((agent, index) => {
      const last = index === groupAgents.length - 1;
      const branch = last ? "╰" : "├";
      const gutter = agent.awaited ? theme.fg("accent", "  ▶ ") : "    ";

      if (agent.status === "queued") {
        lines.push(`${gutter}${theme.fg("muted", branch)} ${theme.fg("muted", `… ${agent.name}`)}`);
        lines.push(`    ${theme.fg("muted", last ? "  " : "│ ")}${theme.fg("muted", "╰ waiting for a pool slot")}`);
        lines.push("");
        return;
      }

      if (agent.status === "starting") {
        lines.push(`${gutter}${theme.fg("muted", branch)} ${theme.fg("muted", `○ ${agent.name}`)}`);
        lines.push(`    ${theme.fg("muted", last ? "  " : "│ ")}${theme.fg("muted", "╰ starting…")}`);
        lines.push("");
        return;
      }

      const idle = isIdle(agent);
      const running = agent.status === "running" && !idle;
      const light = idle
        ? theme.fg("muted", "…")
        : running
          ? theme.fg("success", "●")
          : isDone(agent)
            ? theme.fg("success", "✓")
            : theme.fg("warning", "✗");
      const elapsedMs = (agent.elapsedMs ?? 0) + (running ? drift : 0);
      const labelElapsedMs =
        agent.labelElapsedMs === null || agent.labelElapsedMs === undefined
          ? null
          : agent.labelElapsedMs + (running ? drift : 0);

      const segments = [
        idle ? "" : subdued(theme, `· ${formatAgentSeconds(elapsedMs)}`),
        agentCallsSegment(agent.toolCalls, theme),
        formatCtx(agent.ctx, theme),
      ].filter(Boolean);
      lines.push(
        `${gutter}${theme.fg("muted", branch)} ${light} ${theme.fg("text", agent.name)}` +
          (segments.length ? ` ${segments.join("")}` : ""),
      );

      const detailBits: string[] = [];
      if (idle) {
        detailBits.push(theme.fg("muted", "idle · waiting for orchestrator"));
      } else {
        const word = agent.label ?? agent.phase;
        if (word) detailBits.push(running ? shimmerWord(word, theme) : theme.fg("muted", word));
        if (labelElapsedMs !== null && labelElapsedMs > 0) {
          detailBits.push(subdued(theme, ` · ${formatAgentSeconds(labelElapsedMs)}`));
        }
        if (agent.labelCalls) {
          detailBits.push(subdued(theme, ` · ${agent.labelCalls} tool call${agent.labelCalls === 1 ? "" : "s"}`));
        }
        if (agent.thinkingMs) {
          detailBits.push(subdued(theme, ` · thinking ${formatAgentSeconds(agent.thinkingMs)}`));
        }
        if (agent.liveTool) {
          const liveTool = agent.liveTool.length > 48 ? `${agent.liveTool.slice(0, 45)}...` : agent.liveTool;
          detailBits.push(subdued(theme, ` · ${liveTool}`));
        }
      }
      if (detailBits.length > 0) {
        lines.push(`    ${theme.fg("muted", last ? "  " : "│ ")}${theme.fg("muted", "╰")} ${detailBits.join("")}`);
      }
      if (!last) lines.push(`    ${theme.fg("muted", "│")}`);
    });
    lines.push("");
  }

  const renderedGroups = new Set(orderedGroups.filter(Boolean));
  for (const pool of snapshot.pools ?? []) {
    if (pool.status === "closed") continue;
    for (const stage of pool.stages ?? []) {
      if (renderedGroups.has(stage.name)) continue;
      renderedGroups.add(stage.name);
      const busy = stageBusyMs(stage, wallNow);
      const stageElapsed = formatAgentSeconds(busy ?? 0);
      lines.push(`    ${theme.fg("success", "✓")} ${theme.fg("muted", stage.name)} ${subdued(theme, `· ${stageElapsed}`)}`);
      const detail = stage.submitted === 0 ? "idle" : `${stage.settled}/${stage.submitted} done (earlier cell)`;
      lines.push(`    ${theme.fg("muted", "╰")} ${theme.fg("muted", detail)}`);
      lines.push("");
    }
  }

  if (hiddenQueued > 0) lines.push(theme.fg("muted", `    … ${hiddenQueued} more queued`));

  const parts: string[] = [];
  if (totals.queued) parts.push(theme.fg("muted", `… ${totals.queued} queued`));
  if (totals.running) parts.push(theme.fg("success", `● ${totals.running} running`));
  if (totals.idle) parts.push(theme.fg("muted", `… ${totals.idle} idle`));
  if (totals.settled) parts.push(theme.fg("success", `✓ ${totals.settled} done`));
  if (totals.failed) parts.push(theme.fg("warning", `✗ ${totals.failed} stopped/failed`));
  if (parts.length > 0) lines.push(theme.fg("muted", "subagents: ") + parts.join(theme.fg("muted", " · ")));
  return lines;
}

/**
 * Render the live subagent panel for the transcript: per-group headers with
 * elapsed time, one row per agent (status glyph, elapsed, tool calls, ctx
 * usage, current activity label), idle pool stages from earlier cells, and a
 * totals line. `execId` scopes rows to the exec currently being streamed.
 */
export function renderSubagentPanel(
  snapshot: SubagentRuntimeSnapshot | undefined,
  theme: Theme,
  execId?: string,
): string[] {
  return renderSubagentFan(snapshot, theme, execId);
}

function notificationGlyph(agent: SubagentAgentRow, theme?: Theme): string {
  if (isDone(agent)) return paint(theme, "success", "✓");
  if (isFailed(agent)) return paint(theme, "warning", "✗");
  if (isIdle(agent) || agent.status === "queued" || agent.status === "starting") {
    return paint(theme, "muted", "…");
  }
  return paint(theme, "success", "●");
}

/**
 * Transcript notification for a finished exec. Theme ANSI is preserved by
 * pi-tool-tree, matching the themed call site in index.ts.
 */
export function renderSubagentNotification(
  snapshot: SubagentRuntimeSnapshot | undefined,
  theme: Theme,
  execId?: string,
): string | null {
  const agents = relevantAgents(snapshot, execId);
  if (!snapshot || agents.length === 0) return null;

  const done = agents.filter(isDone).length;
  const failed = agents.filter(isFailed).length;
  const stillGoing = agents.filter((agent) => ["queued", "starting", "running"].includes(agent.status)).length;
  const headerBits = [`${done} done`];
  if (failed) headerBits.push(`${failed} failed`);
  if (stillGoing) headerBits.push(`${stillGoing} still working`);
  const headerGlyph = stillGoing
    ? paint(theme, "success", "●")
    : failed
      ? paint(theme, "warning", "✗")
      : paint(theme, "success", "✓");
  const lines = [`${headerGlyph} ${paint(theme, "text", "subagents")} ${subdued(theme, `· ${headerBits.join(" · ")}`)}`];

  const groups: string[] = [];
  for (const agent of agents) {
    const group = agent.group ?? "";
    if (!groups.includes(group)) groups.push(group);
  }
  const wallNow = Date.now();
  let queued = 0;
  for (const group of groups.filter(Boolean).concat(groups.filter((group) => !group))) {
    const grouped = sortAgents(agents.filter((agent) => (agent.group ?? "") === group));
    const visible = grouped.filter((agent) => {
      if (agent.status !== "queued") return true;
      queued += 1;
      return false;
    });
    if (group) {
      const startedAt = snapshot.groups?.[group] ?? Math.min(...grouped.map((agent) => agent.startedAt ?? wallNow));
      const executing = grouped.some(isExecuting);
      const elapsed = formatAgentSeconds(groupElapsedMs(snapshot, group, grouped, startedAt, wallNow));
      lines.push(
        `${paint(theme, "success", "●")} ` +
          `${paint(theme, executing ? "accent" : "muted", group)} ${subdued(theme, `· ${elapsed}`)}`,
      );
    }
    for (const agent of visible) {
      const bits = [formatAgentSeconds(agent.elapsedMs) || "—", `${agent.toolCalls || 0} tool calls`];
      if (agent.ctx?.tokens !== undefined && agent.ctx.tokens !== null) {
        bits.push(formatCtxValue(agent.ctx));
      } else if (agent.ctx?.percent !== undefined && agent.ctx.percent !== null) {
        bits.push(`ctx ${Math.round(agent.ctx.percent)}%`);
      }
      lines.push(
        `⎿ ${notificationGlyph(agent, theme)} ${paint(theme, "text", agent.name)} ${subdued(theme, `· ${bits.join(" · ")}`)}`,
      );
    }
  }
  if (queued > 0) lines.push(`⎿ ${paint(theme, "muted", `… ${queued} more queued`)}`);
  return lines.join("\n");
}
