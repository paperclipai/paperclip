import type {
  IssueComment,
  IssueExecutionDecisionOutcome,
  IssueQaGate,
  IssueQaGateReasonCode,
  IssueQaReviewDimension,
  IssueQaReviewOverall,
  IssueStatus,
} from "@paperclipai/shared";

const DELIVERY_SCOPED_ASSIGNEE_ROLES = new Set(["engineer", "qa", "devops", "cto"]);
const QA_SUMMARY_TOKEN_REGEX = /\[(CQ|EH|TC|CM|DOC)\s*:\s*(pass|warn|fail|na)\]/gi;
const QA_PASS_REGEX = /\[QA PASS\]/i;
const RELEASE_CONFIRMED_REGEX = /\[RELEASE CONFIRMED\]/i;
const REVIEW_STALE_MS = 24 * 60 * 60 * 1000;

type QaDimensionMap = {
  codeQuality: IssueQaReviewDimension;
  errorHandling: IssueQaReviewDimension;
  testCoverage: IssueQaReviewDimension;
  commentQuality: IssueQaReviewDimension;
  docsImpact: IssueQaReviewDimension;
};

function defaultDimensions(): QaDimensionMap {
  return {
    codeQuality: "unknown",
    errorHandling: "unknown",
    testCoverage: "unknown",
    commentQuality: "unknown",
    docsImpact: "unknown",
  };
}

function toOverall(dimensions: QaDimensionMap): IssueQaReviewOverall {
  const values = Object.values(dimensions);
  if (values.includes("fail")) return "fail";
  if (values.every((value) => value === "pass" || value === "na")) return "pass";
  if (values.some((value) => value === "warn")) return "warn";
  return "unknown";
}

function parseSummaryDimensions(body: string | null | undefined) {
  const dimensions = defaultDimensions();
  let hasSummary = false;
  if (!body) return { dimensions, hasSummary };
  const normalized = String(body);
  for (const match of normalized.matchAll(QA_SUMMARY_TOKEN_REGEX)) {
    hasSummary = true;
    const token = match[1]?.toUpperCase();
    const state = (match[2]?.toLowerCase() ?? "unknown") as IssueQaReviewDimension;
    if (token === "CQ") dimensions.codeQuality = state;
    else if (token === "EH") dimensions.errorHandling = state;
    else if (token === "TC") dimensions.testCoverage = state;
    else if (token === "CM") dimensions.commentQuality = state;
    else if (token === "DOC") dimensions.docsImpact = state;
  }
  return { dimensions, hasSummary };
}

function sortCommentsDesc(a: Pick<IssueComment, "createdAt" | "id">, b: Pick<IssueComment, "createdAt" | "id">) {
  const aTime = new Date(a.createdAt).getTime();
  const bTime = new Date(b.createdAt).getTime();
  if (aTime !== bTime) return bTime - aTime;
  return String(b.id).localeCompare(String(a.id));
}

export function isDeliveryScopedAssigneeRole(role: string | null | undefined) {
  if (!role) return true;
  return DELIVERY_SCOPED_ASSIGNEE_ROLES.has(role);
}

export function issueQaGateReasonMessage(reasonCode: IssueQaGateReasonCode): string {
  switch (reasonCode) {
    case "invalid_status_transition":
      return "Invalid issue status transition";
    case "qa_gate_requires_in_review":
      return "Delivery issues can only move to done from in_review";
    case "qa_gate_missing_qa_pass":
      return "Latest QA-authored comment must include [QA PASS] before moving to done";
    case "qa_gate_missing_release_confirmation":
      return "Latest QA-authored comment must include [RELEASE CONFIRMED] before moving to done";
    default:
      return "Issue update rejected";
  }
}

export function buildIssueQaGate(input: {
  issue: Pick<{ status: IssueStatus }, "status">;
  assigneeRole: string | null | undefined;
  qaComments: Array<Pick<IssueComment, "id" | "body" | "createdAt">>;
  latestDecisionOutcome?: IssueExecutionDecisionOutcome | null;
  now?: Date;
}): IssueQaGate {
  const now = input.now ?? new Date();
  const isDeliveryScoped = isDeliveryScopedAssigneeRole(input.assigneeRole);
  const qaComments = [...input.qaComments].sort(sortCommentsDesc);
  const latestQaComment = qaComments[0] ?? null;
  let summaryDimensions = defaultDimensions();
  let lastQaSummaryAt: Date | null = null;
  let hasSummary = false;

  for (const comment of qaComments) {
    const parsed = parseSummaryDimensions(comment.body);
    if (!parsed.hasSummary) continue;
    summaryDimensions = parsed.dimensions;
    hasSummary = true;
    lastQaSummaryAt = comment.createdAt ? new Date(comment.createdAt) : null;
    break;
  }

  let overall = toOverall(summaryDimensions);
  const latestDecisionOutcome = input.latestDecisionOutcome ?? null;
  if (latestDecisionOutcome === "changes_requested") {
    overall = "fail";
  } else if (latestDecisionOutcome === "approved" && !hasSummary && overall === "unknown") {
    overall = "warn";
  }

  const stale =
    input.issue.status === "in_review" &&
    (!lastQaSummaryAt || now.getTime() - lastQaSummaryAt.getTime() > REVIEW_STALE_MS);

  const missingRequirements: IssueQaGateReasonCode[] = [];
  if (isDeliveryScoped) {
    if (input.issue.status !== "in_review") {
      missingRequirements.push("qa_gate_requires_in_review");
    }
    const latestBody = latestQaComment?.body ?? "";
    if (!QA_PASS_REGEX.test(latestBody)) {
      missingRequirements.push("qa_gate_missing_qa_pass");
    }
    if (!RELEASE_CONFIRMED_REGEX.test(latestBody)) {
      missingRequirements.push("qa_gate_missing_release_confirmation");
    }
  }

  return {
    isDeliveryScoped,
    canShip: !isDeliveryScoped || missingRequirements.length === 0,
    missingRequirements,
    lastQaSummaryAt,
    review: {
      codeQuality: summaryDimensions.codeQuality,
      errorHandling: summaryDimensions.errorHandling,
      testCoverage: summaryDimensions.testCoverage,
      commentQuality: summaryDimensions.commentQuality,
      docsImpact: summaryDimensions.docsImpact,
      overall,
      stale,
      latestDecisionOutcome,
    },
  };
}

