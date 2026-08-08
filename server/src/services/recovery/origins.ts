export const RECOVERY_ORIGIN_KINDS = {
  issueGraphLivenessEscalation: "harness_liveness_escalation",
  issueProductivityReview: "issue_productivity_review",
  strandedIssueRecovery: "stranded_issue_recovery",
  staleActiveRunEvaluation: "stale_active_run_evaluation",
} as const;

export const RECOVERY_REASON_KINDS = {
  runLivenessContinuation: "run_liveness_continuation",
} as const;

export const RECOVERY_KEY_PREFIXES = {
  issueGraphLivenessIncident: "harness_liveness",
  issueGraphLivenessLeaf: "harness_liveness_leaf",
  /** Coarser than leaf: one open escalation per (company, source issue, state). TSMC-20489 */
  issueGraphLivenessRootCause: "harness_liveness_root",
} as const;

export type RecoveryOriginKind = typeof RECOVERY_ORIGIN_KINDS[keyof typeof RECOVERY_ORIGIN_KINDS];
export type RecoveryReasonKind = typeof RECOVERY_REASON_KINDS[keyof typeof RECOVERY_REASON_KINDS];
export type RecoveryKeyPrefix = typeof RECOVERY_KEY_PREFIXES[keyof typeof RECOVERY_KEY_PREFIXES];

export function isStrandedIssueRecoveryOriginKind(originKind: string | null | undefined) {
  return originKind === RECOVERY_ORIGIN_KINDS.strandedIssueRecovery;
}

/**
 * Origin kinds that are platform self-maintenance rather than product work.
 * Used to split blocked-count reporting so week-to-week tracking can follow
 * product blocked issues without being dominated by recover-stalled /
 * liveness / watchdog churn (TSMC-19763 / TSMC-19784).
 *
 * Includes the four recovery origin kinds plus the restart-lane recovery
 * origin written by sweepRestartLaneRecovery.
 */
export const PLATFORM_SELF_MAINTENANCE_ORIGIN_KINDS = new Set<string>([
  RECOVERY_ORIGIN_KINDS.issueGraphLivenessEscalation,
  RECOVERY_ORIGIN_KINDS.issueProductivityReview,
  RECOVERY_ORIGIN_KINDS.strandedIssueRecovery,
  RECOVERY_ORIGIN_KINDS.staleActiveRunEvaluation,
  "restart_lane_recovery",
]);

export function isPlatformSelfMaintenanceOriginKind(originKind: string | null | undefined): boolean {
  return typeof originKind === "string" && PLATFORM_SELF_MAINTENANCE_ORIGIN_KINDS.has(originKind);
}

export function buildIssueGraphLivenessIncidentKey(input: {
  companyId: string;
  issueId: string;
  state: string;
  blockerIssueId?: string | null;
  participantAgentId?: string | null;
}) {
  return [
    RECOVERY_KEY_PREFIXES.issueGraphLivenessIncident,
    input.companyId,
    input.issueId,
    input.state,
    input.blockerIssueId ?? input.participantAgentId ?? "none",
  ].join(":");
}

export function parseIssueGraphLivenessIncidentKey(incidentKey: string | null | undefined) {
  if (!incidentKey) return null;
  const parts = incidentKey.split(":");
  if (parts.length !== 5 || parts[0] !== RECOVERY_KEY_PREFIXES.issueGraphLivenessIncident) return null;
  const [, companyId, issueId, state, leafIssueId] = parts;
  if (!companyId || !issueId || !state || !leafIssueId) return null;
  return { companyId, issueId, state, leafIssueId };
}

export function buildIssueGraphLivenessLeafKey(input: {
  companyId: string;
  state: string;
  leafIssueId: string;
}) {
  return [
    RECOVERY_KEY_PREFIXES.issueGraphLivenessLeaf,
    input.companyId,
    input.state,
    input.leafIssueId,
  ].join(":");
}

// TSMC-20489: one open escalation per (company, source issue, state), coarser
// than both the incident key and the leaf key above. A single uninvokable
// assignee can leave N downstream dependents each discovering a DIFFERENT
// deepest blocker over time (as the blocker chain evolves between reconcile
// ticks) even though the SOURCE issue being examined never changes — the leaf
// key alone lets each of those N discoveries mint its own top-level ticket.
// This key rolls all of them up under the shared source+state instead.
export function buildIssueGraphLivenessRootCauseKey(input: {
  companyId: string;
  state: string;
  sourceIssueId: string;
}) {
  return [
    RECOVERY_KEY_PREFIXES.issueGraphLivenessRootCause,
    input.companyId,
    input.state,
    input.sourceIssueId,
  ].join(":");
}
