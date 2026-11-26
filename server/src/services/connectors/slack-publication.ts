import { sql, type SQL } from "drizzle-orm";
import { chatPublications, type Db } from "@paperclipai/db";

// ECMAScript String.trim whitespace, matching tool-send text comparison.
const trimCharacters = "\u0009\u000a\u000b\u000c\u000d\u0020\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff";
type PublicationMatch = {
  companyId: SQL; endpointId: SQL; conversationId: SQL;
  issueId: SQL; commentId: SQL; payload: SQL;
};

function matchingSlackSend(publication: PublicationMatch) {
  const p = publication;
  return sql`from chat_actions send
    join issue_comments comment on comment.id = ${p.commentId}
      and comment.company_id = ${p.companyId} and comment.issue_id = ${p.issueId}
    join chat_conversations conversation on conversation.id = ${p.conversationId}
      and conversation.company_id = ${p.companyId}
    where send.company_id = ${p.companyId} and send.endpoint_id = ${p.endpointId}
      and send.conversation_id = ${p.conversationId} and send.kind = 'slack_tool_write'
      and send.payload->'binding'->>'runId' = coalesce(comment.created_by_run_id, comment.derived_created_by_run_id)::text
      and send.payload->>'name' = 'slack_post_message'
      and coalesce(${p.payload}->>'interactionId', '') = ''
      and coalesce(${p.payload}->>'progressState', '') = ''
      and (case when jsonb_typeof(${p.payload}->'attachmentIds') = 'array'
        then jsonb_array_length(${p.payload}->'attachmentIds') else 0 end) = 0
      and send.payload->'args'->>'channel' = regexp_replace(conversation.external_conversation_id, '^slack:', '')
      and send.payload->'args'->>'thread_ts' = regexp_replace(conversation.external_thread_id, '^.*:', '')
      and btrim(send.payload->'args'->>'text', ${trimCharacters}) = btrim(${p.payload}->>'text', ${trimCharacters})`;
}

/** Dispatch and deadlines must agree about pending explicit Slack sends. */
export function unresolvedSlackPublicationCondition(): SQL {
  return sql`exists (select 1 ${matchingSlackSend({
    companyId: sql`${chatPublications.companyId}`, endpointId: sql`${chatPublications.endpointId}`,
    conversationId: sql`${chatPublications.conversationId}`, issueId: sql`${chatPublications.issueId}`,
    commentId: sql`${chatPublications.commentId}`, payload: sql`${chatPublications.payload}`,
  })} and send.status in ('received', 'processing', 'uncertain'))`;
}

/** Explicit sends suppress identical automatic finals, but not distinct content. */
export async function slackExplicitPublicationDuplicate(
  db: Db,
  publication: typeof chatPublications.$inferSelect,
) {
  const p = publication;
  if (!p.commentId || p.payload.interactionId || p.payload.progressState || p.payload.attachmentIds?.length) return null;
  const rows = await db.execute<{ status: string }>(sql`select send.status ${matchingSlackSend({
    companyId: sql`${p.companyId}::uuid`, endpointId: sql`${p.endpointId}::uuid`,
    conversationId: sql`${p.conversationId}::uuid`, issueId: sql`${p.issueId}::uuid`,
    commentId: sql`${p.commentId}::uuid`, payload: sql`${JSON.stringify(p.payload)}::jsonb`,
  })} and send.status in ('processed', 'received', 'processing', 'uncertain')
    order by (send.status = 'processed') asc limit 1`);
  return rows[0] ? rows[0].status === "processed" ? "delivered" : "unresolved" : null;
}
