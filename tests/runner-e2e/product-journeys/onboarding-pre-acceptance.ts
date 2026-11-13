import { ISSUE_STATUSES } from "../../../packages/shared/src/constants.js";

const checkpoints = ["before-opening-answer", "awaiting-proposal"] as const;
const violations = ["unexpected_task_set", "attachment_present", "non_planning_document_present", "first_task_done"] as const;
const statuses = [...ISSUE_STATUSES, "missing", "unknown"] as const;

/** Scalar observations from the first failing pre-acceptance guard; never raw rows. */
export interface OnboardingPreAcceptanceEvidence {
  version: 1;
  checkpoint: typeof checkpoints[number];
  violations: Array<typeof violations[number]>;
  taskCount: number;
  attachmentCount: number;
  documentCount: number;
  nonPlanningDocumentCount: number;
  firstTaskMatchesCanonicalParent: boolean;
  firstTaskStatus: typeof statuses[number];
  canonicalParentStatus: typeof statuses[number];
}

const receiptKeys = {
  version: true, checkpoint: true, violations: true, taskCount: true, attachmentCount: true,
  documentCount: true, nonPlanningDocumentCount: true, firstTaskMatchesCanonicalParent: true,
  firstTaskStatus: true, canonicalParentStatus: true,
} satisfies Record<keyof OnboardingPreAcceptanceEvidence, true>;

export function preAcceptanceTaskStatus(task: { status?: unknown; [key: string]: unknown } | undefined): OnboardingPreAcceptanceEvidence["firstTaskStatus"] {
  if (!task) return "missing";
  return ISSUE_STATUSES.find(status => status === task.status) ?? "unknown";
}

export function preAcceptanceViolations(observed: Pick<OnboardingPreAcceptanceEvidence,
  "taskCount" | "attachmentCount" | "nonPlanningDocumentCount" | "firstTaskMatchesCanonicalParent" | "firstTaskStatus">): OnboardingPreAcceptanceEvidence["violations"] {
  return [
    ...(observed.taskCount !== 1 || !observed.firstTaskMatchesCanonicalParent ? ["unexpected_task_set" as const] : []),
    ...(observed.attachmentCount ? ["attachment_present" as const] : []),
    ...(observed.nonPlanningDocumentCount ? ["non_planning_document_present" as const] : []),
    ...(observed.firstTaskStatus === "done" ? ["first_task_done" as const] : []),
  ];
}

/** Closed validation is shared by normalized-result readers and explicit report rendering. */
export function validateOnboardingPreAcceptanceEvidence(value: unknown): asserts value is OnboardingPreAcceptanceEvidence {
  const invalid = (): never => { throw new Error("invalid_onboarding_pre_acceptance_evidence"); };
  const keys = Object.keys(receiptKeys);
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) invalid();
  const receipt = value as OnboardingPreAcceptanceEvidence;
  if (receipt.version !== 1 || !checkpoints.includes(receipt.checkpoint) ||
    !Array.isArray(receipt.violations) || !receipt.violations.length || receipt.violations.length > violations.length ||
    receipt.violations.some(code => !violations.includes(code)) || new Set(receipt.violations).size !== receipt.violations.length ||
    [receipt.taskCount, receipt.attachmentCount, receipt.documentCount, receipt.nonPlanningDocumentCount].some(count => !Number.isSafeInteger(count) || count < 0) ||
    receipt.nonPlanningDocumentCount > receipt.documentCount || typeof receipt.firstTaskMatchesCanonicalParent !== "boolean" ||
    !statuses.includes(receipt.firstTaskStatus) || !statuses.includes(receipt.canonicalParentStatus)) invalid();
  if (receipt.taskCount === 0 && (receipt.firstTaskStatus !== "missing" || receipt.canonicalParentStatus !== "missing" || receipt.firstTaskMatchesCanonicalParent) ||
    receipt.taskCount > 0 && receipt.firstTaskStatus === "missing" ||
    receipt.firstTaskMatchesCanonicalParent && receipt.firstTaskStatus !== receipt.canonicalParentStatus ||
    receipt.taskCount === 1 && !receipt.firstTaskMatchesCanonicalParent && receipt.canonicalParentStatus !== "missing" ||
    preAcceptanceViolations(receipt).join(",") !== receipt.violations.join(",")) invalid();
}
