/**
 * Delivery tracking types.
 *
 * This is an opt-in, per-issue workflow: an issue only gains candidate/verdict/
 * acceptance semantics after something explicitly enrolls it. Ordinary issues
 * are completely unaffected — no plan ceremony, no review requirement, no
 * evidence requirement, no project-wide rules.
 *
 * An orchestrator can therefore create, delegate, parallelize and revise
 * ordinary work with no extra lifecycle, and enroll only the specific tasks
 * whose completion must be pinned to a reviewed, evidence-backed candidate.
 */

export const DELIVERY_VERDICTS = ["pass", "changes_requested"] as const;
export type DeliveryVerdict = (typeof DELIVERY_VERDICTS)[number];

export const DELIVERY_EVIDENCE_KINDS = ["command_result", "artifact_digest", "external_check"] as const;
export type DeliveryEvidenceKind = (typeof DELIVERY_EVIDENCE_KINDS)[number];

/**
 * Stable denial codes. Callers branch on these instead of matching prose, and
 * they are the assertion surface for regression tests.
 */
export const DELIVERY_DENIAL_CODES = [
  "delivery_not_enrolled",
  "delivery_plan_revision_stale",
  "delivery_plan_revision_mismatch",
  "delivery_writer_not_current",
  "delivery_actor_run_required",
  "delivery_actor_run_not_current",
  "delivery_repository_mismatch",
  "delivery_candidate_unknown",
  "delivery_candidate_superseded",
  "delivery_review_missing",
  "delivery_review_not_passed",
  "delivery_reviewer_not_independent",
  "delivery_reviewer_not_allowed",
  "delivery_evidence_missing",
  "delivery_evidence_untrusted",
  "delivery_acceptance_missing",
  "delivery_acceptance_stale",
  "delivery_acceptance_actor_forbidden",
] as const;
export type DeliveryDenialCode = (typeof DELIVERY_DENIAL_CODES)[number];

/**
 * Per-issue enrollment. Every requirement is explicit and local to the issue.
 *
 * `repositoryUrl` pins the repository a candidate may name. `reviewerAgentIds`
 * is optional: empty means any agent other than the submitter may review, which
 * keeps delegation flexible while still forcing reviewer independence.
 */
export interface DeliveryTrack {
  id: string;
  issueId: string;
  projectId: string | null;
  repositoryUrl: string | null;
  requireReview: boolean;
  requireVerifiedEvidence: boolean;
  /** When true, submissions and acceptance must name the current accepted plan revision. */
  pinPlanRevision: boolean;
  reviewerAgentIds: string[];
  status: "active" | "closed";
  enrolledByAgentId: string | null;
  enrolledByUserId: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * Plan revision identity as the server derives it, never as a caller asserts
 * it. Only meaningful for a track with `pinPlanRevision`.
 *
 * `effectiveRevisionId` is non-null only when the accepted plan revision is
 * also the plan document's latest revision, so a later plan edit makes the
 * accepted revision historical and stops acceptance until it is accepted again.
 */
export interface DeliveryPlanRevisionState {
  planDocumentId: string | null;
  acceptedRevisionId: string | null;
  acceptedRevisionNumber: number | null;
  acceptedInteractionId: string | null;
  latestRevisionId: string | null;
  latestRevisionNumber: number | null;
  effectiveRevisionId: string | null;
  stale: boolean;
  staleReason: "no_plan_document" | "no_accepted_revision" | "superseded_by_newer_revision" | null;
}

export interface DeliveryCandidate {
  repositoryUrl: string;
  headSha: string;
  baseSha: string;
}

export interface DeliverySubmissionRecord {
  id: string;
  issueId: string;
  planRevisionId: string | null;
  candidate: DeliveryCandidate;
  submittedByAgentId: string | null;
  submittedByUserId: string | null;
  submittedByRunId: string | null;
  evidenceIds: string[];
  supersededAt: string | null;
  createdAt: string;
}

export interface DeliveryVerdictFinding {
  summary: string;
  evidenceRef?: string;
}

export interface DeliveryVerdictRecord {
  id: string;
  issueId: string;
  submissionId: string;
  planRevisionId: string | null;
  candidateHeadSha: string;
  verdict: DeliveryVerdict;
  findings: DeliveryVerdictFinding[];
  reviewerAgentId: string | null;
  reviewerRunId: string | null;
  evidenceIds: string[];
  createdAt: string;
}

export interface DeliveryEvidenceRecord {
  id: string;
  issueId: string;
  planRevisionId: string | null;
  candidateHeadSha: string;
  kind: DeliveryEvidenceKind;
  digest: string;
  producerLabel: string;
  producedByUserId: string | null;
  summary: Record<string, unknown>;
  createdAt: string;
}

export interface DeliveryAcceptanceRecord {
  id: string;
  issueId: string;
  submissionId: string;
  verdictId: string | null;
  planRevisionId: string | null;
  candidateHeadSha: string;
  evidenceIds: string[];
  acceptedByUserId: string;
  createdAt: string;
}

export type DeliveryAction = "enroll" | "submit" | "verdict" | "accept" | "ingest_evidence";

export interface DeliveryStateSnapshot {
  issueId: string;
  enrolled: boolean;
  track: DeliveryTrack | null;
  planRevision: DeliveryPlanRevisionState | null;
  /** The run the server considers current for this issue, from native checkout state. */
  currentWriter: {
    agentId: string | null;
    runId: string | null;
    runStatus: string | null;
  } | null;
  actorIsCurrentWriter: boolean;
  currentSubmission: DeliverySubmissionRecord | null;
  currentVerdict: DeliveryVerdictRecord | null;
  acceptance: DeliveryAcceptanceRecord | null;
  evidence: DeliveryEvidenceRecord[];
  allowedActions: DeliveryAction[];
  blockers: DeliveryDenialCode[];
}
