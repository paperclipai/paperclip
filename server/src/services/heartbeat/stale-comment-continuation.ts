import { agentWakeupRequests, heartbeatRuns, issueComments, type Db } from "@paperclipai/db";
import { and, eq, inArray, sql } from "drizzle-orm";
import { saveUndeliveredUserComments, taskClosedByAgentSql } from "../work-intent-outbox.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Work-intent outbox (invariant 4). A user's message can wake its own queued
 * run while an earlier run of the task is still finishing. When that earlier
 * run completes the task first, the queued run reaches a done task and is
 * cancelled as a stale continuation before dispatch, but the earlier run never
 * read the message. Cancelling it alone would drop the message (chaos
 * s9401/t72).
 *
 * Before that cancellation, the message's undelivered comments are saved as a
 * deferred receipt of the same user. The run's cancellation releases the task,
 * and the release drain reopens the done task for the user's message and
 * delivers it once. Only a task that an agent run completed without reading
 * the message qualifies: that run started before the comment and succeeded
 * after it. A task a person marked done ends the message's intent.
 * Returns the saved receipt id, or null when nothing is owed.
 */
export async function deferUndeliveredCommentsOfStaleRun(db: Db, run: typeof heartbeatRuns.$inferSelect): Promise<string | null> {
  const context = run.contextSnapshot && typeof run.contextSnapshot === "object" ? run.contextSnapshot as Record<string, unknown> : {};
  const issueId = typeof context.issueId === "string" ? context.issueId : null;
  const commentIds = Array.isArray(context.wakeCommentIds)
    ? context.wakeCommentIds.filter((id): id is string => typeof id === "string" && UUID.test(id)) : [];
  if (!issueId || !UUID.test(issueId) || commentIds.length === 0) return null;
  const unread = await db.select({ id: issueComments.id }).from(issueComments).where(and(
    eq(issueComments.companyId, run.companyId), eq(issueComments.issueId, issueId), inArray(issueComments.id, commentIds),
    sql`exists (select 1 from ${heartbeatRuns} completing where completing.company_id = ${run.companyId}
      and completing.agent_id = ${run.agentId} and completing.id <> ${run.id} and completing.status = 'succeeded'
      and (completing.context_snapshot->>'issueId' = ${issueId} or completing.native_issue_id = ${issueId})
      and completing.started_at < ${issueComments.createdAt} and completing.finished_at >= ${issueComments.createdAt})`));
  const owed = commentIds.filter(id => unread.some(row => row.id === id));
  if (owed.length === 0) return null;
  // An overlapping run is not proof the agent closed the task: a person can
  // mark it done while that run finishes. Only an agent-made close reopens.
  const [closed] = await db.execute<{ byAgent: boolean }>(sql`select ${taskClosedByAgentSql(run.companyId, issueId)} as "byAgent"`);
  if (closed?.byAgent !== true) return null;
  const [wake] = run.wakeupRequestId ? await db.select().from(agentWakeupRequests)
    .where(and(eq(agentWakeupRequests.companyId, run.companyId), eq(agentWakeupRequests.id, run.wakeupRequestId))) : [];
  return saveUndeliveredUserComments(db, { companyId: run.companyId, issueId, agentId: run.agentId, commentIds: owed,
    allowedStatuses: ["done"], requestedByActorId: wake?.requestedByActorType === "user" ? wake.requestedByActorId : null,
    source: wake?.source, triggerDetail: wake?.triggerDetail });
}
