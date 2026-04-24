import type { AgentStatus } from "./constants.js";
import { isEligibleQaAgentStatus } from "./release-gate-qa.js";

export type QaReviewerCandidate = {
  id: string;
  role?: string | null;
  status?: AgentStatus | string | null;
};

export type QaReviewerSelectionReason =
  | "sticky_reuse"
  | "preferred_tiebreaker"
  | "least_loaded"
  | "none";

export type QaReviewerSelection = {
  reviewerAgentId: string | null;
  reason: QaReviewerSelectionReason;
  eligibleAgentIds: string[];
};

function reviewerStatusRank(status: AgentStatus | string | null | undefined) {
  switch (status) {
    case "idle":
      return 0;
    case "active":
      return 1;
    case "running":
      return 2;
    default:
      return 3;
  }
}

export function selectPooledQaReviewer(input: {
  reviewers: QaReviewerCandidate[];
  stickyReviewerAgentId?: string | null;
  preferredReviewerAgentId?: string | null;
  openIssueCountByAgentId?: ReadonlyMap<string, number>;
}): QaReviewerSelection {
  const eligibleReviewers = input.reviewers.filter((reviewer) =>
    reviewer.role === "qa" && isEligibleQaAgentStatus(reviewer.status));
  const eligibleAgentIds = eligibleReviewers.map((reviewer) => reviewer.id);

  if (eligibleReviewers.length === 0) {
    return {
      reviewerAgentId: null,
      reason: "none",
      eligibleAgentIds,
    };
  }

  const stickyReviewerId = input.stickyReviewerAgentId?.trim() || null;
  if (stickyReviewerId && eligibleReviewers.some((reviewer) => reviewer.id === stickyReviewerId)) {
    return {
      reviewerAgentId: stickyReviewerId,
      reason: "sticky_reuse",
      eligibleAgentIds,
    };
  }

  const openIssueCountByAgentId = input.openIssueCountByAgentId ?? new Map<string, number>();
  const minimumLoad = eligibleReviewers.reduce((lowest, reviewer) => {
    const load = openIssueCountByAgentId.get(reviewer.id) ?? 0;
    return Math.min(lowest, load);
  }, Number.POSITIVE_INFINITY);
  const leastLoadedReviewers = eligibleReviewers.filter((reviewer) =>
    (openIssueCountByAgentId.get(reviewer.id) ?? 0) === minimumLoad);

  const preferredReviewerId = input.preferredReviewerAgentId?.trim() || null;
  if (preferredReviewerId && leastLoadedReviewers.some((reviewer) => reviewer.id === preferredReviewerId)) {
    return {
      reviewerAgentId: preferredReviewerId,
      reason: "preferred_tiebreaker",
      eligibleAgentIds,
    };
  }

  const selectedReviewer = [...leastLoadedReviewers].sort((left, right) => {
    const statusRank = reviewerStatusRank(left.status) - reviewerStatusRank(right.status);
    if (statusRank !== 0) return statusRank;
    return left.id.localeCompare(right.id);
  })[0] ?? null;

  return {
    reviewerAgentId: selectedReviewer?.id ?? null,
    reason: selectedReviewer ? "least_loaded" : "none",
    eligibleAgentIds,
  };
}
