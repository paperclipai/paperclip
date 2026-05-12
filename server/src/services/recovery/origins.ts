export const RECOVERY_ORIGIN_KINDS = {
  issueGraphLivenessEscalation: "harness_liveness_escalation",
  issueProductivityReview: "issue_productivity_review",
  strandedIssueRecovery: "stranded_issue_recovery",
  staleActiveRunEvaluation: "stale_active_run_evaluation",
  // Emitted by the AUR-33 retry-stall detector when a run has been retrying
  // upstream API errors past `PAPERCLIP_WATCHDOG_RETRY_STALL_ATTEMPT` for
  // longer than `PAPERCLIP_WATCHDOG_RETRY_STALL_BUDGET_SEC`. Listed alongside
  // `staleActiveRunEvaluation` so the hard cascade guard treats both as
  // watchdog-emitted origins that may not spawn further review issues.
  runtimeApiRetryExhausted: "runtime_api_retry_exhausted",
} as const;

// Source originKinds whose review-issue emission must be unconditionally
// suppressed by the hard cascade guard (depth=1). Per CEO comment on AUR-27.
export const WATCHDOG_RECURSIVE_ORIGIN_KINDS: readonly string[] = [
  RECOVERY_ORIGIN_KINDS.staleActiveRunEvaluation,
  RECOVERY_ORIGIN_KINDS.runtimeApiRetryExhausted,
];

export function isWatchdogRecursiveOriginKind(originKind: string | null | undefined): boolean {
  if (!originKind) return false;
  return WATCHDOG_RECURSIVE_ORIGIN_KINDS.includes(originKind);
}

export function buildRuntimeApiRetryExhaustedIdempotencyKey(input: { companyId: string; runId: string }): string {
  return `${RECOVERY_ORIGIN_KINDS.runtimeApiRetryExhausted}:${input.companyId}:${input.runId}`;
}

export const RECOVERY_REASON_KINDS = {
  runLivenessContinuation: "run_liveness_continuation",
} as const;

export const RECOVERY_KEY_PREFIXES = {
  issueGraphLivenessIncident: "harness_liveness",
  issueGraphLivenessLeaf: "harness_liveness_leaf",
} as const;

export type RecoveryOriginKind = typeof RECOVERY_ORIGIN_KINDS[keyof typeof RECOVERY_ORIGIN_KINDS];
export type RecoveryReasonKind = typeof RECOVERY_REASON_KINDS[keyof typeof RECOVERY_REASON_KINDS];
export type RecoveryKeyPrefix = typeof RECOVERY_KEY_PREFIXES[keyof typeof RECOVERY_KEY_PREFIXES];

export function isStrandedIssueRecoveryOriginKind(originKind: string | null | undefined) {
  return originKind === RECOVERY_ORIGIN_KINDS.strandedIssueRecovery;
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
