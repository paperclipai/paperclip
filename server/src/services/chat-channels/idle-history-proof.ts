import { finishedIdleRun, finishedIdleWake } from "../idle-work-proof.js";
import { completedGithubAction } from "./github/idle-history-proof.js";
import { completedSlackAction } from "./slack/idle-history-proof.js";
import { completedTelegramAction } from "./telegram/idle-history-proof.js";

/** A processed inbound receipt can still own an unconsumed wake. */
function completedAction(a: string): string {
  const wake = `EXISTS (SELECT 1 FROM agent_wakeup_requests w WHERE w.company_id = ${a}.company_id
    AND w.id = ${a}.id AND w.agent_id::text = ${a}.payload->>'agentId'
    AND w.payload->>'issueId' = ${a}.payload->>'issueId' AND ${finishedIdleWake('w')})`;
  return `jsonb_typeof(${a}.payload) = 'object' AND jsonb_typeof(${a}.result) = 'object'
    AND EXISTS (SELECT 1 FROM chat_endpoints e WHERE e.id = ${a}.endpoint_id AND e.company_id = ${a}.company_id)
    AND (${a}.delivery_id IS NULL OR EXISTS (SELECT 1 FROM chat_deliveries d
      WHERE d.id = ${a}.delivery_id AND d.company_id = ${a}.company_id AND d.endpoint_id = ${a}.endpoint_id))
    AND CASE
      WHEN ${a}.kind = 'inbound_wakeup' THEN ${a}.status IN ('processed', 'failed') AND ${wake}
      WHEN ${a}.kind = 'interaction_wakeup' THEN ${a}.status = 'processed' AND
        (${a}.result->>'code' = 'interaction_wakeup_no_longer_applicable' OR EXISTS (
          SELECT 1 FROM agent_wakeup_requests w WHERE w.company_id = ${a}.company_id
            AND w.idempotency_key = 'interaction:' || (${a}.payload->>'interactionId') || ':' || (${a}.payload->>'interactionStatus')
            AND ${finishedIdleWake('w')}))
      WHEN ${a}.kind = 'failed_run_retry' THEN ${a}.status = 'processed'
        AND ${a}.result->>'code' = 'failed_chat_retry_durable' AND ${wake}
      WHEN ${a}.kind = 'provider_effect' THEN
        (${a}.status = 'processed' AND length(${a}.result->>'providerMessageId') > 0 AND length(${a}.result->>'threadId') > 0)
        OR (${a}.status = 'cancelled' AND ${a}.result->>'code' = 'provider_effect_no_longer_authorized')
        OR (${a}.status = 'failed' AND ${a}.result->>'code' = 'provider_effect_failed' AND ${a}.result->>'retryable' = 'false')
      WHEN ${a}.kind = 'receipt_reaction' THEN
        (${a}.status = 'processed' AND jsonb_typeof(${a}.result->'attempts') = 'number' AND (${a}.result->>'attempts')::numeric > 0)
        OR (${a}.status = 'cancelled' AND ${a}.result->>'code' IN ('receipt_reaction_superseded_by_terminal_publication', 'receipt_reaction_runtime_superseded'))
      WHEN ${a}.kind = 'confirmation_response' THEN ${a}.status = 'processed'
        AND ${a}.result->>'code' IN ('confirmation_resolution_committed_by_provider', 'confirmation_resolution_reconciled')
        AND EXISTS (SELECT 1 FROM issue_thread_interactions interaction WHERE interaction.id::text = ${a}.result->>'interactionId'
          AND interaction.company_id = ${a}.company_id AND interaction.status = ${a}.result->>'interactionStatus'
          AND interaction.resolved_at IS NOT NULL)
      WHEN ${a}.kind = 'task_control_authorization' THEN ${a}.status IN ('processed', 'cancelled')
        AND EXISTS (SELECT 1 FROM chat_publications p WHERE p.company_id = ${a}.company_id AND p.endpoint_id = ${a}.endpoint_id
          AND p.conversation_id = ${a}.conversation_id AND ${a}.provider_action_id = 'task-control-authorization:' || p.id::text
          AND ((p.state = 'published' AND p.published_at IS NOT NULL) OR p.state = 'cancelled'))
      ELSE (${[completedGithubAction, completedSlackAction, completedTelegramAction]
    .map(proof => `(${proof(a)})`).join(' OR ')}) END`;
}

export const idleChatHistoryChecks = [
  { reason: "chat_deliveries", query: `SELECT 1 FROM chat_deliveries d WHERE (
    EXISTS (SELECT 1 FROM chat_endpoints e WHERE e.id = d.endpoint_id AND e.company_id = d.company_id)
    AND d.next_attempt_at IS NULL AND (d.state = 'failed' OR (d.state IN ('processed', 'filtered') AND d.processed_at IS NOT NULL))
    AND (d.conversation_id IS NULL OR EXISTS (SELECT 1 FROM chat_conversations c WHERE c.id = d.conversation_id
      AND c.company_id = d.company_id AND c.endpoint_id = d.endpoint_id))
    AND NOT EXISTS (SELECT 1 FROM chat_actions a WHERE a.delivery_id = d.id
      AND (a.company_id <> d.company_id OR a.endpoint_id <> d.endpoint_id OR (${completedAction('a')}) IS NOT TRUE))) IS NOT TRUE` },
  { reason: "chat_publications", query: `SELECT 1 FROM chat_publications p WHERE (
    (p.state = 'published' AND p.published_at IS NOT NULL AND p.redacted_error IS NULL
      OR (p.state IN ('failed', 'cancelled') AND p.next_attempt_at IS NULL))
    AND EXISTS (SELECT 1 FROM chat_conversations c JOIN chat_endpoints e
      ON e.id = c.endpoint_id AND e.company_id = c.company_id
      JOIN issues i ON i.id = p.issue_id AND i.company_id = c.company_id
      WHERE c.id = p.conversation_id AND c.company_id = p.company_id AND c.endpoint_id = p.endpoint_id)
    AND NOT EXISTS (SELECT 1 FROM chat_endpoint_leases l WHERE l.company_id = p.company_id
      AND l.endpoint_id = p.endpoint_id AND l.lease_key LIKE 'publication:' || p.id::text || ':%' AND l.expires_at > now())
    AND NOT EXISTS (SELECT 1 FROM chat_teams_file_transfers f WHERE f.publication_id = p.id
      AND (f.company_id <> p.company_id OR f.phase NOT IN ('delivered', 'declined', 'expired', 'cancelled')
        OR f.attempt_id IS NOT NULL OR f.attempt_expires_at IS NOT NULL))) IS NOT TRUE` },
  { reason: "chat_actions", query: `SELECT 1 FROM chat_actions a WHERE (${completedAction('a')}) IS NOT TRUE` },
  { reason: "chat_completion_deliveries", query: `SELECT 1 FROM chat_completion_deliveries d WHERE (
    d.status IN ('delivered', 'superseded', 'exhausted')
    AND EXISTS (SELECT 1 FROM chat_task_handoffs h JOIN issues task ON task.id = h.task_id AND task.company_id = h.company_id
      JOIN issues source ON source.id = h.conversation_id AND source.company_id = h.company_id
      WHERE h.task_id = d.task_id AND h.company_id = d.company_id
        AND source.conversation_agent_id = h.agent_id
        AND (d.status <> 'delivered' OR (d.status_version = task.status_version AND task.status = 'done'
          AND EXISTS (SELECT 1 FROM issue_comments c WHERE c.id = d.response_comment_id
            AND c.company_id = d.company_id AND c.issue_id = h.conversation_id AND c.author_agent_id = h.agent_id))))
    AND (d.target_run_id IS NULL AND d.status <> 'delivered' OR EXISTS (
      SELECT 1 FROM heartbeat_runs r JOIN chat_task_handoffs h ON h.task_id = d.task_id
      WHERE r.id = d.target_run_id AND r.company_id = d.company_id AND r.agent_id = h.agent_id
        AND (r.native_issue_id = h.conversation_id OR r.context_snapshot->>'issueId' = h.conversation_id::text)
        AND ${finishedIdleRun('r')}))) IS NOT TRUE` },
] as const;
