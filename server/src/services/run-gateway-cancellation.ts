import { and, asc, eq, inArray } from "drizzle-orm";
import { toolActionRequests, toolInvocations, type Db } from "@paperclipai/db";
import { notifyToolReviewChange } from "./tool-review-work-notifications.js";

/** The caller holds the run row lock in the cancellation transaction. */
export async function cancelGatewayActionsForRun(tx: Db, companyId: string, runId: string) {
  const origins = await tx.select({ id: toolInvocations.id }).from(toolInvocations)
    .where(and(eq(toolInvocations.companyId, companyId), eq(toolInvocations.runId, runId)))
    .orderBy(asc(toolInvocations.id));
  if (!origins.length) return;
  await notifyToolReviewChange(tx, companyId);
  for (const origin of origins) {
    const [invocation] = await tx.select().from(toolInvocations).where(and(
      eq(toolInvocations.id, origin.id), eq(toolInvocations.companyId, companyId), eq(toolInvocations.runId, runId),
    )).for("update");
    if (!invocation) continue;
    const requests = await tx.select().from(toolActionRequests).where(and(
      eq(toolActionRequests.companyId, companyId), eq(toolActionRequests.invocationId, invocation.id),
      inArray(toolActionRequests.status, ["pending", "approved", "executing"]),
    )).orderBy(asc(toolActionRequests.id)).for("update");
    if (requests.length === 0 && ["awaiting_approval", "authorized", "executing"].includes(invocation.status)) {
      const uncertain = invocation.startedAt !== null;
      const now = new Date();
      await tx.update(toolInvocations).set({ status: uncertain ? "failed" : "cancelled",
        errorCode: uncertain ? "tool_execution_outcome_unknown" : "originating_run_cancelled",
        errorMessage: uncertain ? "Cancellation followed dispatch admission; inspect the provider before retrying." : "The originating run was cancelled before dispatch.",
        completedAt: now, updatedAt: now }).where(eq(toolInvocations.id, invocation.id));
    }
    for (const request of requests) {
      const terminal = ["succeeded", "failed", "denied", "timed_out", "rate_limited", "cancelled"].includes(invocation.status);
      if (terminal) {
        // A crash can leave the review row open after the invocation settled.
        // Preserve the known outcome and remove the reusable signed payload.
        const status = invocation.status === "succeeded" ? "executed" : invocation.status === "cancelled" ? "cancelled" : "failed";
        await tx.update(toolActionRequests).set({ status, signedArguments: null,
          resolvedAt: invocation.completedAt ?? new Date(), updatedAt: new Date() }).where(eq(toolActionRequests.id, request.id));
        continue;
      }
      const uncertain = invocation.startedAt !== null;
      const now = new Date();
      await tx.update(toolInvocations).set({ status: uncertain ? "failed" : "cancelled",
        errorCode: uncertain ? "tool_execution_outcome_unknown" : "originating_run_cancelled",
        errorMessage: uncertain ? "Cancellation followed dispatch admission; inspect the provider before retrying." : "The originating run was cancelled before dispatch.",
        completedAt: now, updatedAt: now }).where(eq(toolInvocations.id, invocation.id));
      await tx.update(toolActionRequests).set({ status: uncertain ? "failed" : "cancelled", signedArguments: null,
        resolvedAt: now, updatedAt: now }).where(eq(toolActionRequests.id, request.id));
    }
  }
}
