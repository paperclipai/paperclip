import { createWorker, getQueue, QUEUE_NAMES } from "../queue.js";
import type { Db } from "@paperclipai/db";
import { approvals } from "@paperclipai/db";
import { eq, and } from "drizzle-orm";

export interface ApproveTimerJobData {
  approvalId: string;
  companyId: string;
}

export function enqueueApproveTimer(approvalId: string, companyId: string, delayMinutes: number) {
  return getQueue(QUEUE_NAMES.APPROVE_TIMER).add(
    "auto-approve",
    { approvalId, companyId } satisfies ApproveTimerJobData,
    {
      delay: delayMinutes * 60 * 1000,
      jobId: `auto-approve-${approvalId}`,   // idempotent key
      removeOnComplete: true,
      removeOnFail: 5,
    },
  );
}

export function cancelApproveTimer(approvalId: string) {
  return getQueue(QUEUE_NAMES.APPROVE_TIMER).remove(`auto-approve-${approvalId}`);
}

export function startApproveTimerWorker(db: Db) {
  return createWorker(QUEUE_NAMES.APPROVE_TIMER, async (job) => {
    const { approvalId } = job.data as ApproveTimerJobData;

    // Atomic: only update if still pending
    const result = await db.update(approvals)
      .set({ status: "approved", resolvedVia: "auto", decidedAt: new Date() })
      .where(and(eq(approvals.id, approvalId), eq(approvals.status, "pending")))
      .returning();

    if (result.length > 0) {
      // Approval auto-approved — notification will be sent by notification router
      console.info(`[approve-timer] Auto-approved approval ${approvalId}`);
    }
    // If 0 rows: already resolved manually — no-op
  });
}
