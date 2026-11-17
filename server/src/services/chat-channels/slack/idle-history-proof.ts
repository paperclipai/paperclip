/** Connector rows below are immutable authority/confirmed-call receipts. Their
 * own downstream publication, interaction and run rows keep independent gates. */
function completedSlackConnectorAction(a: string): string {
  const principal = `EXISTS (SELECT 1 FROM chat_external_principals principal WHERE principal.id = ${a}.principal_id
    AND principal.company_id = ${a}.company_id AND principal.provider = 'slack')`;
  const issue = `EXISTS (SELECT 1 FROM issues issue WHERE issue.id::text = ${a}.payload->>'issueId'
    AND issue.company_id = ${a}.company_id AND (${a}.conversation_id IS NULL OR EXISTS (
      SELECT 1 FROM chat_conversations conversation WHERE conversation.id = ${a}.conversation_id
        AND conversation.company_id = issue.company_id AND conversation.issue_id = issue.id
        AND conversation.endpoint_id = ${a}.endpoint_id)))`;
  return `(${a}.kind = 'slack_private_source' AND ${a}.status = 'processed' AND ${a}.result IS NULL
      AND ${issue} AND ${principal} AND length(${a}.payload->>'channelId') > 0
      AND length(${a}.payload->>'requesterId') > 0
      AND ${a}.provider_action_id = 'slack-private:' || (${a}.payload->>'issueId') || ':'
        || (${a}.payload->>'channelId') || ':' || (${a}.payload->>'requesterId'))
    OR (${a}.kind = 'slack_connect' AND ${a}.status = 'processed'
      AND ${a}.payload->>'version' = '1' AND ${a}.result->>'code' = 'slack_identity_discovered'
      AND length(${a}.payload->>'channelId') > 0 AND ${principal}
      AND EXISTS (SELECT 1 FROM chat_external_principals principal WHERE principal.id = ${a}.principal_id
        AND principal.external_id = ${a}.payload->>'userId'))
    OR (${a}.kind IN ('slack_test_message', 'slack_test_message_invitation') AND ${a}.status = 'processed'
      AND length(${a}.payload->>'userId') > 0 AND ${a}.payload->>'slackUserId' ~ '^[UW][A-Z0-9]+$'
      AND CASE WHEN ${a}.kind = 'slack_test_message' THEN ${a}.result->>'slackUrl' ~ '^https://app[.]slack[.]com/client/[^/]+/D[A-Z0-9]+$'
        ELSE ${principal} AND ${a}.result->>'expiresAt' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T' END)
    OR (${a}.kind = 'slack_managed_reconnect' AND ${a}.status = 'processed' AND ${a}.result IS NULL
      AND ${a}.provider_action_id LIKE 'slack_managed_reconnect:%'
      AND length(${a}.payload->>'registrationRequestId') > 0
      AND EXISTS (SELECT 1 FROM chat_slack_manager_grants grant_record WHERE grant_record.id::text = ${a}.payload->>'grantId'
        AND grant_record.company_id = ${a}.company_id))
    OR (${a}.kind = 'slack_tool_write' AND ${a}.status = 'processed' AND jsonb_typeof(${a}.result) = 'object'
      AND ${a}.payload->>'name' IN ('slack_open_dm', 'slack_post_message', 'slack_update_message', 'slack_delete_message',
        'slack_add_reaction', 'slack_remove_reaction', 'slack_add_pin', 'slack_remove_pin', 'slack_add_bookmark',
        'slack_remove_bookmark', 'slack_create_canvas', 'slack_edit_canvas', 'slack_replace_canvas_section',
        'slack_share_list', 'slack_edit_list', 'slack_create_list', 'slack_create_list_item', 'slack_update_list_item',
        'slack_invite', 'slack_create_channel', 'slack_upload_file')
      AND ${a}.payload->>'hash' ~ '^[a-f0-9]{64}$' AND jsonb_typeof(${a}.payload->'args') = 'object'
      AND length(${a}.payload->>'userId') > 0 AND length(${a}.payload->>'revision') > 0
      AND ${a}.provider_action_id = 'slack-tool:' || (${a}.payload->'binding'->>'issueId') || ':' || (${a}.payload->'args'->>'idempotencyKey')
      AND EXISTS (SELECT 1 FROM tool_invocations invocation JOIN heartbeat_runs run ON run.id = invocation.run_id
        AND run.company_id = invocation.company_id AND run.agent_id = invocation.agent_id
        WHERE invocation.id::text = ${a}.payload->>'invocationId' AND invocation.company_id = ${a}.company_id
          AND invocation.run_id::text = ${a}.payload->'binding'->>'runId'
          AND invocation.agent_id::text = ${a}.payload->'binding'->>'agentId'
          AND invocation.issue_id::text = ${a}.payload->'binding'->>'issueId'
          AND ${a}.payload->'binding'->>'companyId' = ${a}.company_id::text))
    OR (${a}.kind = 'slack_board_message' AND ${issue} AND EXISTS (
      SELECT 1 FROM issue_comments comment JOIN chat_publications publication
        ON publication.comment_id = comment.id AND publication.company_id = comment.company_id
      WHERE comment.id::text = ${a}.payload->>'commentId' AND comment.company_id = ${a}.company_id
        AND comment.issue_id::text = ${a}.payload->>'issueId' AND comment.author_user_id = ${a}.payload->>'userId'
        AND publication.endpoint_id = ${a}.endpoint_id AND publication.conversation_id = ${a}.conversation_id
        AND ((publication.state = 'published' AND publication.published_at IS NOT NULL)
          OR (publication.state IN ('failed', 'cancelled') AND publication.next_attempt_at IS NULL)))
      AND ((${a}.status = 'cancelled' AND ${a}.result->>'code' = 'slack_board_work_not_authorized')
        OR (${a}.status = 'processed' AND (${a}.result IS NULL OR (${a}.result->>'resumeApplied' = 'true'
          AND EXISTS (SELECT 1 FROM agent_wakeup_requests wake WHERE wake.company_id = ${a}.company_id
            AND wake.idempotency_key = 'slack-board-comment:' || ${a}.id::text AND wake.finished_at IS NOT NULL
            AND wake.status IN ('completed', 'failed', 'cancelled', 'skipped', 'timed_out')))))))`;
}

export function completedSlackAction(a: string): string {
  return `(${a}.kind = 'slack_session_sync' AND (
      (${a}.status = 'processed' AND ${a}.result->>'outcome' IN ('updated', 'unsupported')
        AND (${a}.result->>'outcome' <> 'updated' OR ${a}.result->>'sessionStatus' <> 'processing'))
      OR (${a}.status = 'cancelled' AND ${a}.result->>'code' IN ('slack_session_no_published_state', 'slack_session_destination_changed'))
      OR (${a}.status = 'failed' AND ${a}.result->>'code' = 'slack_session_sync_rejected')))
    OR (${a}.kind = 'slash_task_start' AND ${a}.status = 'processed'
      AND length(${a}.result->>'providerMessageId') > 0 AND length(${a}.result->>'threadId') > 0)
    OR (${a}.kind = 'slack_file_upload_receipt' AND ${a}.status = 'processed'
      AND ${a}.result->>'code' = 'slack_file_upload_identity_confirmed')
    OR (${a}.kind = 'slack_session_stop' AND ${a}.status IN ('processed', 'cancelled')
      AND ${a}.result->>'code' IN ('slack_session_stop_cancelled', 'slack_session_stop_target_superseded', 'slack_session_stop_no_current_work')
      AND NOT EXISTS (SELECT 1 FROM heartbeat_runs r WHERE r.id::text = ${a}.result->>'runId'
        AND (r.company_id <> ${a}.company_id OR r.status NOT IN ('succeeded', 'failed', 'cancelled', 'timed_out', 'interrupted')
          OR r.finished_at IS NULL OR r.cost_accounting_pending)))
    OR (${completedSlackConnectorAction(a)})`;
}
