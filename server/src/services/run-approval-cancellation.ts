import { and, eq, inArray } from "drizzle-orm";
import { approvals, type Db } from "@paperclipai/db";
import { notifyApprovalWork } from "./approval-work-notifications.js";
import { persistActivity } from "./activity-log.js";
import { notifyToolReviewChange } from "./tool-review-work-notifications.js";

/** Caller must have updated and locked the run in the surrounding transaction. */
export async function cancelPendingRunApprovals(tx: Db, companyId: string, runId: string) {
  const pending = await tx.select({ id: approvals.id }).from(approvals).where(and(
    eq(approvals.companyId, companyId), eq(approvals.originRunId, runId),
    inArray(approvals.status, ["pending", "revision_requested"]),
  ));
  if (!pending.length) return [];
  await notifyToolReviewChange(tx, companyId);
  for (const approval of pending) await notifyApprovalWork(tx, companyId, { approvalId: approval.id });
  const now = new Date();
  const cancelled = await tx.update(approvals).set({ status: "cancelled", decisionNote: "Originating run cancelled", decidedAt: now, updatedAt: now })
    .where(and(eq(approvals.companyId, companyId), eq(approvals.originRunId, runId),
      inArray(approvals.status, ["pending", "revision_requested"])))
    .returning();
  for (const approval of cancelled) {
    await persistActivity(tx, { companyId, actorType: "system", actorId: "run_cancellation",
      action: "approval.cancelled", entityType: "approval", entityId: approval.id, runId,
      details: { reason: "originating_run_cancelled" } });
  }
  return cancelled;
}
