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
} as const;

/** Classifier-specific key: coalesce one active `stranded_issue_recovery` row per (source issue, invariant). */
export const STRANDED_ISSUE_RECOVERY_INVARIANT_KEYS = {
  /** Assigned issue exhausted automatic continuation (Progress Watch stranded queue). */
  strandedAssignedIssue: "stranded_assigned_issue",
} as const;

export type StrandedIssueRecoveryInvariantKey =
  (typeof STRANDED_ISSUE_RECOVERY_INVARIANT_KEYS)[keyof typeof STRANDED_ISSUE_RECOVERY_INVARIANT_KEYS];

export type RecoveryOriginKind = typeof RECOVERY_ORIGIN_KINDS[keyof typeof RECOVERY_ORIGIN_KINDS];
export type RecoveryReasonKind = typeof RECOVERY_REASON_KINDS[keyof typeof RECOVERY_REASON_KINDS];
export type RecoveryKeyPrefix = typeof RECOVERY_KEY_PREFIXES[keyof typeof RECOVERY_KEY_PREFIXES];

export function isStrandedIssueRecoveryOriginKind(originKind: string | null | undefined) {
  return originKind === RECOVERY_ORIGIN_KINDS.strandedIssueRecovery;
}

/**
 * Stable coalescing fingerprint: one active row per (company, source issue, recovery invariant)
 * — see `issues_active_stranded_issue_recovery_uq` on `(company_id, origin_kind, origin_id, origin_fingerprint)`.
 * Per-run detail stays on `originRunId` and comments, not in this string.
 */
export function buildStrandedIssueRecoveryFingerprint(
  companyId: string,
  sourceIssueId: string,
  recoveryInvariantKey: StrandedIssueRecoveryInvariantKey,
) {
  return [RECOVERY_ORIGIN_KINDS.strandedIssueRecovery, companyId, sourceIssueId, recoveryInvariantKey].join(":");
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
