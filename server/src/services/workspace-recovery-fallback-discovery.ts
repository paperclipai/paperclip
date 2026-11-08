import { sql } from "drizzle-orm";
import { issueRecoveryActions } from "@paperclipai/db";

/** Source refusals that repeat on every retry (see workspace-recovery-fallback). */
export const UNVERIFIABLE_SOURCE_CODES = ["allocation_ownership_ambiguous", "source_binding_invalid", "source_unavailable", "historical_source_missing"] as const;
export const PERMANENT_SOURCE_RETRY_CLASSES = ["service_required", "use_alternative_strategy"] as const;
export const RETAINED_SOURCE_FALLBACK_CHECK_KEY = "retainedSourceFallbackCheck";

const list = (values: readonly string[]) => sql.join(values.map(value => sql`${value}`), sql`, `);
const check = sql`${issueRecoveryActions.evidence}->${RETAINED_SOURCE_FALLBACK_CHECK_KEY}`;

/**
 * An exhausted hold that the fallback may still settle: its source is refused
 * permanently, or a sibling recovery action of the same run saved its files.
 * The recovery worker discovers it like other unfinished work. A deferred
 * check of the same generation waits for its recorded time; a bounded number of
 * deferrals ends with no time, so the worker stops scheduling it (new input,
 * Retry or a new generation reconsiders it).
 */
export function retainedSourceFallbackPendingCondition() {
  return sql`(${issueRecoveryActions.status} in ('active', 'escalated')
    and ${issueRecoveryActions.evidence}#>>'{systemRecovery,state}' = 'exhausted'
    and ${issueRecoveryActions.evidence}->'retainedSourceFallback' is null
    and ((${issueRecoveryActions.cause} in ('native_workspace_sync_out_unrecoverable', 'native_workspace_sync_out_retry_exhausted')
        and ${issueRecoveryActions.evidence}#>>'{systemRecovery,failure,code}' in (${list(UNVERIFIABLE_SOURCE_CODES)})
        and ${issueRecoveryActions.evidence}#>>'{systemRecovery,failure,retryClass}' in (${list(PERMANENT_SOURCE_RETRY_CLASSES)})
        and exists (select 1 from heartbeat_runs source where source.company_id = ${issueRecoveryActions.companyId}
          and source.id::text = ${issueRecoveryActions.evidence}->>'runId'
          and source.runner_profile_json#>>'{remoteWorkspace,state}' = 'prepared'))
      or exists (select 1 from issue_recovery_actions sibling
        where sibling.company_id = ${issueRecoveryActions.companyId} and sibling.source_issue_id = ${issueRecoveryActions.sourceIssueId}
          and sibling.id <> ${issueRecoveryActions.id} and sibling.evidence->>'runId' = ${issueRecoveryActions.evidence}->>'runId'
          and sibling.evidence#>>'{systemRecovery,state}' = 'complete'
          and sibling.evidence#>>'{workspaceRecovery,status}' = 'recovered'))
    and (${check} is null
      or ${check}->>'generationId' is distinct from ${issueRecoveryActions.evidence}#>>'{systemRecovery,generationId}'
      or jsonb_typeof(${check}->'nextCheckAt') = 'number'))`;
}

/** When the pending fallback is next due, in epoch milliseconds (0 = now). */
export function retainedSourceFallbackDueAt() {
  return sql`case when ${check}->>'generationId' = ${issueRecoveryActions.evidence}#>>'{systemRecovery,generationId}'
    and jsonb_typeof(${check}->'nextCheckAt') = 'number' then (${check}->>'nextCheckAt')::bigint else 0 end`;
}

export function retainedSourceFallbackDueCondition(now: number) {
  return sql`(${retainedSourceFallbackPendingCondition()} and ${retainedSourceFallbackDueAt()} <= ${now}::bigint)`;
}
