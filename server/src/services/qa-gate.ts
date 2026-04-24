import type {
  IssueComment,
  IssueExecutionDecisionOutcome,
  IssueQaGate,
  IssueQaGateReasonCode,
  IssueQaReviewDimension,
  IssueQaReviewOverall,
  IssueStatus,
} from "@paperclipai/shared";
import { isDeliveryWorkIntent, resolveIssueWorkIntent } from "./issue-routing-heuristics.js";
const QA_SUMMARY_TOKEN_REGEX = /\[(CQ|EH|TC|CM|DOC)\s*:\s*(pass|warn|fail|na)\]/gi;
const QA_CANONICAL_VERIFICATION_TOKEN_REGEX =
  /\[(TYPECHECK|TESTS|BUILD|SMOKE)\s*:\s*(pass|warn|fail|na)\]/gi;
const QA_TOLERANT_VERIFICATION_TOKEN_REGEX =
  /(?:^|[\s[])(TYPECHECK|TESTS|BUILD|SMOKE(?:\/NA)?)\s*(?::|=)\s*(pass|warn|fail|na)(?=\]|\s|$)\]?/gim;
const QA_PASS_MARKER_REGEX = /\[QA PASS\]/i;
const QA_PASS_VERDICT_LINE_REGEX =
  /(^|\n)\s*(?:final verdict|verdict|decision)\s*:\s*qa pass\b/i;
const QA_PASS_STANDALONE_LINE_REGEX = /(^|\n)\s*qa pass(?:\s*[-:]\s*.*)?$/i;
const RELEASE_CONFIRMED_MARKER_REGEX = /\[RELEASE CONFIRMED\]/i;
const RELEASE_READY_VERDICT_LINE_REGEX =
  /(^|\n)\s*(?:verification|final verdict|verdict|decision)\s*:\s*.*\b(?:release readiness confirmed|release ready)\b/i;
const RELEASE_READY_STANDALONE_LINE_REGEX =
  /(^|\n)\s*(?:release readiness confirmed|release ready)(?:\s*[-:]\s*.*)?$/i;
const QA_PASS_RELEASE_READY_COMBINED_LINE_REGEX =
  /(^|\n)\s*qa pass\s*[-:]\s*(?:release readiness confirmed|release ready)\b/i;
const REVIEW_STALE_MS = 24 * 60 * 60 * 1000;
const DONE_VERDICT_REGEX = /(?:^|\n)\s*DONE:/i;
const SMART_REVIEW_SUMMARY_REGEX = /(?:^|\n)\s*(?:\*\*|__)?(?:#+\s*)?smart review summary\b(?:\*\*|__)?/i;
const RESOLUTION_SUMMARY_REGEX = /(?:^|\n)\s*(?:#+\s*)?resolution summary\b/i;
const ROOT_CAUSE_REGEX = /\broot cause\s*:/i;
const FIX_REGEX = /\bfix\s*:/i;
const FIX_CONFIRMED_REGEX = /\bfix confirmed\s*:/i;
const FILES_REGEX = /\bfiles?\s*:/i;
const TESTS_REGEX = /\btests?\s*:/i;
const VERIFICATION_REGEX = /\bverification\s*:/i;
const VERIFIED_REGEX = /\bverified\b/i;
const RELEASE_READINESS_REGEX = /\brelease readiness confirmed\b/i;
const PASSING_TESTS_REGEX = /\b\d+\s*\/\s*\d+\s+(?:tests?|checks?)\s+pass(?:ing)?\b/i;
const CHECKMARK_ROW_REGEX = /(^|\n)\s*\|.*[✅☑]/;
const QA_TRANSCRIPT_NOISE_PATTERNS = [
  /(^|\n)\s*↻\s*Resumed session\b/i,
  /\bDANGEROUS COMMAND\b/i,
  /(^|\n)\s*Choice \[[^\]]+\]:/i,
  /(^|\n)\s*╭─\s*⚕ Hermes\b/i,
] as const;
const QA_TRANSCRIPT_VERDICT_ANCHORS = [
  DONE_VERDICT_REGEX,
  SMART_REVIEW_SUMMARY_REGEX,
  RESOLUTION_SUMMARY_REGEX,
  ROOT_CAUSE_REGEX,
  /(^|\n)\s*\[QA PASS\]/i,
  /(^|\n)\s*\[RELEASE CONFIRMED\]/i,
] as const;

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

function normalizeQaCommentBody(body: string | null | undefined) {
  const lines = String(body ?? "").replace(/\r\n?/g, "\n").split("\n");
  const normalized: string[] = [];
  let inFence = false;

  for (const line of lines) {
    const trimmed = line.trimStart();
    if (/^(?:```|~~~)/.test(trimmed)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    if (trimmed.startsWith(">")) continue;
    normalized.push(line);
  }

  return normalized.join("\n").trim();
}

function hasTranscriptNoise(body: string) {
  return QA_TRANSCRIPT_NOISE_PATTERNS.some((pattern) => pattern.test(body));
}

function extractTranscriptVerdictTail(body: string) {
  if (!hasTranscriptNoise(body)) return body;
  const anchorIndexes = QA_TRANSCRIPT_VERDICT_ANCHORS
    .map((pattern) => body.search(pattern))
    .filter((index) => index >= 0);
  if (anchorIndexes.length === 0) {
    return null;
  }
  const earliestAnchor = Math.min(...anchorIndexes);
  const tail = body.slice(earliestAnchor).trim();
  return tail.length > 0 ? tail : null;
}

function normalizeQaEvidenceText(body: string | null | undefined) {
  const normalized = normalizeQaCommentBody(body);
  if (normalized.length === 0) return normalized;
  if (!hasTranscriptNoise(normalized)) return normalized;
  return extractTranscriptVerdictTail(normalized) ?? "";
}

function countCheckmarkRows(body: string) {
  return body.match(new RegExp(CHECKMARK_ROW_REGEX, "g"))?.length ?? 0;
}

function hasCompleteReleaseMarkers(body: string) {
  return qaCommentHasQaPassMarker(body) && qaCommentHasReleaseConfirmedMarker(body);
}

function countStructuredVerdictSignals(body: string) {
  return [
    DONE_VERDICT_REGEX.test(body),
    SMART_REVIEW_SUMMARY_REGEX.test(body),
    RESOLUTION_SUMMARY_REGEX.test(body),
    ROOT_CAUSE_REGEX.test(body),
    FIX_REGEX.test(body),
    FIX_CONFIRMED_REGEX.test(body),
    FILES_REGEX.test(body),
    TESTS_REGEX.test(body),
    VERIFICATION_REGEX.test(body),
    VERIFIED_REGEX.test(body),
    RELEASE_READINESS_REGEX.test(body),
    countCheckmarkRows(body) > 0,
  ].filter(Boolean).length;
}

function hasStructuredQaSummary(body: string) {
  if (!hasCompleteReleaseMarkers(body)) return false;
  const signalCount = countStructuredVerdictSignals(body);
  return signalCount >= 2 || (signalCount >= 1 && body.length >= 250);
}

function hasStructuredQaVerification(body: string) {
  if (!hasCompleteReleaseMarkers(body)) return false;
  const hasTestsEvidence = TESTS_REGEX.test(body) || PASSING_TESTS_REGEX.test(body);
  const hasVerificationEvidence =
    VERIFICATION_REGEX.test(body)
    || VERIFIED_REGEX.test(body)
    || RELEASE_READINESS_REGEX.test(body);
  return (hasTestsEvidence && hasVerificationEvidence) || countStructuredVerdictSignals(body) >= 3;
}

function isTranscriptOnlyQaComment(body: string) {
  const normalized = normalizeQaCommentBody(body);
  if (normalized.length === 0) return false;
  if (!hasTranscriptNoise(normalized)) {
    return false;
  }
  return extractTranscriptVerdictTail(normalized) === null;
}

function hasVerdictLead(body: string) {
  return DONE_VERDICT_REGEX.test(body) || SMART_REVIEW_SUMMARY_REGEX.test(body) || RESOLUTION_SUMMARY_REGEX.test(body);
}

function hasStandaloneQaPassPhrase(body: string) {
  return QA_PASS_VERDICT_LINE_REGEX.test(body) || QA_PASS_STANDALONE_LINE_REGEX.test(body);
}

function hasStandaloneReleaseConfirmedPhrase(body: string) {
  return (
    RELEASE_READY_VERDICT_LINE_REGEX.test(body)
    || RELEASE_READY_STANDALONE_LINE_REGEX.test(body)
    || QA_PASS_RELEASE_READY_COMBINED_LINE_REGEX.test(body)
  );
}

function isLikelyQaVerdictComment(body: string | null | undefined) {
  const normalized = normalizeQaEvidenceText(body);
  if (normalized.length === 0) return false;
  if (qaCommentHasQaPassMarker(normalized) || qaCommentHasReleaseConfirmedMarker(normalized)) {
    return true;
  }
  if (
    new RegExp(QA_SUMMARY_TOKEN_REGEX).test(normalized)
    || new RegExp(QA_TOLERANT_VERIFICATION_TOKEN_REGEX).test(normalized)
  ) {
    return true;
  }
  return hasStructuredQaSummary(normalized);
}

export function selectLatestRelevantQaComment<TComment extends Pick<IssueComment, "id" | "body" | "createdAt">>(
  comments: TComment[],
) {
  const sorted = [...comments].sort(sortCommentsDesc);
  const latestVerdict = sorted.find((comment) => isLikelyQaVerdictComment(comment.body));
  if (latestVerdict) return latestVerdict;
  return sorted.find((comment) => !isTranscriptOnlyQaComment(comment.body)) ?? sorted[0] ?? null;
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
  const normalized = normalizeQaEvidenceText(body);
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
  if (!summaryIsComplete(dimensions) && hasStructuredQaSummary(normalized)) {
    dimensions.codeQuality = "pass";
    dimensions.errorHandling = "pass";
    dimensions.testCoverage = "pass";
    dimensions.commentQuality = FILES_REGEX.test(normalized) ? "pass" : "na";
    dimensions.docsImpact = "na";
  }
  return { dimensions, hasSummary: summaryIsComplete(dimensions) };
}

function parseExplicitSummaryDimensions(body: string | null | undefined) {
  const dimensions = defaultDimensions();
  if (!body) return { dimensions, hasSummary: false };
  const normalized = normalizeQaEvidenceText(body);
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

export function qaSummaryNeedsExplicitTestCoverageVerdict(summary: Pick<QaSummaryParseResult, "hasSummary" | "dimensions">) {
  return summary.hasSummary && summary.dimensions.testCoverage === "na";
}

export function qaCommentHasExplicitSummaryTokens(body: string | null | undefined) {
  return parseExplicitSummaryDimensions(body).hasSummary;
}

export function qaCommentHasExplicitTestCoverageVerdict(body: string | null | undefined) {
  const parsed = parseExplicitSummaryDimensions(body);
  return parsed.hasSummary && parsed.dimensions.testCoverage !== "na";
}

function parseVerificationDimensions(body: string | null | undefined) {
  const verification = defaultVerification();
  let hasVerification = false;
  if (!body) return { verification, hasVerification };
  const normalized = normalizeQaEvidenceText(body);
  const verificationRegex = new RegExp(QA_TOLERANT_VERIFICATION_TOKEN_REGEX);
  for (const match of normalized.matchAll(verificationRegex)) {
    hasVerification = true;
    const token = match[1]?.toUpperCase().replace("/NA", "");
    const state = (match[2]?.toLowerCase() ?? "unknown") as IssueQaReviewDimension;
    if (token === "TYPECHECK") verification.typecheck = state;
    else if (token === "TESTS") verification.tests = state;
    else if (token === "BUILD") verification.build = state;
    else if (token === "SMOKE") verification.smoke = state;
  }
  if (!qaVerificationIsComplete(verification) && hasStructuredQaVerification(normalized)) {
    hasVerification = true;
    verification.typecheck = "pass";
    verification.tests = "pass";
    verification.build = "pass";
    verification.smoke = PASSING_TESTS_REGEX.test(normalized) || VERIFICATION_REGEX.test(normalized) ? "pass" : "na";
  }
  return { verification, hasVerification };
}

function parseExplicitVerificationDimensions(body: string | null | undefined) {
  const verification = defaultVerification();
  let hasVerification = false;
  if (!body) return { verification, hasVerification };
  const normalized = normalizeQaEvidenceText(body);
  const verificationRegex = new RegExp(QA_CANONICAL_VERIFICATION_TOKEN_REGEX);
  for (const match of normalized.matchAll(verificationRegex)) {
    hasVerification = true;
    const token = match[1]?.toUpperCase().replace("/NA", "");
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

export function qaCommentHasExplicitVerificationTokens(body: string | null | undefined) {
  return qaVerificationIsComplete(parseExplicitVerificationDimensions(body).verification);
}

export function qaCommentHasQaPassMarker(body: string | null | undefined) {
  const normalized = normalizeQaEvidenceText(body);
  if (normalized.length === 0) return false;
  return QA_PASS_MARKER_REGEX.test(normalized) || (hasVerdictLead(normalized) && hasStandaloneQaPassPhrase(normalized));
}

export function qaCommentHasReleaseConfirmedMarker(body: string | null | undefined) {
  const normalized = normalizeQaEvidenceText(body);
  if (normalized.length === 0) return false;
  return (
    RELEASE_CONFIRMED_MARKER_REGEX.test(normalized)
    || (hasVerdictLead(normalized) && hasStandaloneReleaseConfirmedPhrase(normalized))
  );
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
  return isDeliveryWorkIntent(resolveIssueWorkIntent({ assigneeRole: role }));
}

export function isDeliveryScopedIssue(input: {
  workIntent?: string | null | undefined;
  assigneeRole: string | null | undefined;
  issueText?: string | null | undefined;
  workflowTemplateKey?: string | null | undefined;
  workflowLaneRole?: string | null | undefined;
}) {
  return isDeliveryWorkIntent(resolveIssueWorkIntent(input));
}

export function issueQaGateReasonMessage(reasonCode: IssueQaGateReasonCode): string {
  switch (reasonCode) {
    case "invalid_status_transition":
      return "Invalid issue status transition";
    case "qa_gate_requires_qa_assignee":
      return "Delivery issues in review must stay assigned to the active QA reviewer";
    case "qa_gate_no_eligible_qa_agent":
      return "No eligible QA reviewer is available to own this in_review issue";
    case "qa_gate_requires_in_review":
      return "Delivery issues can only move to done from in_review";
    case "qa_gate_missing_qa_comment":
      return "No QA-authored comment exists yet for this issue";
    case "qa_gate_missing_qa_summary":
      return "Latest QA-authored comment must include the Smart Review summary before moving to done";
    case "qa_gate_missing_test_coverage_verdict":
      return "Latest QA-authored comment must set Test Coverage to pass, warn, or fail before moving to done";
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
  workIntent?: string | null | undefined;
  assigneeRole: string | null | undefined;
  issueText?: string | null | undefined;
  qaComments: Array<Pick<IssueComment, "id" | "body" | "createdAt">>;
  latestDecisionOutcome?: IssueExecutionDecisionOutcome | null;
  now?: Date;
}): IssueQaGate {
  const now = input.now ?? new Date();
  const isDeliveryScoped = isDeliveryScopedIssue({
    workIntent: input.workIntent,
    assigneeRole: input.assigneeRole,
    issueText: input.issueText,
  });
  const qaComments = [...input.qaComments].sort(sortCommentsDesc);
  const latestQaComment = selectLatestRelevantQaComment(qaComments);
  const latestBody = latestQaComment?.body ?? "";
  const latestSummary = parseQaSummary(latestBody);
  const latestVerification = parseQaVerification(latestBody);
  const summaryDimensions = latestSummary.dimensions;
  const hasSummary = latestSummary.hasSummary;
  const lastQaSummaryAt = latestQaComment && hasSummary ? new Date(latestQaComment.createdAt) : null;
  const verificationStatus = latestVerification.verification;
  const missingExplicitTestCoverageVerdict = qaSummaryNeedsExplicitTestCoverageVerdict(latestSummary);

  let overall = latestSummary.overall;
  const latestDecisionOutcome = input.latestDecisionOutcome ?? null;
  if (latestDecisionOutcome === "changes_requested") {
    overall = "fail";
  } else if (latestDecisionOutcome === "approved" && !hasSummary && overall === "unknown") {
    overall = "warn";
  } else if (missingExplicitTestCoverageVerdict && overall === "pass") {
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
      } else if (missingExplicitTestCoverageVerdict) {
        missingRequirements.push("qa_gate_missing_test_coverage_verdict");
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
