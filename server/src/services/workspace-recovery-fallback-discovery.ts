import { sql } from "drizzle-orm";
import { issueRecoveryActions } from "@paperclipai/db";
import type { SystemRecoveryState } from "./system-recovery-state.js";

/** Source refusals that repeat on every retry (see workspace-recovery-fallback). */
export const UNVERIFIABLE_SOURCE_CODES = ["allocation_ownership_ambiguous", "source_binding_invalid", "source_unavailable", "historical_source_missing"] as const;
export const PERMANENT_SOURCE_RETRY_CLASSES = ["service_required", "use_alternative_strategy"] as const;
export const RETAINED_SOURCE_FALLBACK_CHECK_KEY = "retainedSourceFallbackCheck";

/**
 * An exhausted save whose last failure was an unproven agent stop is not a
 * permanent refusal: once the source run has ended, a later attempt can prove
 * the stop. Recovery re-arms it a bounded number of times on a backoff
 * (workspace-recovery-stop-proof), then continues from the last save with the
 * unsaved files attached, like a refused source.
 */
export const STOP_PROOF_RECOVERY_KEY = "stopProofRecovery";
export const STOP_PROOF_RECOVERY_SCHEMA = "paperclip.stop-proof-recovery.v1";
export const STOP_PROOF_MAX_REARMS = 4;
export const STOP_PROOF_WAIT_CODE = "agent_stop_unconfirmed";

type StopProofMarker = { rearms: number; nextRearmAt: number | null };

export function readStopProofRecovery(evidence: Record<string, unknown> | null | undefined): StopProofMarker | null {
  const marker = evidence?.[STOP_PROOF_RECOVERY_KEY] as Record<string, unknown> | undefined;
  if (!marker || marker.schema !== STOP_PROOF_RECOVERY_SCHEMA || typeof marker.rearms !== "number") return null;
  return { rearms: marker.rearms, nextRearmAt: typeof marker.nextRearmAt === "number" ? marker.nextRearmAt : null };
}

export function isExhaustedStopProofWait(state: Pick<SystemRecoveryState, "state" | "failure"> | null | undefined) {
  return state?.state === "exhausted" && state.failure?.code === STOP_PROOF_WAIT_CODE
    && state.failure.retryClass === "recheck_evidence";
}

/** Every bounded re-arm of an unproven stop is spent. */
export function stopProofRearmsSpent(evidence: Record<string, unknown> | null | undefined) {
  return (readStopProofRecovery(evidence)?.rearms ?? 0) >= STOP_PROOF_MAX_REARMS;
}

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
 * saved by older releases carry no marker and are due immediately. */
export function stopProofRearmPendingCondition() {
  return sql`(${issueRecoveryActions.status} in ('active', 'escalated')
    and ${issueRecoveryActions.cause} in ('native_workspace_sync_out_unrecoverable', 'native_workspace_sync_out_retry_exhausted')
    and ${exhaustedStopProofWait}
    and ${issueRecoveryActions.evidence}->'retainedSourceFallback' is null
    and ${issueRecoveryActions.evidence}->'executionReconciliation' is null
    and ${stopProofRearms} < ${STOP_PROOF_MAX_REARMS})`;
}

/** When the next re-arm is due, in epoch milliseconds (0 = now). */
export function stopProofRearmDueAt() {
  return sql`case when ${stopProofMarker}->>'schema' = ${STOP_PROOF_RECOVERY_SCHEMA}
    and jsonb_typeof(${stopProofMarker}->'nextRearmAt') = 'number' then (${stopProofMarker}->>'nextRearmAt')::bigint else 0 end`;
}

export function stopProofRearmDueCondition(now: number) {
  return sql`(${stopProofRearmPendingCondition()} and ${stopProofRearmDueAt()} <= ${now}::bigint)`;
}

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
