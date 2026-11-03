import { finishedIdleRun } from "./idle-work-proof.js";

/** executeDecisionEffects visits every selected ordinal, including failures.
 * Its final aggregate cannot prove a missing row or another option's effect. */
function completedEffectManifest(d: string): string {
  const options = `jsonb_array_elements(CASE WHEN jsonb_typeof(${d}.options) = 'array' THEN ${d}.options ELSE '[]'::jsonb END)`;
  return `EXISTS (SELECT 1 FROM ${options} option_row WHERE option_row->>'id' = ${d}.chosen_option_id
    AND jsonb_typeof(option_row->'effects') = 'array'
    AND EXISTS (SELECT 1 FROM activity_log selection WHERE selection.company_id = ${d}.company_id
      AND selection.entity_type = 'decision' AND selection.entity_id = ${d}.id::text
      AND selection.action IN ('decision.decided', 'decision.dismissed')
      AND selection.details->>'chosenOptionId' = ${d}.chosen_option_id
      AND selection.details->>'decidedByUserId' = ${d}.decided_by_user_id)
    AND (SELECT count(*) FROM ${options} duplicate_option WHERE duplicate_option->>'id' = ${d}.chosen_option_id) = 1
    AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(option_row->'effects') WITH ORDINALITY expected(effect, ordinal)
      WHERE NOT EXISTS (SELECT 1 FROM decision_effect_executions execution JOIN issues target
        ON target.id = execution.target_issue_id AND target.company_id = ${d}.company_id
        JOIN activity_log audit ON audit.id = execution.activity_log_id AND audit.company_id = ${d}.company_id
          AND audit.entity_type = 'decision' AND audit.entity_id = ${d}.id::text
          AND audit.details->>'chosenOptionId' = ${d}.chosen_option_id
          AND audit.details->>'executionId' = execution.id::text
        WHERE execution.decision_id = ${d}.id AND execution.effect_index = expected.ordinal - 1
          AND execution.effect_type = expected.effect->>'type' AND execution.target_issue_id::text = expected.effect->>'targetIssueId'
          AND execution.status IN ('executed', 'failed', 'skipped') AND execution.executed_at IS NOT NULL
          AND audit.action = 'decision.effect_' || execution.status))
    AND NOT EXISTS (SELECT 1 FROM decision_effect_executions execution WHERE execution.decision_id = ${d}.id
      AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(option_row->'effects') WITH ORDINALITY expected(effect, ordinal)
        WHERE execution.effect_index = expected.ordinal - 1 AND execution.effect_type = expected.effect->>'type'
          AND execution.target_issue_id::text = expected.effect->>'targetIssueId'))
    AND CASE WHEN ${d}.execution_status = 'succeeded' THEN NOT EXISTS (SELECT 1 FROM decision_effect_executions e
        WHERE e.decision_id = ${d}.id AND e.status <> 'executed')
      WHEN ${d}.execution_status = 'partial' THEN EXISTS (SELECT 1 FROM decision_effect_executions e
        WHERE e.decision_id = ${d}.id AND e.status = 'executed') AND EXISTS (SELECT 1 FROM decision_effect_executions e
        WHERE e.decision_id = ${d}.id AND e.status IN ('failed', 'skipped'))
      ELSE NOT EXISTS (SELECT 1 FROM decision_effect_executions e WHERE e.decision_id = ${d}.id AND e.status = 'executed')
        AND EXISTS (SELECT 1 FROM decision_effect_executions e WHERE e.decision_id = ${d}.id AND e.status IN ('failed', 'skipped')) END)`;
}

function completedDecisionOutcome(d: string): string {
  return `(${d}.status IN ('expired', 'cancelled') AND ${d}.execution_status IS NULL AND ${d}.chosen_option_id IS NULL
      AND NOT EXISTS (SELECT 1 FROM decision_effect_executions e WHERE e.decision_id = ${d}.id)
      AND EXISTS (SELECT 1 FROM activity_log audit WHERE audit.company_id = ${d}.company_id
        AND audit.entity_type = 'decision' AND audit.entity_id = ${d}.id::text AND audit.action = 'decision.' || ${d}.status))
    OR (${d}.status = 'decided' AND ${d}.decided_at IS NOT NULL AND ${d}.execution_status IN ('succeeded', 'partial', 'failed')
      AND ((COALESCE(${d}.metadata->>'kind', '') <> 'attention_archive_proposal' AND (${completedEffectManifest(d)}))
        OR (${completedArchiveOutcome(d)})
        OR (${d}.chosen_option_id = 'dismissed' AND ${d}.execution_status = 'succeeded' AND ${d}.metadata->>'dismissed' = 'true'
          AND NOT EXISTS (SELECT 1 FROM decision_effect_executions e WHERE e.decision_id = ${d}.id)
          AND EXISTS (SELECT 1 FROM activity_log audit WHERE audit.company_id = ${d}.company_id
            AND audit.entity_type = 'decision' AND audit.entity_id = ${d}.id::text AND audit.action = 'decision.dismissed'
            AND audit.details->>'chosenOptionId' = 'dismissed' AND audit.details->>'decidedByUserId' = ${d}.decided_by_user_id))
        OR (${d}.metadata->>'effectRecoveryError' IN ('missing_decider', 'missing_option')
          AND ${d}.execution_status IN ('failed', 'partial')
          AND EXISTS (SELECT 1 FROM activity_log audit WHERE audit.company_id = ${d}.company_id
            AND audit.entity_type = 'decision' AND audit.entity_id = ${d}.id::text AND audit.action = 'decision.recovery_failed'
            AND audit.details->>'reason' = ${d}.metadata->>'effectRecoveryError'
            AND audit.details->>'executionStatus' = ${d}.execution_status
            AND audit.details->>'chosenOptionId' IS NOT DISTINCT FROM ${d}.chosen_option_id))))`;
}

/** Archive applies the reviewed set in one transaction. Every catch is final
 * (execution_status=failed); it neither replays the set nor leaves per-effect
 * claims. Continuation and notification queues remain independent checks. */
function completedArchiveOutcome(d: string): string {
  return `${d}.metadata->>'kind' = 'attention_archive_proposal'
    AND NOT EXISTS (SELECT 1 FROM decision_effect_executions e WHERE e.decision_id = ${d}.id)
    AND EXISTS (SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(${d}.options) = 'array'
      THEN ${d}.options ELSE '[]'::jsonb END) selected WHERE selected->>'id' = ${d}.chosen_option_id
      AND selected->'effects' = '[]'::jsonb
      AND (SELECT count(*) FROM jsonb_array_elements(${d}.options) duplicate WHERE duplicate->>'id' = ${d}.chosen_option_id) = 1)
    AND ((${d}.execution_status = 'failed' AND ${d}.chosen_option_id = 'archive'
        AND jsonb_typeof(${d}.metadata->'archiveProposalError') = 'string'
        AND length(trim(${d}.metadata->>'archiveProposalError')) > 0)
      OR (${d}.execution_status = 'succeeded' AND ${d}.metadata->>'archiveProposalError' IS NULL
        AND (${d}.chosen_option_id <> 'archive' OR (
          jsonb_typeof(${d}.target_snapshots) = 'object' AND ${d}.target_snapshots <> '{}'::jsonb
          AND ${d}.metadata->>'manifestHash' ~ '^[a-f0-9]{64}$'
          AND NOT EXISTS (SELECT 1 FROM jsonb_each(${d}.target_snapshots) snapshot WHERE (
            snapshot.key = 'attention:' || (snapshot.value->'attentionArchive'->>'sourceKind') || ':' || (snapshot.value->'attentionArchive'->>'sourceId')
            AND snapshot.value->'attentionArchive'->>'companyId' = ${d}.company_id::text
            AND jsonb_typeof(snapshot.value->'attentionArchive'->'expectedVersion') = 'number'
            AND snapshot.value->'attentionArchive'->>'expectedVersion' ~ '^[1-9][0-9]*$'
            AND EXISTS (SELECT 1 FROM decision_retention retention WHERE retention.company_id = ${d}.company_id
              AND retention.source_kind = snapshot.value->'attentionArchive'->>'sourceKind'
              AND retention.source_id = snapshot.value->'attentionArchive'->>'sourceId'
              AND retention.version::numeric > (snapshot.value->'attentionArchive'->>'expectedVersion')::numeric)
            AND EXISTS (SELECT 1 FROM activity_log audit WHERE audit.company_id = ${d}.company_id
              AND audit.actor_id = 'decision-archive-proposal' AND audit.action = 'decision_retention.archived'
              AND audit.entity_type = 'attention_source' AND audit.entity_id = snapshot.value->'attentionArchive'->>'sourceId'
              AND audit.details->>'sourceKind' = snapshot.value->'attentionArchive'->>'sourceKind'
              AND audit.created_at >= ${d}.decided_at AND audit.responsible_user_id = ${d}.decided_by_user_id)) IS NOT TRUE)))))`;
}

function completedDecision(alias: string): string {
  return `(${completedDecisionOutcome(alias)})
    AND ${alias}.continuation_policy IN ('none', 'wake_origin_agent')
    AND jsonb_typeof(${alias}.metadata) = 'object'
    AND COALESCE(${alias}.metadata->>'continuationPending', 'false') = 'false'
    AND (${alias}.continuation_policy = 'none' OR ${alias}.metadata->>'continuationDeliveredAt' IS NOT NULL)
    AND EXISTS (SELECT 1 FROM heartbeat_runs r JOIN issues i ON i.id = ${alias}.origin_issue_id
      AND i.company_id = r.company_id WHERE r.id = ${alias}.origin_run_id
        AND r.company_id = ${alias}.company_id AND r.agent_id = ${alias}.origin_agent_id AND ${finishedIdleRun('r')})
    AND NOT EXISTS (SELECT 1 FROM decision_effect_executions e WHERE e.decision_id = ${alias}.id
      AND (e.status NOT IN ('executed', 'failed', 'skipped') OR e.executed_at IS NULL))`;
}

export const idleDecisionHistoryChecks = [
  { reason: "decisions", query: `SELECT 1 FROM decisions d WHERE (${completedDecision('d')}) IS NOT TRUE` },
  { reason: "decision_effect_executions", query: `SELECT 1 FROM decision_effect_executions e WHERE (
    e.status IN ('executed', 'failed', 'skipped') AND e.executed_at IS NOT NULL
    AND EXISTS (SELECT 1 FROM decisions d JOIN issues i ON i.id = e.target_issue_id AND i.company_id = d.company_id
      WHERE d.id = e.decision_id AND (${completedDecision('d')}))) IS NOT TRUE` },
  { reason: "decision_archive_notification_outbox", query: `SELECT 1 FROM decision_archive_notification_outbox o WHERE (
    o.status = 'delivered' AND o.delivered_at IS NOT NULL
    AND o.archive_version > 0 AND EXISTS (SELECT 1 FROM decision_retention retention
      WHERE retention.company_id = o.company_id AND retention.source_kind = o.source_kind
        AND retention.source_id = o.source_id AND retention.archive_version >= o.archive_version)
    AND EXISTS (SELECT 1 FROM agents a JOIN issues i ON i.company_id = a.company_id
      WHERE a.id = o.origin_agent_id AND i.id = o.origin_issue_id AND i.company_id = o.company_id)) IS NOT TRUE` },
  { reason: "company_secret_proposals", query: `SELECT 1 FROM company_secret_proposals p WHERE (
    p.kind IN ('secret', 'binding') AND p.status IN ('approved', 'rejected', 'withdrawn', 'expired')
    AND p.resolved_at IS NOT NULL AND p.value_ciphertext IS NULL AND p.ciphertext_scrubbed_at IS NOT NULL
    AND EXISTS (SELECT 1 FROM heartbeat_runs r WHERE r.id = p.origin_run_id
      AND r.company_id = p.company_id AND r.agent_id = p.proposed_by_agent_id AND ${finishedIdleRun('r')})
    AND (p.origin_issue_id IS NULL OR EXISTS (SELECT 1 FROM issues i
      WHERE i.id = p.origin_issue_id AND i.company_id = p.company_id))
    AND (p.status <> 'approved' OR (p.kind = 'secret' AND EXISTS (SELECT 1 FROM company_secrets s
      WHERE s.id = p.created_secret_id AND s.company_id = p.company_id))
      OR (p.kind = 'binding' AND p.applied_binding_config_path = p.config_path AND EXISTS (
        SELECT 1 FROM agents a WHERE a.id = p.target_id AND a.company_id = p.company_id)))
    AND (p.interaction_id IS NULL OR EXISTS (SELECT 1 FROM issue_thread_interactions i
      WHERE i.id = p.interaction_id AND i.company_id = p.company_id AND i.issue_id = p.origin_issue_id
        AND i.status IN ('accepted', 'rejected', 'cancelled', 'expired') AND i.resolved_at IS NOT NULL))) IS NOT TRUE` },
] as const;
