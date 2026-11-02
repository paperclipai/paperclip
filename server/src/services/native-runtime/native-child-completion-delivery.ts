import { and, eq, inArray, isNull, ne, or, sql } from "drizzle-orm";
import { agentWakeupRequests, type Db } from "@paperclipai/db";

export interface NativeChildCompletionRecipient {
  companyId: string;
  issueId: string;
  agentId: string;
  runId: string;
  sourceIntentId: string | null;
}

/** New child results belong to a fresh parent turn, including across a Done claim. */
export async function hasPendingNativeChildCompletion(db: Db, input: NativeChildCompletionRecipient) {
  const [pending] = await db.select({ id: agentWakeupRequests.id }).from(agentWakeupRequests).where(and(
    eq(agentWakeupRequests.companyId, input.companyId),
    eq(agentWakeupRequests.agentId, input.agentId),
    or(eq(agentWakeupRequests.reason, "issue_children_completed"),
      and(eq(agentWakeupRequests.reason, "issue_execution_deferred"),
        sql`${agentWakeupRequests.payload}->'_paperclipWakeContext'->>'wakeReason' = 'issue_children_completed'`)),
    eq(agentWakeupRequests.requestedByActorType, "system"),
    or(eq(agentWakeupRequests.requestedByActorId, "native-status-committer"),
      sql`${agentWakeupRequests.requestedByActorId} like 'native-status-wake-dispatch:%'`),
    inArray(agentWakeupRequests.status, ["queued", "claimed", "deferred_issue_execution"]),
    sql`${agentWakeupRequests.payload}->>'issueId' = ${input.issueId}`,
    sql`nullif(${agentWakeupRequests.payload}->'_paperclipWakeContext'->>'nativeChildCompletionDecisionId', '') is not null`,
    or(isNull(agentWakeupRequests.runId), ne(agentWakeupRequests.runId, input.runId)),
    input.sourceIntentId ? ne(agentWakeupRequests.id, input.sourceIntentId) : undefined,
  )).limit(1);
  return Boolean(pending);
}
