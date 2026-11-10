import { and, asc, eq, gt, lte } from "drizzle-orm";
import { toolActionRequests, toolInvocations, type Db } from "@paperclipai/db";
import { writeToolReviewChange } from "./tool-review-work-notifications.js";

const STALE_EXECUTION_MS = 10 * 60_000;

export function toolReviewInterruptionService(db: Db, onSettled: (input: {
  actionRequestId: string;
  invocationId: string;
  status: "executed" | "failed";
  errorCode: string | null;
  errorMessage: string | null;
  resultSummary?: string;
}) => Promise<void>) {
  return {
    async next(): Promise<number | null> {
      const [row] = await db.select({ at: toolActionRequests.updatedAt }).from(toolActionRequests)
        .where(eq(toolActionRequests.status, "executing")).orderBy(asc(toolActionRequests.updatedAt)).limit(1);
      return row ? row.at.getTime() + STALE_EXECUTION_MS : null;
    },
    async sweep(now = new Date()) {
      const staleAt = new Date(now.getTime() - STALE_EXECUTION_MS);
      let cursor: string | undefined;
      let scanned = 0;
      for (;;) {
        const rows = await db.select().from(toolActionRequests).where(and(
          eq(toolActionRequests.status, "executing"), lte(toolActionRequests.updatedAt, staleAt),
          cursor ? gt(toolActionRequests.id, cursor) : undefined,
        )).orderBy(asc(toolActionRequests.id)).limit(100);
        for (const row of rows) {
          const settled = await writeToolReviewChange(db, row.companyId, async tx => {
            const [invocation] = await tx.select().from(toolInvocations)
              .where(eq(toolInvocations.id, row.invocationId)).for("update");
            const [request] = await tx.select().from(toolActionRequests)
              .where(eq(toolActionRequests.id, row.id)).for("update");
            if (!invocation || request?.status !== "executing" ||
              request.updatedAt.getTime() !== row.updatedAt.getTime()) return null;
            const completed = ["succeeded", "failed", "denied", "timed_out", "rate_limited", "cancelled"].includes(invocation.status);
            const status = invocation.status === "succeeded" ? "executed" as const : "failed" as const;
            const errorCode = completed ? invocation.errorCode : "tool_execution_outcome_unknown";
            const errorMessage = completed ? invocation.errorMessage
              : "Execution was interrupted; the external outcome is unknown. Inspect the provider before retrying.";
            if (!completed) {
              await tx.update(toolInvocations).set({ status: "failed", errorCode, errorMessage,
                completedAt: now, updatedAt: now }).where(eq(toolInvocations.id, row.invocationId));
            }
            await tx.update(toolActionRequests).set({ status, resolvedAt: invocation.completedAt ?? now, updatedAt: now })
              .where(eq(toolActionRequests.id, row.id));
            return { actionRequestId: row.id, invocationId: row.invocationId, status,
              errorCode, errorMessage, resultSummary: invocation.resultSummary?.summary };
          });
          if (settled) await onSettled(settled);
        }
        scanned += rows.length;
        if (rows.length < 100) break;
        cursor = rows[rows.length - 1].id;
      }
      return { scanned };
    },
  };
}
