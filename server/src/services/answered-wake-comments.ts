import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { issueComments } from "@paperclipai/db";

/** A later reply is proof only when its run received this exact automation comment. */
export async function automationWakeCommentsWereAnswered(db: Db, input: {
  companyId: string; issueId: string; agentId: string; commentIds: string[];
}): Promise<boolean> {
  const ids = [...new Set(input.commentIds)];
  if (ids.length === 0) return false;
  const answered = await db.select({ id: issueComments.id }).from(issueComments).where(and(
    eq(issueComments.companyId, input.companyId), eq(issueComments.issueId, input.issueId),
    inArray(issueComments.id, ids), isNull(issueComments.deletedAt),
    // Human and unattributed input always survives. A newer generic reply
    // must never silently consume feedback the agent may not have seen.
    sql`coalesce(${issueComments.authorAgentId}, ${issueComments.derivedAuthorAgentId}) is not null`,
    sql`exists (select 1 from issue_comments reply
      join heartbeat_runs receipt on receipt.id = coalesce(reply.created_by_run_id, reply.derived_created_by_run_id)
      where reply.company_id = ${input.companyId} and reply.issue_id = ${input.issueId}
        and reply.deleted_at is null and reply.created_at > ${issueComments.updatedAt}
        and coalesce(reply.author_agent_id, reply.derived_author_agent_id) = ${input.agentId}
        and receipt.company_id = ${input.companyId} and receipt.agent_id = ${input.agentId}
        and coalesce(receipt.context_snapshot->>'issueId', receipt.context_snapshot->>'taskId') = ${input.issueId}
        and (receipt.context_snapshot->>'wakeCommentId' = ${issueComments.id}::text
          or receipt.context_snapshot->>'commentId' = ${issueComments.id}::text
          or receipt.context_snapshot->'wakeCommentIds' ? ${issueComments.id}::text))`,
  ));
  return answered.length === ids.length;
}
