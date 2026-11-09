import { sql } from "drizzle-orm";
import { issueRecoveryActions } from "@paperclipai/db";
import { isExhaustedStopProofWait, STOP_PROOF_MAX_REARMS, STOP_PROOF_RECOVERY_KEY, STOP_PROOF_RECOVERY_SCHEMA, STOP_PROOF_WAIT_CODE,
  stopProofRearmsSpent, type SystemRecoveryState } from "./system-recovery-state.js";

/** Source refusals that repeat on every retry (see workspace-recovery-fallback). */
export const UNVERIFIABLE_SOURCE_CODES = ["allocation_ownership_ambiguous", "source_binding_invalid", "source_unavailable", "historical_source_missing"] as const;
export const PERMANENT_SOURCE_RETRY_CLASSES = ["service_required", "use_alternative_strategy"] as const;
export const RETAINED_SOURCE_FALLBACK_CHECK_KEY = "retainedSourceFallbackCheck";

/** Whether an exhausted hold may continue from the last save: its source is
 * refused permanently, or its stop stayed unproven through every re-arm. */
export function retainedHoldFallbackEligible(evidence: Record<string, unknown> | null | undefined, state: SystemRecoveryState | null) {
  if (!state || state.state !== "exhausted") return false;
  const failure = state.failure;
  if (failure && (UNVERIFIABLE_SOURCE_CODES as readonly string[]).includes(failure.code)
    && (PERMANENT_SOURCE_RETRY_CLASSES as readonly string[]).includes(failure.retryClass)) return true;
  return isExhaustedStopProofWait(state) && stopProofRearmsSpent(evidence);
}

const stopProofMarker = sql`${issueRecoveryActions.evidence}->${STOP_PROOF_RECOVERY_KEY}`;
const stopProofRearms = sql`case when ${stopProofMarker}->>'schema' = ${STOP_PROOF_RECOVERY_SCHEMA}
  and jsonb_typeof(${stopProofMarker}->'rearms') = 'number' then (${stopProofMarker}->>'rearms')::int else 0 end`;
const exhaustedStopProofWait = sql`(${issueRecoveryActions.evidence}#>>'{systemRecovery,state}' = 'exhausted'
  and ${issueRecoveryActions.evidence}#>>'{systemRecovery,failure,code}' = ${STOP_PROOF_WAIT_CODE}
  and ${issueRecoveryActions.evidence}#>>'{systemRecovery,failure,retryClass}' = 'recheck_evidence')`;

/** An exhausted unproven-stop hold whose next bounded re-arm is pending. Holds
 * saved by older releases carry no marker and are due immediately. A finalizer
 * owner whose lease is not live waits for the abandoned-owner settlement (the
 * attempt would refuse it, and the passive sweep revisits the hold after it);
 * a live one makes the re-arm due at its expiry (stopProofRearmDueAt). */
export function stopProofRearmPendingCondition() {
  return sql`(${issueRecoveryActions.status} in ('active', 'escalated')
    and ${exhaustedStopProofWait}
    and not exists (select 1 from native_run_finalizations finalizer
      where finalizer.company_id = ${issueRecoveryActions.companyId} and finalizer.run_id::text = ${issueRecoveryActions.evidence}->>'runId'
        and finalizer.lease_owner is not null and coalesce(finalizer.lease_expires_at <= now(), true))
    and ${issueRecoveryActions.evidence}->'retainedSourceFallback' is null
    and ${issueRecoveryActions.evidence}->'executionReconciliation' is null
    and ${stopProofRearms} < ${STOP_PROOF_MAX_REARMS})`;
}

/** When the next re-arm is due, in epoch milliseconds (0 = now): its backoff,
 * and no earlier than the expiry of a controller or finalizer lease that the
 * source run still holds, so a held run is checked at that deadline only. */
export function stopProofRearmDueAt() {
  return sql`greatest(case when ${stopProofMarker}->>'schema' = ${STOP_PROOF_RECOVERY_SCHEMA}
      and jsonb_typeof(${stopProofMarker}->'nextRearmAt') = 'number' then (${stopProofMarker}->>'nextRearmAt')::bigint else 0 end,
    coalesce((select (extract(epoch from source.controller_lease_expires_at) * 1000)::bigint from heartbeat_runs source
      where source.company_id = ${issueRecoveryActions.companyId} and source.id::text = ${issueRecoveryActions.evidence}->>'runId'), 0),
    coalesce((select max((extract(epoch from finalizer.lease_expires_at) * 1000)::bigint) from native_run_finalizations finalizer
      where finalizer.company_id = ${issueRecoveryActions.companyId} and finalizer.run_id::text = ${issueRecoveryActions.evidence}->>'runId'
        and finalizer.lease_owner is not null), 0))`;
}

export function stopProofRearmDueCondition(now: number) {
  return sql`(${stopProofRearmPendingCondition()} and ${stopProofRearmDueAt()} <= ${now}::bigint)`;
}

const list = (values: readonly string[]) => sql.join(values.map(value => sql`${value}`), sql`, `);
const check = sql`${issueRecoveryActions.evidence}->${RETAINED_SOURCE_FALLBACK_CHECK_KEY}`;
// New stop evidence (any change to an allocation of the source run, such as a
// late provider stop receipt) after the last deferred check reconsiders the
// hold once, even after its bounded checks are spent.
const leaseChangedSinceCheck = sql`(jsonb_typeof(${check}->'checkedAt') = 'number' and exists (
  select 1 from environment_leases lease where lease.company_id = ${issueRecoveryActions.companyId}
    and lease.heartbeat_run_id::text = ${issueRecoveryActions.evidence}->>'runId'
    and lease.updated_at > to_timestamp((${check}->>'checkedAt')::bigint / 1000.0)))`;

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
      or (${issueRecoveryActions.cause} in ('native_workspace_sync_out_unrecoverable', 'native_workspace_sync_out_retry_exhausted')
        and ${exhaustedStopProofWait} and ${stopProofRearms} >= ${STOP_PROOF_MAX_REARMS}
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
      or ${leaseChangedSinceCheck}
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
