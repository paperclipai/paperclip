import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { agentWakeupRequests, type Db } from "@paperclipai/db";
import { queuedCommentIdsFromWakePayload } from "./issue-queued-comment-queue.js";

export async function foldWaitingRetriesIntoContinuation(tx: Db, input: { companyId: string; issueId: string; runId: string }) {
  const waiting = await tx.select({ id: agentWakeupRequests.id, payload: agentWakeupRequests.payload }).from(agentWakeupRequests).where(and(
    eq(agentWakeupRequests.companyId, input.companyId), eq(agentWakeupRequests.status, "deferred_issue_execution"),
    eq(agentWakeupRequests.reason, "task_retry"), eq(agentWakeupRequests.requestedByActorType, "user"),
    isNull(agentWakeupRequests.runId), sql`${agentWakeupRequests.payload}->>'issueId' = ${input.issueId}`)).for("update");
  const retries = waiting.filter(wake => queuedCommentIdsFromWakePayload(wake.payload).length === 0).map(wake => wake.id);
  if (!retries.length) return;
  const now = new Date();
  await tx.update(agentWakeupRequests).set({ status: "coalesced", runId: input.runId, finishedAt: now, updatedAt: now,
    payload: sql`coalesce(${agentWakeupRequests.payload}, '{}'::jsonb) || ${JSON.stringify({ coalescedIntoFreshContinuationRun: input.runId })}::jsonb` })
    .where(and(eq(agentWakeupRequests.companyId, input.companyId), inArray(agentWakeupRequests.id, retries),
      eq(agentWakeupRequests.status, "deferred_issue_execution")));
}
