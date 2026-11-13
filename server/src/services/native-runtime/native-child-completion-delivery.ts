import { and, eq, inArray, isNull, ne, or, sql } from "drizzle-orm";
import { agentWakeupRequests, heartbeatRunEvents, heartbeatRuns, statusDecisions, type Db } from "@paperclipai/db";
import { appendHeartbeatRunEvent } from "../heartbeat-run-events.js";

export interface NativeChildCompletionRecipient {
  companyId: string;
  issueId: string;
  agentId: string;
  runId: string;
  sourceIntentId: string | null;
}

export const CHILD_TASK_READ_EVENT = "child_task.read";

export async function recordChildTaskRead(db: Db, input: {
  companyId: string; agentId: string; runId: string; parentIssueId: string;
  children: ReadonlyArray<{ id: string; parentId: string | null; status: string; updatedAt: Date; lastStatusDecisionId?: string | null }>;
}): Promise<void> {
  const completed = input.children.filter(child => child.parentId === input.parentIssueId && child.status === "done");
  if (completed.length === 0) return;
  await appendHeartbeatRunEvent(db, { companyId: input.companyId, runId: input.runId, agentId: input.agentId,
    eventType: CHILD_TASK_READ_EVENT, stream: "system", level: "info",
    payload: { parentIssueId: input.parentIssueId,
      children: Object.fromEntries(completed.map(child => [child.id, { status: child.status, updatedAt: child.updatedAt.toISOString(),
        statusDecisionId: child.lastStatusDecisionId ?? null }])) } });
}

/** New child results belong to a fresh parent turn, including across a Done claim. */
export async function hasPendingNativeChildCompletion(db: Db, input: NativeChildCompletionRecipient) {
  const completedChildId = sql`coalesce(${agentWakeupRequests.payload}->>'completedChildIssueId',
    ${agentWakeupRequests.payload}->'_paperclipWakeContext'->>'completedChildIssueId')`;
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
    sql`${agentWakeupRequests.createdAt} >= coalesce((select ${heartbeatRuns.startedAt} from ${heartbeatRuns}
      where ${heartbeatRuns.id} = ${input.runId} and ${heartbeatRuns.companyId} = ${input.companyId}), '-infinity'::timestamptz)`,
    sql`not exists (select 1 from ${heartbeatRunEvents} child_read
      where child_read.company_id = ${input.companyId} and child_read.run_id = ${input.runId}
        and child_read.event_type = ${CHILD_TASK_READ_EVENT}
        and child_read.payload->>'parentIssueId' = ${input.issueId}
        and child_read.payload->'children'->(${completedChildId})->>'status' = 'done'
        and (child_read.payload->'children'->(${completedChildId})->>'statusDecisionId'
            = ${agentWakeupRequests.payload}->'_paperclipWakeContext'->>'nativeChildCompletionDecisionId'
          or (child_read.payload->'children'->(${completedChildId})->>'updatedAt')::timestamptz
            >= date_trunc('milliseconds', coalesce((select ${statusDecisions.createdAt} from ${statusDecisions}
              where ${statusDecisions.companyId} = ${input.companyId}
                and ${statusDecisions.id}::text = ${agentWakeupRequests.payload}->'_paperclipWakeContext'->>'nativeChildCompletionDecisionId'),
              ${agentWakeupRequests.createdAt}))))`,
    input.sourceIntentId ? ne(agentWakeupRequests.id, input.sourceIntentId) : undefined,
  )).limit(1);
  return Boolean(pending);
}
