import { and, eq, inArray, sql } from "drizzle-orm";
import { heartbeatRunEvents, heartbeatRuns, issueComments, type Db } from "@paperclipai/db";

/**
 * Per-comment consumption (work-intent outbox, invariant 4). A succeeded run
 * of the wake's agent that started after the comment's latest revision
 * consumed it when it received the comment as its own wake input, or when it
 * was a retry of an interrupted turn whose task history included the comment
 * (the retry re-reads the whole thread). Task history alone does not consume
 * a message saved for its own turn, and a run that was already running never
 * counts: its context can be refreshed after the fact, and an edit made after
 * it started is still unread. Every path that replays a saved message reads
 * this before delivering it.
 *
 * A run that took the message into its first provider turn
 * (`firstTurnQueuedInput`, sealed by that run before `turn.start`) consumed
 * it once the provider accepted that turn, whatever the run's later outcome.
 * Before acceptance the receipt proves nothing and the message stays queued.
 */
export async function deliveredQueuedCommentIds(tx: Pick<Db, "select">, input: {
  companyId: string; issueId: string; agentId: string; commentIds: string[];
}): Promise<Set<string>> {
  if (input.commentIds.length === 0) return new Set();
  const { companyId, issueId } = input;
  const rows = await tx.select({ id: issueComments.id }).from(issueComments).where(and(
    eq(issueComments.companyId, companyId), eq(issueComments.issueId, issueId),
    inArray(issueComments.id, input.commentIds),
    sql`(exists (select 1 from ${heartbeatRuns} delivered_run
      where delivered_run.company_id = ${companyId} and delivered_run.agent_id = ${input.agentId}
        and delivered_run.status = 'succeeded'
        and (delivered_run.native_issue_id = ${issueId} or delivered_run.context_snapshot->>'issueId' = ${issueId})
        and delivered_run.started_at > ${issueComments.createdAt}
        and delivered_run.started_at >= ${issueComments.updatedAt}
        and (coalesce(delivered_run.context_snapshot->'wakeCommentIds', '[]'::jsonb) ? ${issueComments.id}::text
          or (delivered_run.retry_of_run_id is not null and jsonb_path_exists(delivered_run.context_snapshot, '$.executionContinuation.messages[*] ? (@.id == $id)',
            jsonb_build_object('id', ${issueComments.id}::text))
          or jsonb_path_exists(delivered_run.context_snapshot, '$.paperclipWake.messages[*] ? (@.id == $id)',
            jsonb_build_object('id', ${issueComments.id}::text)))))
    or ${firstTurnDeliveredSql(companyId, issueId, input.agentId)})`,
  ));
  return new Set(rows.map(row => row.id));
}

/**
 * The comment row was taken into an accepted first provider turn of a run of
 * this agent on this task, and not edited after that run sealed its input.
 */
function firstTurnDeliveredSql(companyId: string, issueId: string, agentId: string) {
  return sql`exists (select 1 from ${heartbeatRuns} first_turn_run
      where first_turn_run.company_id = ${companyId} and first_turn_run.agent_id = ${agentId}
        and (first_turn_run.native_issue_id = ${issueId} or first_turn_run.context_snapshot->>'issueId' = ${issueId})
        and first_turn_run.context_snapshot->'firstTurnQueuedInput'->>'schema' = 'paperclip.first-turn-queued-input.v1'
        and first_turn_run.context_snapshot->'firstTurnQueuedInput'->>'runId' = first_turn_run.id::text
        and first_turn_run.context_snapshot->'firstTurnQueuedInput'->'commentIds' ? ${issueComments.id}::text
        and (first_turn_run.context_snapshot->'firstTurnQueuedInput'->>'claimedAt')::timestamptz >= date_trunc('milliseconds', ${issueComments.updatedAt})
        and exists (select 1 from ${heartbeatRunEvents} accepted
          where accepted.company_id = ${companyId} and accepted.run_id = first_turn_run.id
            and accepted.event_type in ('turn.accepted', 'turn.started')))`;
}

/** Ids that an accepted first provider turn already received (see `deliveredQueuedCommentIds`). */
export async function firstTurnDeliveredCommentIds(tx: Pick<Db, "select">, input: {
  companyId: string; issueId: string; agentId: string; commentIds: string[];
}): Promise<Set<string>> {
  if (input.commentIds.length === 0) return new Set();
  const rows = await tx.select({ id: issueComments.id }).from(issueComments).where(and(
    eq(issueComments.companyId, input.companyId), eq(issueComments.issueId, input.issueId),
    inArray(issueComments.id, input.commentIds), firstTurnDeliveredSql(input.companyId, input.issueId, input.agentId)));
  return new Set(rows.map(row => row.id));
}
