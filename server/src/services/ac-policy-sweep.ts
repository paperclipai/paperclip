const TERMINAL_STATUSES = new Set(["done", "cancelled"]);

const PRODUCTIVITY_REVIEW_ORIGIN_KINDS = new Set([
  "issue_productivity_review",
  "productivity_review_escalation",
]);

export const DEFAULT_AC_POLICY_CANCEL_SAFETY_CAP = 25;

export type AcPolicyIssueRef = {
  id: string;
  identifier?: string | null;
  status?: string | null;
};

export type AcPolicyCancelCandidate = {
  id: string;
  identifier?: string | null;
  title: string;
  status: string;
  assigneeAgentId?: string | null;
  assigneeUserId?: string | null;
  createdByUserId?: string | null;
  originKind?: string | null;
  blocks?: AcPolicyIssueRef[] | null;
};

export type AcPolicyCandidateClassification =
  | { bucket: "auto-cancel-safe" }
  | { bucket: "needs-human-triage"; reasons: string[] };

export function classifyAcPolicyCancelCandidate(
  candidate: AcPolicyCancelCandidate,
): AcPolicyCandidateClassification {
  const reasons: string[] = [];

  if (candidate.assigneeUserId) {
    reasons.push("user_assigned");
  }

  if (candidate.createdByUserId) {
    reasons.push("user_owned_protected");
  }

  if (candidate.originKind && PRODUCTIVITY_REVIEW_ORIGIN_KINDS.has(candidate.originKind)) {
    reasons.push("productivity_review_escalation");
  } else if (candidate.title.toLowerCase().includes("productivity-review escalation")) {
    reasons.push("productivity_review_escalation");
  }

  const activeBlockedParents = (candidate.blocks ?? []).filter((parent) => {
    const status = parent.status ?? null;
    return status === null || !TERMINAL_STATUSES.has(status);
  });
  if (activeBlockedParents.length > 0) {
    reasons.push("active_blocker_for_non_terminal_parent");
  }

  if (reasons.length > 0) return { bucket: "needs-human-triage", reasons };
  return { bucket: "auto-cancel-safe" };
}

export function partitionAcPolicyCancelCandidates(candidates: AcPolicyCancelCandidate[]) {
  const autoCancelSafe: AcPolicyCancelCandidate[] = [];
  const needsHumanTriage: Array<AcPolicyCancelCandidate & { triageReasons: string[] }> = [];

  for (const candidate of candidates) {
    const classification = classifyAcPolicyCancelCandidate(candidate);
    if (classification.bucket === "auto-cancel-safe") {
      autoCancelSafe.push(candidate);
    } else {
      needsHumanTriage.push({ ...candidate, triageReasons: classification.reasons });
    }
  }

  return { autoCancelSafe, needsHumanTriage };
}

export function planAcPolicyAutoCancelBatch(
  candidates: AcPolicyCancelCandidate[],
  safetyCap = DEFAULT_AC_POLICY_CANCEL_SAFETY_CAP,
) {
  const partitioned = partitionAcPolicyCancelCandidates(candidates);
  const cancelPaused = partitioned.autoCancelSafe.length > safetyCap;

  return {
    ...partitioned,
    safetyCap,
    cancelPaused,
    autoCancelBatch: cancelPaused ? [] : partitioned.autoCancelSafe,
  };
}

function formatIssueRef(issue: AcPolicyCancelCandidate) {
  return issue.identifier ? `${issue.identifier} (${issue.id})` : issue.id;
}

export function formatAcPolicyCancelDashboardSections(candidates: AcPolicyCancelCandidate[]) {
  const plan = planAcPolicyAutoCancelBatch(candidates);
  const lines: string[] = [`### Auto-cancel-safe candidates (${plan.autoCancelSafe.length})`];

  if (plan.cancelPaused) {
    lines.push(
      `Cancellation paused: ${plan.autoCancelSafe.length} safe candidates exceeds safety cap ${plan.safetyCap}.`,
    );
  }

  if (plan.autoCancelSafe.length === 0) {
    lines.push("- None");
  } else {
    for (const candidate of plan.autoCancelSafe) {
      lines.push(`- ${formatIssueRef(candidate)} - ${candidate.title}`);
    }
  }

  lines.push("", `### Needs-human-triage candidates (${plan.needsHumanTriage.length})`);
  if (plan.needsHumanTriage.length === 0) {
    lines.push("- None");
  } else {
    for (const candidate of plan.needsHumanTriage) {
      lines.push(
        `- ${formatIssueRef(candidate)} - ${candidate.title} (${candidate.triageReasons.join(", ")})`,
      );
    }
  }

  return lines.join("\n");
}
