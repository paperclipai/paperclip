import { sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";

/**
 * A direct owner-chat turn may edit its own instructions, subject to the normal
 * instruction permissions. Inherited responsible-user identity is not consent.
 * Keep this authority out of trust policies and task inheritance entirely.
 */
export async function hasOwnerChatInstructionAuthority(
  db: Pick<Db, "execute">,
  input: { companyId: string; agentId: string; runId?: string | null; userId?: string | null },
): Promise<boolean> {
  if (!input.runId || !input.userId) return false;
  const [authorized] = await db.execute<{ id: string }>(sql`
    WITH RECURSIVE current_chat AS (
      SELECT i.id, i.conversation_session_generation AS generation,
        i.conversation_boundary_comment_id AS boundary_comment_id,
        r.id AS run_id, identity.id AS identity_id
      FROM heartbeat_runs r
      JOIN issues i ON i.id::text = coalesce(r.context_snapshot->>'issueId', r.context_snapshot->>'taskId')
        AND i.company_id = r.company_id AND i.assignee_agent_id = r.agent_id
      JOIN run_identity_contexts identity ON identity.id = r.active_identity_context_id
        AND identity.run_id = r.id AND identity.company_id = r.company_id AND identity.status = 'accepted'
      WHERE r.id = ${input.runId}::uuid AND r.company_id = ${input.companyId}::uuid
        AND r.agent_id = ${input.agentId}::uuid
        -- Completed executions still collect their registered private edits.
        -- Cancellation and a chat reset revoke this exception.
        AND r.status IN ('running', 'succeeded', 'failed', 'timed_out')
        AND i.conversation_agent_id = r.agent_id AND i.conversation_user_id = ${input.userId}
        AND identity.responsible_user_id = ${input.userId} AND r.responsible_user_id = ${input.userId}
        AND coalesce(r.context_snapshot->>'conversationSessionGeneration', '0') = i.conversation_session_generation::text
    ), task_runs AS (
      SELECT r.id, r.retry_of_run_id
      FROM heartbeat_runs r JOIN current_chat c ON c.run_id = r.id
      UNION
      SELECT parent.id, parent.retry_of_run_id
      FROM heartbeat_runs parent JOIN task_runs child ON parent.id = child.retry_of_run_id
      JOIN current_chat c ON c.id::text = coalesce(parent.context_snapshot->>'issueId', parent.context_snapshot->>'taskId')
      WHERE parent.company_id = ${input.companyId}::uuid AND parent.agent_id = ${input.agentId}::uuid
        AND parent.status IN ('running', 'succeeded', 'failed', 'timed_out')
        AND coalesce(parent.context_snapshot->>'conversationSessionGeneration', '0') = c.generation::text
    ), instruction_identity AS (
      SELECT identity.id, identity.parent_context_id, identity.message_id
      FROM run_identity_contexts identity JOIN current_chat c ON c.identity_id = identity.id
      UNION
      SELECT parent.id, parent.parent_context_id, parent.message_id
      FROM run_identity_contexts parent JOIN instruction_identity child ON parent.id = child.parent_context_id
      WHERE child.message_id IS NULL AND parent.run_id IN (SELECT id FROM task_runs)
        AND parent.company_id = ${input.companyId}::uuid AND parent.status = 'accepted'
        AND parent.responsible_user_id = ${input.userId}
    )
    SELECT c.id FROM current_chat c
    WHERE EXISTS (
      SELECT 1 FROM agent_wakeup_requests w
      JOIN issue_comments message ON message.company_id = w.company_id AND message.issue_id = c.id
        AND message.author_user_id = ${input.userId} AND message.author_agent_id IS NULL
        AND message.deleted_at IS NULL
        -- Ordinary messages have no generation; /new records the boundary.
        AND (message.conversation_session_generation IS NULL OR message.conversation_session_generation = c.generation)
        AND (c.boundary_comment_id IS NULL OR EXISTS (
          SELECT 1 FROM issue_comments boundary WHERE boundary.id = c.boundary_comment_id
            AND boundary.company_id = w.company_id AND boundary.issue_id = c.id
            AND (message.created_at, message.id) >= (boundary.created_at, boundary.id)
        ))
        AND (message.id::text = coalesce(w.payload->>'commentId', w.payload->'_paperclipWakeContext'->>'wakeCommentId')
          OR (jsonb_typeof(w.payload #> '{_paperclipWakeContext,wakeCommentIds}') = 'array'
            AND (w.payload #> '{_paperclipWakeContext,wakeCommentIds}') ? message.id::text))
      WHERE w.run_id IN (SELECT id FROM task_runs)
        AND w.company_id = ${input.companyId}::uuid AND w.agent_id = ${input.agentId}::uuid
        AND w.requested_by_actor_type = 'user' AND w.requested_by_actor_id = ${input.userId}
        AND w.status NOT IN ('skipped', 'cancelled')
        AND w.payload->'_paperclipWakeContext'->>'source' IN ('issue.comment', 'issue.comment.reopen', 'issue.update')
        AND coalesce(w.payload->>'issueId', w.payload->>'taskId',
          w.payload->'_paperclipWakeContext'->>'issueId', w.payload->'_paperclipWakeContext'->>'taskId') = c.id::text
        AND (w.idempotency_key IS NULL OR w.idempotency_key NOT LIKE 'chat-inbound:%')
        -- Use the current instruction, never an earlier message superseded by
        -- another sender. Retries follow their precise accepted identity chain,
        -- and only through server-linked retries of this same chat session.
        AND message.id IN (SELECT message_id FROM instruction_identity)
    )
  `);
  return Boolean(authorized);
}
