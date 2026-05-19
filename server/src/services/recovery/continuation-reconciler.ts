import { selectApprovalContinuationRouting } from "../../routes/approvals.js";

export const STALE_CONTINUATION_THRESHOLD_MS = 5 * 60 * 1000;

export const APPROVAL_NO_FOLLOW_UP_ESCALATED_ACTION =
  "approval.no_follow_up_escalated";
export const CONFIRMATION_NO_FOLLOW_UP_ESCALATED_ACTION =
  "confirmation.no_follow_up_escalated";
export const APPROVAL_FOLLOW_UP_REQUEUED_ACTION =
  "approval.follow_up_requeued";
export const CONFIRMATION_FOLLOW_UP_REQUEUED_ACTION =
  "confirmation.follow_up_requeued";

export const APPROVAL_RECONCILED_ACTIONS = new Set<string>([
  APPROVAL_NO_FOLLOW_UP_ESCALATED_ACTION,
  APPROVAL_FOLLOW_UP_REQUEUED_ACTION,
]);

export const CONFIRMATION_RECONCILED_ACTIONS = new Set<string>([
  CONFIRMATION_NO_FOLLOW_UP_ESCALATED_ACTION,
  CONFIRMATION_FOLLOW_UP_REQUEUED_ACTION,
]);

export type ReconciliationSkipReason =
  | "no_decided_at"
  | "below_threshold"
  | "has_active_execution_path"
  | "has_queued_or_deferred_wake"
  | "already_reconciled"
  | "no_requester_agent";

export type ReconciliationDecision =
  | { kind: "skip"; reason: ReconciliationSkipReason }
  | {
      kind: "requeue_with_primary";
      primaryIssueId: string;
      actionableIssueIds: string[];
      blockedIssueIds: string[];
      linkedIssueIds: string[];
    }
  | {
      kind: "escalate_no_follow_up";
      reason: "all_linked_issues_blocked" | "no_linked_issues";
      blockedIssueIds: string[];
      linkedIssueIds: string[];
    };

export type StaleApprovalCandidate = {
  approvalId: string;
  requestedByAgentId: string | null;
  decidedAt: Date | null;
  linkedIssues: Array<{ id: string; status: string | null }>;
  hasActiveExecutionPath: boolean;
  hasQueuedOrDeferredWake: boolean;
  alreadyReconciled: boolean;
};

export type StaleConfirmationCandidate = {
  interactionId: string;
  issueId: string;
  assigneeAgentId: string | null;
  issueStatus: string | null;
  resolvedAt: Date | null;
  hasActiveExecutionPath: boolean;
  hasQueuedOrDeferredWake: boolean;
  alreadyReconciled: boolean;
};

const TERMINAL_ISSUE_STATUSES = new Set<string>([
  "done",
  "cancelled",
  "blocked",
]);

function isBelowThreshold(
  decidedAt: Date | null,
  now: Date,
  thresholdMs: number,
): boolean {
  if (!decidedAt) return true;
  return now.getTime() - decidedAt.getTime() < thresholdMs;
}

export function evaluateApprovalReconciliation(
  candidate: StaleApprovalCandidate,
  now: Date,
  thresholdMs: number = STALE_CONTINUATION_THRESHOLD_MS,
): ReconciliationDecision {
  if (!candidate.decidedAt) {
    return { kind: "skip", reason: "no_decided_at" };
  }
  if (isBelowThreshold(candidate.decidedAt, now, thresholdMs)) {
    return { kind: "skip", reason: "below_threshold" };
  }
  if (candidate.alreadyReconciled) {
    return { kind: "skip", reason: "already_reconciled" };
  }
  if (candidate.hasActiveExecutionPath) {
    return { kind: "skip", reason: "has_active_execution_path" };
  }
  if (candidate.hasQueuedOrDeferredWake) {
    return { kind: "skip", reason: "has_queued_or_deferred_wake" };
  }
  if (!candidate.requestedByAgentId) {
    return { kind: "skip", reason: "no_requester_agent" };
  }

  const routing = selectApprovalContinuationRouting(
    candidate.linkedIssues.map((issue) => ({
      id: issue.id,
      status: issue.status,
    })),
  );

  if (routing.linkedIssueIds.length === 0) {
    return {
      kind: "escalate_no_follow_up",
      reason: "no_linked_issues",
      blockedIssueIds: [],
      linkedIssueIds: [],
    };
  }

  if (routing.allLinkedBlocked || !routing.primaryIssueId) {
    return {
      kind: "escalate_no_follow_up",
      reason: "all_linked_issues_blocked",
      blockedIssueIds: routing.blockedIssueIds,
      linkedIssueIds: routing.linkedIssueIds,
    };
  }

  return {
    kind: "requeue_with_primary",
    primaryIssueId: routing.primaryIssueId,
    actionableIssueIds: routing.actionableIssueIds,
    blockedIssueIds: routing.blockedIssueIds,
    linkedIssueIds: routing.linkedIssueIds,
  };
}

export function evaluateConfirmationReconciliation(
  candidate: StaleConfirmationCandidate,
  now: Date,
  thresholdMs: number = STALE_CONTINUATION_THRESHOLD_MS,
): ReconciliationDecision {
  if (!candidate.resolvedAt) {
    return { kind: "skip", reason: "no_decided_at" };
  }
  if (isBelowThreshold(candidate.resolvedAt, now, thresholdMs)) {
    return { kind: "skip", reason: "below_threshold" };
  }
  if (candidate.alreadyReconciled) {
    return { kind: "skip", reason: "already_reconciled" };
  }
  if (candidate.hasActiveExecutionPath) {
    return { kind: "skip", reason: "has_active_execution_path" };
  }
  if (candidate.hasQueuedOrDeferredWake) {
    return { kind: "skip", reason: "has_queued_or_deferred_wake" };
  }
  if (!candidate.assigneeAgentId) {
    return { kind: "skip", reason: "no_requester_agent" };
  }

  const issueStatus = candidate.issueStatus ?? "";
  const issueIsActionable = !TERMINAL_ISSUE_STATUSES.has(issueStatus);

  if (!issueIsActionable) {
    return {
      kind: "escalate_no_follow_up",
      reason: "all_linked_issues_blocked",
      blockedIssueIds: [candidate.issueId],
      linkedIssueIds: [candidate.issueId],
    };
  }

  return {
    kind: "requeue_with_primary",
    primaryIssueId: candidate.issueId,
    actionableIssueIds: [candidate.issueId],
    blockedIssueIds: [],
    linkedIssueIds: [candidate.issueId],
  };
}
