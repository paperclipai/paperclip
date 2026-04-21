import { resolveReleaseGateQaAgent } from "@paperclipai/shared";
import type { Agent, IssueQaGateReasonCode, IssueStatus } from "@paperclipai/shared";

function resolvePreQaBlockedState(input: {
  agents?: Array<Pick<Agent, "id" | "name" | "role" | "status" | "title">> | null;
}) {
  if (!input.agents) return null;
  const qaResolution = resolveReleaseGateQaAgent(input.agents);
  if (qaResolution.releaseGateQaAgent) {
    return null;
  }

  if (qaResolution.resolution === "none") {
    return {
      actionLabel: "QA Blocked",
      actionStatus: null,
      statusLabel: "No healthy QA available",
      blockingMessage: "No healthy QA agent is available to own this review right now.",
    } as const;
  }

  return {
    actionLabel: "Pick QA First",
    actionStatus: null,
    statusLabel: "Board must pick QA",
    blockingMessage: "Assign a single healthy QA owner before starting review.",
  } as const;
}

type SmartReviewGateState = {
  blockingMessage?: string;
  blockingDetails?: string[];
};

type ReviewRequirementPresentation = {
  kind: "missing_comment" | "incomplete_verdict" | "failing_verdict" | "needs_in_review" | "generic";
  message: string;
  details?: string[];
};

type SmartReviewPresentation = {
  actionLabel: string;
  actionStatus: "in_review" | "done" | null;
  statusLabel: string;
  blockingMessage?: string;
  blockingDetails?: string[];
};

const OWNERSHIP_REASON_CODES = new Set<IssueQaGateReasonCode>([
  "qa_gate_no_eligible_qa_agent",
  "qa_gate_requires_qa_assignee",
]);

const INCOMPLETE_VERDICT_LABELS: Array<[IssueQaGateReasonCode, string]> = [
  ["qa_gate_missing_qa_pass", "[QA PASS]"],
  ["qa_gate_missing_release_confirmation", "[RELEASE CONFIRMED]"],
  ["qa_gate_missing_qa_summary", "Smart Review summary"],
  ["qa_gate_missing_test_coverage_verdict", "explicit Test Coverage verdict"],
  ["qa_gate_missing_verification", "verification evidence"],
];

const FALLBACK_REASON_LABELS: Record<IssueQaGateReasonCode, string> = {
  invalid_status_transition: "Issue update rejected.",
  qa_gate_requires_qa_assignee: "Assign the canonical QA owner before continuing review.",
  qa_gate_no_eligible_qa_agent: "No healthy QA owner is available right now.",
  qa_gate_requires_in_review: "Move the issue into QA before shipping.",
  qa_gate_missing_qa_comment: "Latest QA verdict is missing.",
  qa_gate_missing_qa_summary: "Latest QA verdict is missing the Smart Review summary.",
  qa_gate_missing_test_coverage_verdict: "Latest QA verdict must set Test Coverage to pass, warn, or fail.",
  qa_gate_missing_qa_pass: "Latest QA verdict is missing [QA PASS].",
  qa_gate_missing_release_confirmation: "Latest QA verdict is missing [RELEASE CONFIRMED].",
  qa_gate_missing_verification: "Latest QA verdict is missing verification evidence.",
  qa_gate_failing_review: "Latest QA Smart Review is failing.",
  qa_gate_failing_verification: "Latest QA verification evidence is failing.",
};

function withBlockingDetails(blockingMessage: string, blockingDetails?: string[]): SmartReviewGateState {
  return blockingDetails?.length
    ? { blockingMessage, blockingDetails }
    : { blockingMessage };
}

function describeReviewRequirements(
  issueStatus: IssueStatus,
  missingRequirements: IssueQaGateReasonCode[] | null | undefined,
): ReviewRequirementPresentation | null {
  const reviewReasons = (missingRequirements ?? []).filter((reasonCode) => !OWNERSHIP_REASON_CODES.has(reasonCode));
  if (reviewReasons.length === 0) return null;

  const reviewReasonSet = new Set(reviewReasons);

  if (issueStatus !== "in_review" && reviewReasonSet.has("qa_gate_requires_in_review")) {
    return {
      kind: "needs_in_review",
      message: "Move the issue into QA before shipping.",
    };
  }

  if (reviewReasonSet.has("qa_gate_missing_qa_comment")) {
    return {
      kind: "missing_comment",
      message: "Latest QA verdict is missing.",
    };
  }

  const missingVerdictParts = INCOMPLETE_VERDICT_LABELS
    .filter(([reasonCode]) => reviewReasonSet.has(reasonCode))
    .map(([, label]) => label);
  if (missingVerdictParts.length > 0) {
    return {
      kind: "incomplete_verdict",
      message: "Latest QA verdict is incomplete.",
      details: [`Missing: ${missingVerdictParts.join(", ")}.`],
    };
  }

  const failingDetails = [
    reviewReasonSet.has("qa_gate_failing_review") ? "Smart Review verdict is failing." : null,
    reviewReasonSet.has("qa_gate_failing_verification") ? "Verification evidence is failing." : null,
  ].filter((detail): detail is string => Boolean(detail));
  if (failingDetails.length > 0) {
    return {
      kind: "failing_verdict",
      message: "Latest QA verdict is failing.",
      details: failingDetails,
    };
  }

  const fallbackMessages = reviewReasons.map((reasonCode) => FALLBACK_REASON_LABELS[reasonCode] ?? reasonCode);
  return {
    kind: "generic",
    message: fallbackMessages[0] ?? "Issue update rejected.",
    details: fallbackMessages.slice(1),
  };
}

function deferredReviewRequirementMessage(requirement: ReviewRequirementPresentation): string {
  switch (requirement.kind) {
    case "missing_comment":
      return "Also true once QA ownership is restored: there is no QA verdict yet.";
    case "incomplete_verdict":
      return "Also true once QA ownership is restored: the latest QA verdict is incomplete.";
    case "failing_verdict":
      return "Also true once QA ownership is restored: the latest QA verdict is failing.";
    case "needs_in_review":
      return "Also true once QA ownership is restored: the issue still must enter QA before shipping.";
    case "generic":
    default:
      return `Also true once QA ownership is restored: ${requirement.message}`;
  }
}

function resolveReviewBlockedState(input: {
  issueStatus: IssueStatus;
  missingRequirements?: IssueQaGateReasonCode[] | null;
}): SmartReviewGateState | null {
  const missingRequirements = input.missingRequirements ?? [];
  if (missingRequirements.length === 0) return null;

  const missingRequirementSet = new Set(missingRequirements);
  const reviewRequirement = describeReviewRequirements(input.issueStatus, missingRequirements);

  if (missingRequirementSet.has("qa_gate_no_eligible_qa_agent")) {
    return withBlockingDetails(
      "QA blocked: no healthy QA owner is available.",
      reviewRequirement
        ? [deferredReviewRequirementMessage(reviewRequirement), ...(reviewRequirement.details ?? [])]
        : undefined,
    );
  }

  if (missingRequirementSet.has("qa_gate_requires_qa_assignee")) {
    return withBlockingDetails(
      "QA blocked: assign the canonical QA owner first.",
      reviewRequirement
        ? [deferredReviewRequirementMessage(reviewRequirement), ...(reviewRequirement.details ?? [])]
        : undefined,
    );
  }

  if (!reviewRequirement) return null;
  return withBlockingDetails(reviewRequirement.message, reviewRequirement.details);
}

export function getSmartReviewPresentation(input: {
  issueStatus: IssueStatus;
  lastQaSummaryAt: Date | string | number | null;
  assigneeAgentId?: string | null;
  assigneeUserId?: string | null;
  agents?: Array<Pick<Agent, "id" | "name" | "role" | "status" | "title">> | null;
  missingRequirements?: IssueQaGateReasonCode[] | null;
}): SmartReviewPresentation {
  const parsedLastQaSummaryAt = (() => {
    if (!input.lastQaSummaryAt) return null;
    if (input.lastQaSummaryAt instanceof Date) return input.lastQaSummaryAt;
    const parsed = new Date(input.lastQaSummaryAt);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  })();
  const statusLabel = parsedLastQaSummaryAt
    ? `Last summary ${parsedLastQaSummaryAt.toISOString()}`
    : input.issueStatus === "in_review"
      ? "No QA summary yet"
      : "Not in QA yet";
  const reviewBlockedState = resolveReviewBlockedState({
    issueStatus: input.issueStatus,
    missingRequirements: input.missingRequirements,
  });

  if (input.issueStatus === "in_review") {
    return {
      actionLabel: "QA Ship",
      actionStatus: "done" as const,
      statusLabel,
      ...reviewBlockedState,
    };
  }

  if (["backlog", "todo", "in_progress", "blocked"].includes(input.issueStatus)) {
    const blockedState = resolvePreQaBlockedState({
      agents: input.agents,
    });
    if (blockedState) return blockedState;

    return {
      actionLabel: "Start QA",
      actionStatus: "in_review" as const,
      statusLabel,
    };
  }

  return {
    actionLabel: "QA Closed",
    actionStatus: null,
    statusLabel,
    ...reviewBlockedState,
  };
}

export function getSmartReviewActionUi(input: {
  actionStatus: SmartReviewPresentation["actionStatus"];
  canShip: boolean;
  isPending: boolean;
}) {
  return {
    variant:
      input.actionStatus === "in_review" || (input.actionStatus === "done" && input.canShip)
        ? "default" as const
        : "outline" as const,
    disabled: !input.actionStatus || input.isPending,
  };
}
