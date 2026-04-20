import type { HeartbeatRunStatus, IssueStatus, RunLivenessState } from "@paperclipai/shared";

export interface RunLivenessIssueInput {
  status: IssueStatus | string;
  title: string;
  description: string | null;
}

export interface RunLivenessEvidenceInput {
  issueCommentsCreated: number;
  documentRevisionsCreated: number;
  planDocumentRevisionsCreated: number;
  workProductsCreated: number;
  workspaceOperationsCreated: number;
  activityEventsCreated: number;
  toolOrActionEventsCreated: number;
  latestEvidenceAt: Date | null;
}

export interface RunLivenessClassificationInput {
  runStatus: HeartbeatRunStatus | string;
  issue: RunLivenessIssueInput | null;
  resultJson?: Record<string, unknown> | null;
  stdoutExcerpt?: string | null;
  stderrExcerpt?: string | null;
  error?: string | null;
  errorCode?: string | null;
  continuationAttempt?: number | null;
  evidence?: Partial<RunLivenessEvidenceInput> | null;
}

export interface RunLivenessClassification {
  livenessState: RunLivenessState;
  livenessReason: string;
  continuationAttempt: number;
  lastUsefulActionAt: Date | null;
  nextAction: string | null;
}

const DEFAULT_EVIDENCE: RunLivenessEvidenceInput = {
  issueCommentsCreated: 0,
  documentRevisionsCreated: 0,
  planDocumentRevisionsCreated: 0,
  workProductsCreated: 0,
  workspaceOperationsCreated: 0,
  activityEventsCreated: 0,
  toolOrActionEventsCreated: 0,
  latestEvidenceAt: null,
};

const PLANNING_ONLY_RE =
  /\b(?:i(?:'ll| will| am going to|'m going to)|let me|i need to|next(?:,| i will| i'll)?|my next step is|the next step is)\s+(?:first\s+)?(?:inspect|check|review|look|investigate|analy[sz]e|open|read|start|begin|work on|implement|fix|test|update|create|add)\b/i;
const NEXT_STEPS_RE = /^\s*(?:next steps?|plan)\s*:/im;
const BLOCKER_RE =
  /\b(?:blocked|can't proceed|cannot proceed|unable to proceed|waiting on|need(?:s|ed)? .{0,80}\b(?:approval|access|credential|credentials|secret|api key|token|input|clarification)|requires? .{0,80}\b(?:approval|access|credential|credentials|secret|api key|token|input|clarification))\b/i;
const NEGATED_BLOCKER_RE = /\b(?:not blocked|no blocker|no blockers|unblocked)\b/i;
const PLAN_TASK_TITLE_RE = /\b(?:plan|planning|analysis|investigation|research|report|proposal|design doc|write-?up)\b/i;
const PLAN_TASK_DESCRIPTION_RE =
  /\b(?:create|write|produce|draft|update|revise|prepare)\s+(?:a\s+|the\s+)?(?:plan|analysis|investigation|research report|report|proposal|design doc|write-?up)\b/i;

function compactReason(reason: string) {
  return reason.length <= 500 ? reason : `${reason.slice(0, 497)}...`;
}

function normalizeCount(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

function normalizeContinuationAttempt(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

function readText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function resultText(resultJson: Record<string, unknown> | null | undefined) {
  if (!resultJson) return "";
  return [
    readText(resultJson.summary),
    readText(resultJson.result),
    readText(resultJson.message),
    readText(resultJson.stdout),
    readText(resultJson.stderr),
  ]
    .filter((value): value is string => Boolean(value))
    .join("\n");
}

function combinedOutput(input: RunLivenessClassificationInput) {
  return [
    resultText(input.resultJson),
    readText(input.stdoutExcerpt),
    readText(input.stderrExcerpt),
    readText(input.error),
  ]
    .filter((value): value is string => Boolean(value))
    .join("\n")
    .trim();
}

export function hasUsefulOutput(input: RunLivenessClassificationInput) {
  return combinedOutput(input).length > 0;
}

export function declaredBlocker(input: RunLivenessClassificationInput) {
  if (input.issue?.status === "blocked") return true;
  const text = combinedOutput(input);
  if (!text || NEGATED_BLOCKER_RE.test(text)) return false;
  return BLOCKER_RE.test(text);
}

export function looksLikePlanningOnly(input: RunLivenessClassificationInput) {
  const text = combinedOutput(input);
  if (!text) return false;
  return PLANNING_ONLY_RE.test(text) || NEXT_STEPS_RE.test(text);
}

export function isPlanningOrDocumentTask(issue: RunLivenessIssueInput | null | undefined) {
  if (!issue) return false;
  if (PLAN_TASK_TITLE_RE.test(issue.title)) return true;
  return PLAN_TASK_DESCRIPTION_RE.test(issue.description ?? "");
}

function normalizeEvidence(evidence: Partial<RunLivenessEvidenceInput> | null | undefined): RunLivenessEvidenceInput {
  return {
    issueCommentsCreated: normalizeCount(evidence?.issueCommentsCreated),
    documentRevisionsCreated: normalizeCount(evidence?.documentRevisionsCreated),
    planDocumentRevisionsCreated: normalizeCount(evidence?.planDocumentRevisionsCreated),
    workProductsCreated: normalizeCount(evidence?.workProductsCreated),
    workspaceOperationsCreated: normalizeCount(evidence?.workspaceOperationsCreated),
    activityEventsCreated: normalizeCount(evidence?.activityEventsCreated),
    toolOrActionEventsCreated: normalizeCount(evidence?.toolOrActionEventsCreated),
    latestEvidenceAt: evidence?.latestEvidenceAt instanceof Date ? evidence.latestEvidenceAt : null,
  };
}

export function hasConcreteActionEvidence(evidence: Partial<RunLivenessEvidenceInput> | null | undefined) {
  const normalized = normalizeEvidence(evidence);
  // Workspace creation is setup evidence, not task progress by itself. It can
  // appear in reasons alongside durable activity, but it must not prevent a
  // planning-only or empty run from receiving a bounded continuation.
  return (
    normalized.issueCommentsCreated +
      normalized.documentRevisionsCreated +
      normalized.workProductsCreated +
      normalized.activityEventsCreated +
      normalized.toolOrActionEventsCreated >
    0
  );
}

function evidenceReason(evidence: RunLivenessEvidenceInput) {
  const parts: string[] = [];
  if (evidence.issueCommentsCreated > 0) parts.push(`${evidence.issueCommentsCreated} issue comment(s)`);
  if (evidence.documentRevisionsCreated > 0) parts.push(`${evidence.documentRevisionsCreated} document revision(s)`);
  if (evidence.workProductsCreated > 0) parts.push(`${evidence.workProductsCreated} work product(s)`);
  if (evidence.workspaceOperationsCreated > 0) parts.push(`${evidence.workspaceOperationsCreated} workspace operation(s)`);
  if (evidence.activityEventsCreated > 0) parts.push(`${evidence.activityEventsCreated} activity event(s)`);
  if (evidence.toolOrActionEventsCreated > 0) parts.push(`${evidence.toolOrActionEventsCreated} tool/action event(s)`);
  return parts.join(", ");
}

function extractNextAction(input: RunLivenessClassificationInput) {
  const text = combinedOutput(input);
  if (!text) return null;
  const line = text
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .find((entry) => PLANNING_ONLY_RE.test(entry) || /^next(?: steps?| action)?\s*:/i.test(entry));
  if (!line) return null;
  return line.length <= 500 ? line : `${line.slice(0, 497)}...`;
}

export function classifyRunLiveness(input: RunLivenessClassificationInput): RunLivenessClassification {
  const evidence = normalizeEvidence(input.evidence);
  const continuationAttempt = normalizeContinuationAttempt(input.continuationAttempt);
  const issueStatus = input.issue?.status ?? null;
  const usefulOutput = hasUsefulOutput(input);
  const concreteEvidence = hasConcreteActionEvidence(evidence);
  const planExempt = isPlanningOrDocumentTask(input.issue) || evidence.planDocumentRevisionsCreated > 0;
  const lastUsefulActionAt = concreteEvidence ? evidence.latestEvidenceAt : null;

  const output = (state: RunLivenessState, reason: string, nextAction: string | null = null): RunLivenessClassification => ({
    livenessState: state,
    livenessReason: compactReason(reason),
    continuationAttempt,
    lastUsefulActionAt: state === "advanced" || state === "completed" || state === "blocked" ? lastUsefulActionAt : null,
    nextAction,
  });

  if (input.runStatus !== "succeeded") {
    return output("failed", input.errorCode ? `Run ended with ${input.runStatus} (${input.errorCode})` : `Run ended with ${input.runStatus}`);
  }

  if (issueStatus === "done" || issueStatus === "cancelled") {
    return output("completed", `Issue is ${issueStatus}`);
  }

  if (declaredBlocker(input)) {
    return output("blocked", issueStatus === "blocked" ? "Issue status is blocked" : "Run output declared a concrete blocker", extractNextAction(input));
  }

  if (!usefulOutput && !concreteEvidence) {
    return output("empty_response", "Run succeeded without useful output or concrete action evidence");
  }

  if (concreteEvidence) {
    return output("advanced", `Run produced concrete action evidence: ${evidenceReason(evidence)}`);
  }

  if (planExempt && usefulOutput) {
    return output("advanced", "Planning/document task produced useful output and is exempt from plan-only classification");
  }

  if (looksLikePlanningOnly(input)) {
    return output("plan_only", "Run described future work without concrete action evidence", extractNextAction(input));
  }

  if (usefulOutput) {
    return output("needs_followup", "Run produced useful output but no concrete action evidence", extractNextAction(input));
  }

  return output("empty_response", "Run succeeded without useful output");
}
