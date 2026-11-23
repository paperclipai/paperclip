import { finishedIdleRun, finishedIdleWake } from "./idle-work-proof.js";

/** The same positive container proof is used by ordinary and scheduled sleep.
 * waiting/in_review is set by settleConversationTurn, but is not sufficient:
 * a user comment may commit before the wake is enqueued. */
export function passiveIdleConversation(i: "i"): string {
  return `${i}.conversation_agent_id IS NOT NULL AND length(${i}.conversation_user_id) > 0
    AND ${i}.conversation_state = 'waiting' AND ${i}.status = 'in_review'
    AND ${i}.assignee_agent_id = ${i}.conversation_agent_id AND ${i}.assignee_user_id IS NULL
    AND (${i}.conversation_user_id = 'local-board' OR EXISTS (SELECT 1 FROM company_memberships membership
      WHERE membership.company_id = ${i}.company_id AND membership.principal_type = 'user'
        AND membership.principal_id = ${i}.conversation_user_id AND membership.status = 'active'))
    AND ${i}.conversation_session_generation >= 0
    AND ${i}.checkout_run_id IS NULL AND ${i}.execution_run_id IS NULL
    AND ${i}.monitor_next_check_at IS NULL AND ${i}.monitor_wake_requested_at IS NULL
    AND (${i}.execution_policy IS NULL OR (jsonb_typeof(${i}.execution_policy) = 'object'
      AND COALESCE(${i}.execution_policy->'monitor', 'null'::jsonb) = 'null'::jsonb))
    AND (${i}.execution_state IS NULL OR (jsonb_typeof(${i}.execution_state) = 'object'
      AND ${i}.execution_state->>'status' = 'idle'
      AND COALESCE(${i}.execution_state->'monitor', 'null'::jsonb) = 'null'::jsonb
      AND COALESCE(${i}.execution_state->'currentParticipant', 'null'::jsonb) = 'null'::jsonb
      AND COALESCE(${i}.execution_state->'currentStageId', 'null'::jsonb) = 'null'::jsonb
      AND COALESCE(${i}.execution_state->'reviewRequest', 'null'::jsonb) = 'null'::jsonb))
    AND EXISTS (SELECT 1 FROM agents a JOIN companies c ON c.id = a.company_id
      WHERE a.id = ${i}.conversation_agent_id AND a.company_id = ${i}.company_id
        AND c.status = 'active' AND a.status IN ('idle', 'active', 'paused', 'terminated'))
    AND NOT EXISTS (SELECT 1 FROM heartbeat_runs r WHERE
      (r.native_issue_id = ${i}.id OR r.context_snapshot->>'issueId' = ${i}.id::text OR r.context_snapshot->>'taskId' = ${i}.id::text)
      AND (r.company_id <> ${i}.company_id OR r.agent_id <> ${i}.conversation_agent_id OR (${finishedIdleRun('r')}) IS NOT TRUE))
    AND NOT EXISTS (SELECT 1 FROM agent_wakeup_requests w WHERE
      (w.payload->>'issueId' = ${i}.id::text OR w.payload->>'taskId' = ${i}.id::text)
      AND (w.company_id <> ${i}.company_id OR w.agent_id <> ${i}.conversation_agent_id
        OR (${finishedIdleWake('w')}) IS NOT TRUE))
    AND NOT EXISTS (SELECT 1 FROM issue_comments comment WHERE comment.issue_id = ${i}.id
      AND comment.deleted_at IS NULL AND comment.author_user_id IS NOT NULL AND comment.author_agent_id IS NULL
      AND comment.origin = 'comment' AND comment.client_request_id IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM agent_wakeup_requests w WHERE w.company_id = ${i}.company_id
        AND w.agent_id = ${i}.conversation_agent_id AND w.idempotency_key = 'conversation-comment:' || comment.id::text
        AND ${finishedIdleWake('w')}))
    AND NOT EXISTS (SELECT 1 FROM issue_thread_interactions interaction WHERE interaction.issue_id = ${i}.id
      AND (interaction.company_id <> ${i}.company_id OR interaction.status = 'pending'))
    AND NOT EXISTS (SELECT 1 FROM chat_completion_deliveries d JOIN chat_task_handoffs h ON h.task_id = d.task_id
      WHERE h.conversation_id = ${i}.id AND (h.company_id <> ${i}.company_id OR d.company_id <> ${i}.company_id
        OR d.status NOT IN ('delivered', 'superseded', 'exhausted')))`;
}
