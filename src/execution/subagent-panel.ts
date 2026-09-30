/**
 * Subagent snapshot helpers.
 *
 * The workflow-tree renderer (subagent fan panel, transcript notification) and
 * the nested tool subtree were removed from the output paths in the
 * notebook-output rework: finished cells now render through the notebook cell
 * renderer (src/execution/notebook-render.ts). The snapshot PLUMBING stays —
 * onSubagentSnapshot hooks, latestSnapshot storage, the status-bar footer —
 * and `relevantAgents` remains the shared filter for future re-rendering.
 */

import type { SubagentAgentRow, SubagentRuntimeSnapshot } from "../contracts/execution-types";

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
