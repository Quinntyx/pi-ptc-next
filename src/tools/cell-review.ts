import { Type } from "@sinclair/typebox";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { PythonSessionManager } from "../python-session-manager";
import type { PtcToolDefinition } from "../types";
import { withActivityLabel } from "../utils";

type ReviewDecision = { action: "approve" | "reject"; note?: string };
type Reviewer = (ctx: ExtensionContext, sessionId: string, code: string) => Promise<ReviewDecision>;

/** Review is a user decision, never execution or an exact-code permission token. */
export function createCellReviewTool(manager: PythonSessionManager, review: Reviewer): PtcToolDefinition {
  return withActivityLabel({
    name: "request_cell_review",
    label: "review cell",
    description:
      "Ask the user to review a cell without executing it. Supply exactly one of code, file, or notebook position n. Review substantial workflows and destructive operations before execution; minor repairs within the approved scope do not need another review. Never prompt when the user explicitly requested autonomous execution without prompts.",
    parameters: Type.Object({
      session_id: Type.Optional(Type.String({ description: "Kernel id; n defaults to the most recently used kernel." })),
      n: Type.Optional(Type.Integer({ minimum: 1, description: "1-based position of the notebook code cell to review." })),
      code: Type.Optional(Type.String({ description: "Complete Python cell body to review, without running it." })),
      file: Type.Optional(Type.String({ description: "Python file whose complete contents are shown for review." })),
    }),
    execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
      const { session_id: requestedId, n, code, file } = params as {
        session_id?: string; n?: number; code?: string; file?: string;
      };
      if ([n, code, file].filter((value) => value !== undefined).length !== 1) {
        return { content: [{ type: "text", text: "request_cell_review requires exactly one of code, file, or n." }],
          details: { approved: false }, isError: true };
      }
      let sessionId = requestedId;
      let source = code ?? "";
      try {
        if (n !== undefined) {
          sessionId ??= manager.list()[0]?.id;
          if (!sessionId || !manager.get(sessionId)) {
            throw new Error(sessionId ? `Unknown kernel ${sessionId}.` : "No live kernels. Provision one first.");
          }
          const preview = await manager.readCell(sessionId, n);
          const cell = preview.cells[0];
          if (!cell || cell.cellType !== "code") throw new Error("Only code cells can be reviewed.");
          source = cell.source;
        } else if (file !== undefined) {
          source = await fs.readFile(path.resolve(ctx.cwd, file), "utf8");
        }
        const decision = await review(ctx, sessionId ?? "unbound", source);
        const approved = decision.action === "approve";
        return {
          content: [{ type: "text", text: approved
            ? "Cell approved for the intended operation. Nothing was executed. Execute separately; small fixes within this scope do not require another review."
            : `Cell rejected. Nothing was executed.${decision.note ? ` User feedback: ${decision.note}` : ""}` }],
          details: { approved, rejected: !approved, note: decision.note, sessionId, n },
        };
      } catch (error) {
        return { content: [{ type: "text", text: `Cell review failed: ${error instanceof Error ? error.message : String(error)}` }],
          details: { approved: false, rejected: true, sessionId, n }, isError: true };
      }
    },
  });
}
