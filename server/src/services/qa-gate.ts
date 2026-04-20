import type {
  IssueComment,
  IssueExecutionDecisionOutcome,
  IssueQaGate,
  IssueQaGateReasonCode,
  IssueQaReviewDimension,
  IssueQaReviewOverall,
  IssueStatus,
} from "@paperclipai/shared";
import { isLikelyTechnicalIssueText } from "./issue-routing-heuristics.js";

const DELIVERY_SCOPED_ASSIGNEE_ROLES = new Set(["engineer", "qa", "devops", "cto"]);
const QA_SUMMARY_TOKEN_REGEX = /\[(CQ|EH|TC|CM|DOC)\s*:\s*(pass|warn|fail|na)\]/gi;
const QA_VERIFICATION_TOKEN_REGEX = /\[(TYPECHECK|TESTS|BUILD|SMOKE)\s*:\s*(pass|warn|fail|na)\]/gi;
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

type QaVerificationMap = {
  typecheck: IssueQaReviewDimension;
  tests: IssueQaReviewDimension;
  build: IssueQaReviewDimension;
  smoke: IssueQaReviewDimension;
};

export type QaSummaryParseResult = {
  dimensions: QaDimensionMap;
  hasSummary: boolean;
  overall: IssueQaReviewOverall;
};

export type QaVerificationParseResult = {
  verification: QaVerificationMap;
  hasVerification: boolean;
  complete: boolean;
  overall: IssueQaReviewOverall;
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

function defaultVerification(): QaVerificationMap {
  return {
    typecheck: "unknown",
    tests: "unknown",
    build: "unknown",
    smoke: "unknown",
  };
}

function summaryIsComplete(dimensions: QaDimensionMap) {
  return Object.values(dimensions).every((value) => value !== "unknown");
}

export function qaSummaryOverall(dimensions: QaDimensionMap): IssueQaReviewOverall {
  const values = Object.values(dimensions);
  if (values.includes("fail")) return "fail";
  if (values.every((value) => value === "pass" || value === "na")) return "pass";
  if (values.some((value) => value === "warn")) return "warn";
  return "unknown";
}

function parseSummaryDimensions(body: string | null | undefined) {
  const dimensions = defaultDimensions();
  if (!body) return { dimensions, hasSummary: false };
  const normalized = String(body);
  const summaryRegex = new RegExp(QA_SUMMARY_TOKEN_REGEX);
  for (const match of normalized.matchAll(summaryRegex)) {
    const token = match[1]?.toUpperCase();
    const state = (match[2]?.toLowerCase() ?? "unknown") as IssueQaReviewDimension;
    if (token === "CQ") dimensions.codeQuality = state;
    else if (token === "EH") dimensions.errorHandling = state;
    else if (token === "TC") dimensions.testCoverage = state;
    else if (token === "CM") dimensions.commentQuality = state;
    else if (token === "DOC") dimensions.docsImpact = state;
  }
  return { dimensions, hasSummary: summaryIsComplete(dimensions) };
}

export function parseQaSummary(body: string | null | undefined): QaSummaryParseResult {
  const parsed = parseSummaryDimensions(body);
  return {
    ...parsed,
    overall: qaSummaryOverall(parsed.dimensions),
  };
}

function parseVerificationDimensions(body: string | null | undefined) {
  const verification = defaultVerification();
  let hasVerification = false;
  if (!body) return { verification, hasVerification };
  const normalized = String(body);
  const verificationRegex = new RegExp(QA_VERIFICATION_TOKEN_REGEX);
  for (const match of normalized.matchAll(verificationRegex)) {
    hasVerification = true;
    const token = match[1]?.toUpperCase();
    const state = (match[2]?.toLowerCase() ?? "unknown") as IssueQaReviewDimension;
    if (token === "TYPECHECK") verification.typecheck = state;
    else if (token === "TESTS") verification.tests = state;
    else if (token === "BUILD") verification.build = state;
    else if (token === "SMOKE") verification.smoke = state;
  }
  return { verification, hasVerification };
}

export function qaVerificationIsComplete(verification: QaVerificationMap) {
  return Object.values(verification).every((value) => value !== "unknown");
}

export function qaVerificationOverall(verification: QaVerificationMap): IssueQaReviewOverall {
  const requiredStates = [verification.typecheck, verification.tests, verification.build];
  if (requiredStates.some((value) => value === "fail" || value === "warn" || value === "na")) return "fail";
  if (verification.smoke === "fail" || verification.smoke === "warn") return "fail";
  if (requiredStates.every((value) => value === "pass") && (verification.smoke === "pass" || verification.smoke === "na")) {
    return "pass";
  }
  return "unknown";
}

export function parseQaVerification(body: string | null | undefined): QaVerificationParseResult {
  const parsed = parseVerificationDimensions(body);
  return {
    ...parsed,
    complete: qaVerificationIsComplete(parsed.verification),
    overall: qaVerificationOverall(parsed.verification),
  };
}

export function qaCommentHasQaPassMarker(body: string | null | undefined) {
  return QA_PASS_REGEX.test(body ?? "");
}

export function qaCommentHasReleaseConfirmedMarker(body: string | null | undefined) {
  return RELEASE_CONFIRMED_REGEX.test(body ?? "");
}

export function sortIssueCommentsDesc(a: Pick<IssueComment, "createdAt" | "id">, b: Pick<IssueComment, "createdAt" | "id">) {
  return sortCommentsDesc(a, b);
}

export function qaCommentHasFailingReview(body: string | null | undefined) {
  const parsed = parseQaSummary(body);
  return parsed.hasSummary && parsed.overall === "fail";
}

export function qaCommentHasFailingVerification(body: string | null | undefined) {
  const parsed = parseQaVerification(body);
  return parsed.complete && parsed.overall !== "pass";
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
    case "qa_gate_requires_qa_assignee":
      return "Delivery issues must be assigned to a QA agent before entering in_review";
    case "qa_gate_no_eligible_qa_agent":
      return "No eligible QA agent is available to own this in_review issue";
    case "qa_gate_requires_in_review":
      return "Delivery issues can only move to done from in_review";
    case "qa_gate_missing_qa_comment":
      return "No QA-authored comment exists yet for this issue";
    case "qa_gate_missing_qa_summary":
      return "Latest QA-authored comment must include the Smart Review summary before moving to done";
    case "qa_gate_missing_qa_pass":
      return "Latest QA-authored comment must include [QA PASS] before moving to done";
    case "qa_gate_missing_release_confirmation":
      return "Latest QA-authored comment must include [RELEASE CONFIRMED] before moving to done";
    case "qa_gate_missing_verification":
      return "Latest QA-authored comment must include passing verification tokens for TYPECHECK, TESTS, BUILD, and SMOKE/NA";
    case "qa_gate_failing_review":
      return "Latest QA-authored review is failing and must be handed back before moving to done";
    case "qa_gate_failing_verification":
      return "Latest QA-authored verification evidence is failing and must be resolved before moving to done";
    default:
      return "Issue update rejected";
  }
}

export function buildIssueQaGate(input: {
  issue: Pick<{ status: IssueStatus }, "status">;
  assigneeRole: string | null | undefined;
  issueText?: string | null | undefined;
  qaComments: Array<Pick<IssueComment, "id" | "body" | "createdAt">>;
  latestDecisionOutcome?: IssueExecutionDecisionOutcome | null;
  now?: Date;
}): IssueQaGate {
  const now = input.now ?? new Date();
  const isDeliveryScoped =
    isDeliveryScopedAssigneeRole(input.assigneeRole) || isLikelyTechnicalIssueText(input.issueText);
  const qaComments = [...input.qaComments].sort(sortCommentsDesc);
  const latestQaComment = qaComments[0] ?? null;
  const latestBody = latestQaComment?.body ?? "";
  const latestSummary = parseQaSummary(latestBody);
  const latestVerification = parseQaVerification(latestBody);
  const summaryDimensions = latestSummary.dimensions;
  const hasSummary = latestSummary.hasSummary;
  const lastQaSummaryAt = latestQaComment && hasSummary ? new Date(latestQaComment.createdAt) : null;
  const verificationStatus = latestVerification.verification;

  let overall = latestSummary.overall;
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
    if (!latestQaComment) {
      missingRequirements.push("qa_gate_missing_qa_comment");
    } else {
      if (!qaCommentHasQaPassMarker(latestBody)) {
        missingRequirements.push("qa_gate_missing_qa_pass");
      }
      if (!qaCommentHasReleaseConfirmedMarker(latestBody)) {
        missingRequirements.push("qa_gate_missing_release_confirmation");
      }
      if (!hasSummary) {
        missingRequirements.push("qa_gate_missing_qa_summary");
      } else if (overall === "fail") {
        missingRequirements.push("qa_gate_failing_review");
      }
      if (!latestVerification.complete) {
        missingRequirements.push("qa_gate_missing_verification");
      } else if (latestVerification.overall !== "pass") {
        missingRequirements.push("qa_gate_failing_verification");
      }
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
