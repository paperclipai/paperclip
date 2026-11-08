import { and, eq, inArray, sql } from "drizzle-orm";
import { heartbeatRuns, issueComments, type Db } from "@paperclipai/db";

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
 */
export async function deliveredQueuedCommentIds(tx: Pick<Db, "select">, input: {
  companyId: string; issueId: string; agentId: string; commentIds: string[];
}): Promise<Set<string>> {
  if (input.commentIds.length === 0) return new Set();
  const { companyId, issueId } = input;
  const rows = await tx.select({ id: issueComments.id }).from(issueComments).where(and(
    eq(issueComments.companyId, companyId), eq(issueComments.issueId, issueId),
    inArray(issueComments.id, input.commentIds),
    sql`exists (select 1 from ${heartbeatRuns} delivered_run
      where delivered_run.company_id = ${companyId} and delivered_run.agent_id = ${input.agentId}
        and delivered_run.status = 'succeeded'
        and (delivered_run.native_issue_id = ${issueId} or delivered_run.context_snapshot->>'issueId' = ${issueId})
        and delivered_run.started_at > ${issueComments.createdAt}
        and delivered_run.started_at >= ${issueComments.updatedAt}
        and (coalesce(delivered_run.context_snapshot->'wakeCommentIds', '[]'::jsonb) ? ${issueComments.id}::text
          or (delivered_run.retry_of_run_id is not null and jsonb_path_exists(delivered_run.context_snapshot, '$.executionContinuation.messages[*] ? (@.id == $id)',
            jsonb_build_object('id', ${issueComments.id}::text))
          or jsonb_path_exists(delivered_run.context_snapshot, '$.paperclipWake.messages[*] ? (@.id == $id)',
            jsonb_build_object('id', ${issueComments.id}::text)))))`,
  ));
  return new Set(rows.map(row => row.id));
}
