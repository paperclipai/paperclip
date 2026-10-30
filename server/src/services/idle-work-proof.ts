import { verifiedResourceCleanup } from "./cleanup-verification-proof.js";

/** Fixed SQL aliases only. These predicates do not accept request input. */
export function finishedIdleRun(alias: string): string {
  return `${alias}.status IN ('succeeded', 'failed', 'cancelled', 'timed_out', 'interrupted')
    AND ${alias}.finished_at IS NOT NULL
    AND (${alias}.scheduled_retry_at IS NULL OR ${alias}.scheduled_retry_at <= ${alias}.finished_at)
    AND ${alias}.cost_accounting_pending = false`;
}

export function finishedIdleWake(alias: string): string {
  return `${alias}.finished_at IS NOT NULL AND (
    ${alias}.status IN ('completed', 'failed', 'cancelled', 'skipped', 'timed_out')
    OR (${alias}.status = 'coalesced' AND EXISTS (
      SELECT 1 FROM heartbeat_runs wake_target WHERE wake_target.id = ${alias}.run_id
        AND wake_target.company_id = ${alias}.company_id AND wake_target.agent_id = ${alias}.agent_id
        AND ${finishedIdleRun('wake_target')})))`;
}

export function completedAgentUnblockRequest(issue: string): string {
  return `${issue}.blocked_transition_at IS NOT NULL
    AND ${issue}.blocked_owner_notified_at >= ${issue}.blocked_transition_at
    AND jsonb_typeof(${issue}.unblock_descriptor) = 'object'
    AND ${issue}.unblock_descriptor = jsonb_build_object('owner', ${issue}.unblock_descriptor->'owner',
      'action', ${issue}.unblock_descriptor->'action')
    AND jsonb_typeof(${issue}.unblock_descriptor->'owner') = 'object'
    AND ${issue}.unblock_descriptor->'owner' = jsonb_build_object('agentId', ${issue}.unblock_descriptor->'owner'->'agentId')
    AND jsonb_typeof(${issue}.unblock_descriptor->'owner'->'agentId') = 'string'
    AND jsonb_typeof(${issue}.unblock_descriptor->'action') = 'string'
    AND length(trim(${issue}.unblock_descriptor->>'action')) > 0
    AND EXISTS (SELECT 1 FROM agents unblock_owner
      WHERE unblock_owner.company_id = ${issue}.company_id
        AND unblock_owner.id::text = ${issue}.unblock_descriptor->'owner'->>'agentId')
    AND EXISTS (SELECT 1 FROM agent_wakeup_requests unblock_wake
      WHERE unblock_wake.company_id = ${issue}.company_id
        AND unblock_wake.agent_id::text = ${issue}.unblock_descriptor->'owner'->>'agentId'
        AND unblock_wake.idempotency_key = 'issue-unblock:' || ${issue}.id::text || ':'
          || to_char(${issue}.blocked_transition_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
        AND unblock_wake.payload->>'issueId' = ${issue}.id::text
        AND unblock_wake.payload->>'action' = ${issue}.unblock_descriptor->>'action'
        AND unblock_wake.status IN ('completed', 'coalesced') AND unblock_wake.finished_at IS NOT NULL
        AND EXISTS (SELECT 1 FROM heartbeat_runs unblock_target
          WHERE unblock_target.id = unblock_wake.run_id AND unblock_target.company_id = ${issue}.company_id
            AND unblock_target.agent_id = unblock_wake.agent_id
            AND (unblock_target.context_snapshot->>'issueId' = ${issue}.id::text
              OR unblock_target.native_issue_id = ${issue}.id)
            AND (unblock_target.native_issue_id IS NULL OR unblock_target.native_issue_id = ${issue}.id)
            AND ${finishedIdleRun('unblock_target')}))`;
}

// A blocked write authored by the named unblock owner itself needs no wake:
// the author already knows. The notification helper records blockedOwnerNotifiedAt
// without enqueueing one, so this proof keys on the durable activity entry for
// that exact transition instead of a wake receipt. An agent may only name itself
// as unblock owner, so a matching self-authored entry exists exactly for the
// transitions where the wake was suppressed. The descriptor binding is a
// fingerprint, not the raw text: activity details pass through secret and
// username redaction before storage, while the issue row keeps the original.
// When the write came from a run, that run must be finished so a still-live
// author cannot certify its own in-flight work as passive; a run-less write
// (agent key without run context) has no execution in flight to wait for.
export function selfAcknowledgedAgentUnblockRequest(issue: string): string {
  return `${issue}.blocked_transition_at IS NOT NULL
    AND ${issue}.blocked_owner_notified_at >= ${issue}.blocked_transition_at
    AND jsonb_typeof(${issue}.unblock_descriptor) = 'object'
    AND ${issue}.unblock_descriptor = jsonb_build_object('owner', ${issue}.unblock_descriptor->'owner',
      'action', ${issue}.unblock_descriptor->'action')
    AND jsonb_typeof(${issue}.unblock_descriptor->'owner') = 'object'
    AND ${issue}.unblock_descriptor->'owner' = jsonb_build_object('agentId', ${issue}.unblock_descriptor->'owner'->'agentId')
    AND jsonb_typeof(${issue}.unblock_descriptor->'owner'->'agentId') = 'string'
    AND jsonb_typeof(${issue}.unblock_descriptor->'action') = 'string'
    AND length(trim(${issue}.unblock_descriptor->>'action')) > 0
    AND EXISTS (SELECT 1 FROM activity_log self_block
      LEFT JOIN heartbeat_runs self_block_run ON self_block_run.id = self_block.run_id
        AND self_block_run.company_id = ${issue}.company_id
      WHERE self_block.company_id = ${issue}.company_id
        AND self_block.entity_type = 'issue' AND self_block.entity_id = ${issue}.id::text
        AND self_block.action = 'issue.updated' AND self_block.actor_type = 'agent'
        AND self_block.agent_id::text = ${issue}.unblock_descriptor->'owner'->>'agentId'
        AND (self_block.run_id IS NULL OR (self_block_run.agent_id = self_block.agent_id
          AND ${finishedIdleRun('self_block_run')}))
        AND self_block.details->>'status' = 'blocked'
        AND self_block.details->>'blockedTransitionAt'
          = to_char(${issue}.blocked_transition_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
        AND self_block.details->>'unblockDescriptorFingerprint'
          = md5((${issue}.unblock_descriptor->'owner'->>'agentId') || chr(10)
            || (${issue}.unblock_descriptor->>'action'))
        AND self_block.created_at >= ${issue}.blocked_transition_at - INTERVAL '5 seconds')`;
}

export function connectionDeliveryWaitingForResponse(delivery: string): string {
  return `EXISTS (SELECT 1 FROM issue_thread_interactions waiting_delivery
    JOIN issues waiting_issue ON waiting_issue.id = waiting_delivery.issue_id
      AND waiting_issue.company_id = waiting_delivery.company_id
    WHERE waiting_delivery.id = ${delivery}.interaction_id AND waiting_delivery.company_id = ${delivery}.company_id
      AND waiting_delivery.kind = 'connection_intent' AND waiting_delivery.status = 'expired'
      AND waiting_delivery.resolved_at IS NOT NULL AND waiting_delivery.result->>'outcome' = 'expired'
      AND jsonb_typeof(waiting_delivery.result->'connectionId') = 'string'
      AND waiting_issue.status IN ('in_progress', 'in_review')
      AND waiting_issue.assignee_agent_id::text = waiting_delivery.payload->>'requestingAgentId'
      AND (${responseDrivenIssueWait('waiting_issue')}))`;
}

// Questions and confirmations advance on a response, not on a timer. Preserve
// the audience and continuation policy. A producer which still owns execution
// or accounting cannot certify a passive wait.
function passiveResponse(alias: string, issue: string): string {
  return `${alias}.company_id = ${issue}.company_id
    AND ${alias}.status = 'pending' AND ${alias}.resolved_at IS NULL
    AND (${alias}.kind IN ('ask_user_questions', 'request_confirmation', 'request_checkbox_confirmation', 'suggest_tasks')
      OR (${alias}.kind = 'connection_intent' AND ${alias}.effective_resolver_policy = 'human_only'
        AND ${alias}.addressee_user_id IS NOT NULL AND ${issue}.assignee_user_id IS NULL
        AND ${alias}.payload->>'version' = '1'
        AND ${alias}.payload->>'requestingAgentId' = ${issue}.assignee_agent_id::text
        AND length(${alias}.payload->>'serviceSlug') > 0
        AND (${alias}.payload->>'purpose' IS NULL OR ${alias}.payload->>'purpose' IN ('ai', 'channel'))
        -- Existing access can automatically retire a setup card. In its
        -- absence only the addressed human can finish this request. A broad
        -- purpose match deliberately keeps unfamiliar credential paths awake.
        AND NOT EXISTS (SELECT 1 FROM tool_connections response_connection
          WHERE response_connection.company_id = ${issue}.company_id
            AND response_connection.status = 'active' AND response_connection.enabled
            AND response_connection.connection_purpose = COALESCE(${alias}.payload->>'purpose', 'tool'))))
    -- Merge confirmations can advance through GitHub polling, without a
    -- response. Its recognizer requires merge intent in these four fields;
    -- conservatively retain those cards until polling has a durable wake.
    AND (${alias}.kind <> 'request_confirmation' OR concat_ws(' ', ${alias}.title, ${alias}.summary,
      ${alias}.payload->>'prompt', ${alias}.payload->>'acceptLabel') !~* 'merge')
    AND ${alias}.effective_resolver_policy IN ('anyone', 'not_creator', 'human_only')
    AND ${alias}.continuation_policy IN ('wake_assignee', 'none')
    AND (${alias}.source_run_id IS NULL OR EXISTS (
      SELECT 1 FROM heartbeat_runs response_source WHERE response_source.id = ${alias}.source_run_id
        AND response_source.company_id = ${issue}.company_id AND ${finishedIdleRun('response_source')}))`;
}

export function responseDrivenIssueWait(issue: string): string {
  return `EXISTS (SELECT 1 FROM issue_thread_interactions response_wait
      WHERE response_wait.issue_id = ${issue}.id AND ${passiveResponse('response_wait', issue)})
    AND NOT EXISTS (SELECT 1 FROM issue_thread_interactions other_wait
      WHERE other_wait.issue_id = ${issue}.id AND other_wait.status = 'pending'
        AND (${passiveResponse('other_wait', issue)}) IS NOT TRUE)`;
}

export function connectionIntentWaitingForResponse(interaction: string, issue: string): string {
  return `${interaction}.company_id = ${issue}.company_id AND ${interaction}.issue_id = ${issue}.id
    AND ${interaction}.kind = 'connection_intent' AND ${interaction}.status = 'pending'
    AND ${issue}.status IN ('in_progress', 'in_review') AND ${issue}.assignee_user_id IS NULL
    AND (${responseDrivenIssueWait(issue)})`;
}

export function passiveBoardRecovery(alias: string): string {
  return `${alias}.status IN ('active', 'escalated') AND ${alias}.resolved_at IS NULL
    AND ${alias}.owner_type = 'board' AND ${alias}.owner_agent_id IS NULL
    AND ${alias}.kind IN ('stranded_assigned_issue', 'missing_disposition')
    AND ${alias}.cause IN ('stranded_assigned_issue', 'successful_run_missing_state', 'issue_review_path_lost')
    AND ${alias}.recovery_issue_id IS NULL AND ${alias}.monitor_policy IS NULL AND ${alias}.timeout_at IS NULL
    AND jsonb_typeof(${alias}.wake_policy) = 'object'
    AND ${alias}.wake_policy->>'type' = 'board_escalation'
    AND (${alias}.wake_policy - ARRAY['type', 'reason', 'preservesSourceAssignee']) = '{}'::jsonb
    AND COALESCE(${alias}.wake_policy->>'preservesSourceAssignee', 'true') = 'true'
    AND EXISTS (SELECT 1 FROM issues recovery_source
      WHERE recovery_source.id = ${alias}.source_issue_id AND recovery_source.company_id = ${alias}.company_id
        AND recovery_source.status = 'blocked'
        AND recovery_source.checkout_run_id IS NULL AND recovery_source.execution_run_id IS NULL
        AND recovery_source.conversation_agent_id IS NULL
        AND recovery_source.monitor_next_check_at IS NULL AND recovery_source.monitor_wake_requested_at IS NULL
        AND (recovery_source.execution_state IS NULL OR recovery_source.execution_state->>'status' = 'idle')
        AND COALESCE(recovery_source.execution_policy->'monitor', 'null'::jsonb) = 'null'::jsonb)`;
}

export function finishedFailedIdleLease(alias: string): string {
  const receipt = `${alias}.metadata->'remoteExecutionTermination'`;
  return `${alias}.status = 'failed' AND ${alias}.lease_policy = 'ephemeral'
    AND ${alias}.released_at IS NOT NULL
    AND COALESCE(${alias}.metadata->>'pendingCleanupInFlight', 'false') = 'false'
    AND NOT (COALESCE(${alias}.metadata, '{}'::jsonb) ?| ARRAY['nativeWorkspaceExportResume', 'sandboxStopAndRetain'])
    AND (( ${alias}.provider = 'local' AND ${alias}.provider_lease_id IS NULL
      AND ${alias}.metadata->>'driver' = 'local'
      AND ${receipt} IS NULL
      AND EXISTS (SELECT 1 FROM environments local_environment
        WHERE local_environment.id = ${alias}.environment_id AND local_environment.driver = 'local'))
    OR (${alias}.cleanup_status = 'success' AND ${alias}.provider IS NOT NULL AND ${alias}.provider <> 'local'
      AND ${alias}.provider_lease_id IS NOT NULL AND ${alias}.provider_lease_id <> ''
      AND ((${receipt}->>'schema' = 'paperclip.remote-termination.v1'
      AND ${receipt}->>'companyId' = ${alias}.company_id::text
      AND ${receipt}->>'runId' = ${alias}.heartbeat_run_id::text
      AND ${receipt}->>'leaseId' = ${alias}.id::text
      AND ${receipt}->>'provider' = ${alias}.provider
      AND ${receipt}->>'providerLeaseId' = ${alias}.provider_lease_id
      AND ${receipt}->>'state' IN ('stopped', 'destroyed'))
        OR (${verifiedResourceCleanup(alias, 'lease')}))))
    AND ((${alias}.heartbeat_run_id IS NULL AND ${alias}.provider <> 'local'
      AND (${verifiedResourceCleanup(alias, 'lease')})) OR EXISTS (SELECT 1 FROM heartbeat_runs r WHERE r.id = ${alias}.heartbeat_run_id
      AND r.company_id = ${alias}.company_id
      AND ${finishedIdleRun("r")}))`;
}
