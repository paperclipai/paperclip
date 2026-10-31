import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { agentWakeupRequests, type Db } from "@paperclipai/db";

export const reviewerIntentPredicate = sql`COALESCE(${agentWakeupRequests.payload} ? '_paperclipReviewerAssignmentContinuation', false)`;

export async function retireReviewerIntents(tx: Db, scope: { companyId: string; issueId: string; reason: string }) {
  const now = new Date();
  return tx.update(agentWakeupRequests).set({
    status: "cancelled", error: scope.reason, finishedAt: now, updatedAt: now,
  }).where(and(
    eq(agentWakeupRequests.companyId, scope.companyId),
    reviewerIntentPredicate,
    inArray(agentWakeupRequests.status, ["queued", "deferred_issue_execution", "claimed"]),
    isNull(agentWakeupRequests.runId),
    sql`${agentWakeupRequests.payload}->>'issueId' = ${scope.issueId}`,
  )).returning({ id: agentWakeupRequests.id });
}
