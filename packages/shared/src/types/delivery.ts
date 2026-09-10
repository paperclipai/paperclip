/**
 * Automated GitHub delivery lifecycle contract.
 *
 * A "delivery unit" is the delivery record for one reviewed candidate: one
 * remote repository + target branch + immutable revision, one pull request, one
 * receipt. A unit covers one or more issues (`coveredIssueIds`) and is the only
 * path by which a code-delivery issue may reach `done`.
 *
 * Delivery phase is intentionally separate from issue status. Issue status
 * carries the board lifecycle; delivery phase carries remote merge progress.
 * Blocking a delivery records a reason and keeps the phase it had.
 */

export const DELIVERY_PHASES = [
  "not_started",
  "in_review",
  "ready_to_merge",
  "merging",
  "done",
] as const;
export type DeliveryPhase = (typeof DELIVERY_PHASES)[number];

/** Issue statuses that only the delivery controller may write. */
export const DELIVERY_ISSUE_STATUSES = ["ready_to_merge", "merging"] as const;
export type DeliveryIssueStatus = (typeof DELIVERY_ISSUE_STATUSES)[number];

export const DELIVERY_UNIT_STATUSES = [
  "submitted",
  "in_review",
  "ready_to_merge",
  "merging",
  "merged",
  "blocked",
  "cancelled",
  "closed_unmerged",
] as const;
export type DeliveryUnitStatus = (typeof DELIVERY_UNIT_STATUSES)[number];

export const DELIVERY_QUEUE_STATUSES = [
  "queued",
  "leased",
  "merged",
  "cancelled",
  "blocked",
] as const;
export type DeliveryQueueStatus = (typeof DELIVERY_QUEUE_STATUSES)[number];

export const DELIVERY_MERGE_METHODS = ["merge", "squash", "rebase"] as const;
export type DeliveryMergeMethod = (typeof DELIVERY_MERGE_METHODS)[number];

/**
 * How the controller merges. `serialized` merges the head of the queue with the
 * accepted revision pinned; `native_merge_queue` enqueues into GitHub's own
 * merge queue and never merges directly.
 */
export const DELIVERY_MERGE_QUEUE_MODES = ["serialized", "native_merge_queue"] as const;
export type DeliveryMergeQueueMode = (typeof DELIVERY_MERGE_QUEUE_MODES)[number];

export const DELIVERY_AUTO_DEPLOY_DISPOSITIONS = [
  "none",
  "block_merge",
  "authorized",
] as const;
export type DeliveryAutoDeployDisposition = (typeof DELIVERY_AUTO_DEPLOY_DISPOSITIONS)[number];

export const DELIVERY_DEPENDENCY_KINDS = ["needs_artifact", "must_merge_after"] as const;
export type DeliveryDependencyKind = (typeof DELIVERY_DEPENDENCY_KINDS)[number];

export const DELIVERY_FINDING_DISPOSITIONS = [
  "fixed",
  "disputed",
  "already_addressed",
] as const;
export type DeliveryFindingDisposition = (typeof DELIVERY_FINDING_DISPOSITIONS)[number];

export const DELIVERY_FINDING_STATES = [
  "open",
  "fixed",
  "disputed",
  "already_addressed",
  "stale",
] as const;
export type DeliveryFindingState = (typeof DELIVERY_FINDING_STATES)[number];

export const DELIVERY_RECONCILIATION_CLASSIFICATIONS = [
  "code_verified",
  "code_unverified",
  "non_code",
  "unknown",
] as const;
export type DeliveryReconciliationClassification =
  (typeof DELIVERY_RECONCILIATION_CLASSIFICATIONS)[number];

export const DELIVERY_RECONCILIATION_OUTCOMES = [
  "verified",
  "needs_merge",
  "needs_candidate",
  "dispositioned",
  "unresolved",
] as const;
export type DeliveryReconciliationOutcome = (typeof DELIVERY_RECONCILIATION_OUTCOMES)[number];

/**
 * Stable machine reasons for a delivery blocker. These are persisted, surfaced
 * in `DeliverySummary.blocker.reasonCode`, and never derived from free text.
 */
export const DELIVERY_BLOCKER_REASON_CODES = [
  "policy_disabled",
  "policy_paused",
  "policy_missing",
  "repository_unverified",
  "connection_missing",
  "candidate_required",
  "disposition_required",
  "artifact_not_ready",
  "dependency_needs_artifact",
  "dependency_must_merge_after",
  "dependency_cycle",
  "checks_failing",
  "checks_pending",
  "review_blocking_findings",
  "review_head_stale",
  "head_stale",
  "base_stale",
  "conflict",
  "merge_queue_blocked",
  "merge_unknown",
  "merge_rejected",
  "deployment_authority_missing",
  "greptile_required",
  "greptile_unavailable",
  "repair_attempts_exhausted",
  "operator_cancelled",
  "operator_paused",
  "lease_lost",
  "provider_unknown",
] as const;
export type DeliveryBlockerReasonCode = (typeof DELIVERY_BLOCKER_REASON_CODES)[number];

export const DELIVERY_EVENT_TYPES = [
  "candidate_submitted",
  "candidate_published",
  "artifact_ready",
  "checks_changed",
  "review_changed",
  "review_finding",
  "finding_disposition",
  "queue_enqueued",
  "queue_leased",
  "queue_position_changed",
  "merge_started",
  "merge_queued",
  "merged",
  "merge_unknown",
  "merge_rejected",
  "pr_closed_unmerged",
  "head_changed",
  "blocked",
  "unblocked",
  "repair_requested",
  "repair_exhausted",
  "escalated",
  "paused",
  "resumed",
  "cancelled",
  "reconciled",
  "receipt_issued",
] as const;
export type DeliveryEventType = (typeof DELIVERY_EVENT_TYPES)[number];

export type DeliveryCheck = {
  name: string;
  status: string;
  url: string | null;
};

export type DeliveryReview = {
  status: string;
  headSha: string | null;
  blockingFindings: number;
};

export type DeliveryBlocker = {
  reasonCode: string;
  message: string;
  owner: string | null;
  nextAction: string | null;
};

export type DeliveryEvent = {
  id: string;
  type: string;
  message: string;
  createdAt: string;
  url: string | null;
};

/** The single summary shape consumed by the board UI and the Pi delivery tools. */
export type DeliverySummary = {
  issueId: string;
  codeDelivery: boolean;
  artifactReady: boolean;
  /** True when the delivery policy or the unit itself is operator-paused. */
  paused: boolean;
  phase: DeliveryPhase;
  repository: string | null;
  targetBranch: string | null;
  unitId: string | null;
  prUrl: string | null;
  prNumber: number | null;
  headSha: string | null;
  mergedSha: string | null;
  ownerAgentId: string | null;
  queuePosition: number | null;
  checks: DeliveryCheck[];
  review: DeliveryReview;
  blocker: DeliveryBlocker | null;
  nextAction: string | null;
  lastEventAt: string | null;
  events: DeliveryEvent[];
};

export type DeliveryIssueList = {
  items: DeliverySummary[];
};

/**
 * Operator-approved, versioned repository delivery policy. Auto-merge requires a
 * persisted policy whose authorization record names the approving operator.
 */
export type DeliveryPolicyAuthorization = {
  approvedByUserId: string;
  approvedAt: string;
  statement: string;
  scope: "project" | "repository";
};

export type DeliveryPolicy = {
  id: string;
  companyId: string;
  projectId: string;
  repositoryId: string | null;
  repository: string | null;
  repositoryHost: string;
  repositoryOwner: string | null;
  repositoryName: string | null;
  githubRepositoryId: string | null;
  targetBranch: string;
  enabled: boolean;
  paused: boolean;
  mergeMethod: DeliveryMergeMethod;
  mergeQueueMode: DeliveryMergeQueueMode;
  requiredChecks: string[];
  requireGreptile: boolean;
  requireIndependentApproval: boolean;
  githubConnectionId: string | null;
  greptileConnectionId: string | null;
  autoDeployDisposition: DeliveryAutoDeployDisposition;
  authorization: DeliveryPolicyAuthorization | null;
  version: number;
  createdAt: string;
  updatedAt: string;
};


export type DeliveryFinding = {
  id: string;
  externalId: string;
  severity: string;
  title: string;
  body: string | null;
  filePath: string | null;
  line: number | null;
  url: string | null;
  headSha: string | null;
  state: DeliveryFindingState;
  disposition: DeliveryFindingDisposition | null;
  dispositionExplanation: string | null;
  dispositionAt: string | null;
  firstSeenAt: string;
  lastSeenAt: string;
};

export type DeliveryReviewSummary = {
  issueId: string;
  repository: string | null;
  targetBranch: string | null;
  prNumber: number | null;
  headSha: string | null;
  reviewedHeadSha: string | null;
  status: string;
  blockingFindings: number;
  findings: DeliveryFinding[];
  nextAction: string | null;
  fetchedAt: string | null;
};

export type DeliveryReconciliationItem = {
  issueId: string;
  identifier: string | null;
  title: string;
  projectId: string | null;
  issueStatus: string;
  classification: DeliveryReconciliationClassification;
  outcome: DeliveryReconciliationOutcome;
  unitId: string | null;
  repository: string | null;
  targetBranch: string | null;
  prNumber: number | null;
  prUrl: string | null;
  headSha: string | null;
  mergedSha: string | null;
  provenance: DeliveryProvenance | null;
  disposition: DeliveryDisposition | null;
  reconciledAt: string | null;
};

/** Exact accepted-revision provenance recorded on the delivery receipt. */
export type DeliveryProvenance = {
  repository: string;
  githubRepositoryId: string | null;
  targetBranch: string;
  sourceBranch: string;
  submittedHeadSha: string;
  acceptedHeadSha: string;
  baseSha: string | null;
  mergedSha: string;
  mergeCommitSha: string | null;
  /** Historical imports cannot infer a merge method from today's policy. */
  mergeMethod: DeliveryMergeMethod | "unknown";
  squashOrRebase: boolean;
  checks: DeliveryCheck[];
  reviewStatus: string;
  blockingFindings: number;
  verifiedAt: string;
};

export type DeliveryDisposition = {
  reasonCode: string;
  message: string;
  owner: string | null;
  nextAction: string | null;
  actorType: "user" | "agent" | "system";
  actorId: string;
  at: string;
};

export type DeliveryReconciliationInventory = {
  companyId: string;
  generatedAt: string;
  counts: Record<DeliveryReconciliationClassification, number>;
  items: DeliveryReconciliationItem[];
};

export type DeliveryQueueEntry = {
  unitId: string;
  issueId: string;
  repository: string;
  targetBranch: string;
  status: DeliveryQueueStatus;
  priority: string;
  position: number;
  leaseOwner: string | null;
  leaseExpiresAt: string | null;
  enqueuedAt: string;
};

export type DeliveryUnitDetail = {
  unitId: string;
  companyId: string;
  projectId: string | null;
  issueId: string;
  coveredIssueIds: string[];
  status: DeliveryUnitStatus;
  repository: string;
  targetBranch: string;
  sourceBranch: string;
  baseSha: string | null;
  headSha: string | null;
  acceptedHeadSha: string | null;
  mergedSha: string | null;
  prNumber: number | null;
  prUrl: string | null;
  mergeMethod: DeliveryMergeMethod;
  ownerAgentId: string | null;
  artifactReady: boolean;
  queue: DeliveryQueueEntry | null;
  provenance: DeliveryProvenance | null;
  dependencies: Array<{
    kind: DeliveryDependencyKind;
    unitId: string;
    issueId: string | null;
    satisfied: boolean;
  }>;
  createdAt: string;
  updatedAt: string;
};
