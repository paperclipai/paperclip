import { desc, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { issueExecutionDecisions } from "@paperclipai/db";
import {
  MISSION_CONTROL_VALIDATOR_REPORT_DOCUMENT_KEY,
  parseMissionControlValidatorReportFromBody,
  type DocumentRevision,
  type IssueExecutionDecisionOutcome,
  type IssueExecutionStageType,
  type IssueValidationHistory,
  type IssueValidationHistoryEntry,
  type MissionControlValidatorReport,
} from "@paperclipai/shared";
import { documentService } from "./documents.js";
import { redactSensitiveText } from "../redaction.js";

type ValidatorReportRevision = Pick<
  DocumentRevision,
  | "id"
  | "issueId"
  | "revisionNumber"
  | "body"
  | "changeSummary"
  | "createdByAgentId"
  | "createdByUserId"
  | "createdAt"
>;

export interface IssueExecutionDecisionValidationRow {
  id: string;
  issueId: string;
  stageId: string | null;
  stageType: IssueExecutionStageType;
  actorAgentId: string | null;
  actorUserId: string | null;
  outcome: IssueExecutionDecisionOutcome;
  body: string | null;
  createdByRunId: string | null;
  createdAt: Date;
}

function redactText(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = redactSensitiveText(value.trim());
  return trimmed.length > 0 ? trimmed : null;
}

function redactTextArray(values: string[] | null | undefined): string[] {
  if (!values) return [];
  return values.map((value) => redactSensitiveText(value)).filter((value) => value.trim().length > 0);
}

function previewBody(body: string | null | undefined): string | null {
  const redacted = redactText(body);
  if (!redacted) return null;
  return redacted.length <= 320 ? redacted : `${redacted.slice(0, 319)}…`;
}

function sanitizeReport(report: MissionControlValidatorReport | null): MissionControlValidatorReport | null {
  if (!report) return null;
  return {
    ...report,
    criteriaChecked: redactTextArray(report.criteriaChecked),
    evidence: redactTextArray(report.evidence),
    hallucinationFlags: redactTextArray(report.hallucinationFlags),
    regressionChecks: redactTextArray(report.regressionChecks),
    blockingIssues: redactTextArray(report.blockingIssues),
    exactFixIfFailed: redactText(report.exactFixIfFailed),
  };
}

function decisionVerdict(outcome: IssueExecutionDecisionOutcome) {
  return outcome === "approved" ? "PASS" : "REQUEST_CHANGES";
}

function validationReportSummary(report: MissionControlValidatorReport | null, changeSummary: string | null): string | null {
  const redactedChangeSummary = redactText(changeSummary);
  if (redactedChangeSummary) return redactedChangeSummary;
  if (!report) return null;
  const score = typeof report.completionScore === "number" ? `${report.completionScore}/10` : "—/10";
  return `${report.verdict} · score ${score}`;
}

function validationReportEntry(revision: ValidatorReportRevision): IssueValidationHistoryEntry {
  const report = sanitizeReport(parseMissionControlValidatorReportFromBody(revision.body, {
    writtenByAgentId: revision.createdByAgentId,
  }));
  return {
    id: revision.id,
    issueId: revision.issueId,
    source: "validator_report",
    label: `validator-report rev ${revision.revisionNumber}`,
    verdict: report?.verdict ?? null,
    completionScore: report?.completionScore ?? null,
    report,
    summary: validationReportSummary(report, revision.changeSummary),
    criteriaChecked: report?.criteriaChecked ?? [],
    evidence: report?.evidence ?? [],
    blockingIssues: report?.blockingIssues ?? [],
    exactFixIfFailed: report?.exactFixIfFailed ?? null,
    stageId: null,
    stageType: null,
    decisionOutcome: null,
    revisionNumber: revision.revisionNumber,
    bodyPreview: previewBody(revision.body),
    actorAgentId: revision.createdByAgentId,
    actorUserId: revision.createdByUserId,
    createdByRunId: null,
    createdAt: revision.createdAt,
  };
}

function executionDecisionEntry(decision: IssueExecutionDecisionValidationRow): IssueValidationHistoryEntry {
  const body = redactText(decision.body);
  const verdict = decisionVerdict(decision.outcome);
  return {
    id: decision.id,
    issueId: decision.issueId,
    source: "execution_decision",
    label: `${decision.stageType} ${decision.outcome}`,
    verdict,
    completionScore: verdict === "PASS" ? 10 : 0,
    report: null,
    summary: body,
    criteriaChecked: [],
    evidence: body ? [body] : [],
    blockingIssues: decision.outcome === "changes_requested" && body ? [body] : [],
    exactFixIfFailed: decision.outcome === "changes_requested" ? body : null,
    stageId: decision.stageId,
    stageType: decision.stageType,
    decisionOutcome: decision.outcome,
    revisionNumber: null,
    bodyPreview: previewBody(decision.body),
    actorAgentId: decision.actorAgentId,
    actorUserId: decision.actorUserId,
    createdByRunId: decision.createdByRunId,
    createdAt: decision.createdAt,
  };
}

function createdTime(entry: Pick<IssueValidationHistoryEntry, "createdAt">) {
  const time = new Date(entry.createdAt).getTime();
  return Number.isFinite(time) ? time : 0;
}

export function buildIssueValidationHistory(input: {
  issueId: string;
  validatorReportRevisions: ValidatorReportRevision[];
  executionDecisions: IssueExecutionDecisionValidationRow[];
}): IssueValidationHistory {
  const entries = [
    ...input.validatorReportRevisions.map(validationReportEntry),
    ...input.executionDecisions.map(executionDecisionEntry),
  ].sort((a, b) => createdTime(b) - createdTime(a));

  return {
    issueId: input.issueId,
    latest: entries[0] ?? null,
    entries,
  };
}

export async function listIssueValidationHistory(db: Db, issueId: string): Promise<IssueValidationHistory> {
  const [validatorReportRevisions, executionDecisions] = await Promise.all([
    documentService(db).listIssueDocumentRevisions(issueId, MISSION_CONTROL_VALIDATOR_REPORT_DOCUMENT_KEY),
    db
      .select({
        id: issueExecutionDecisions.id,
        issueId: issueExecutionDecisions.issueId,
        stageId: issueExecutionDecisions.stageId,
        stageType: issueExecutionDecisions.stageType,
        actorAgentId: issueExecutionDecisions.actorAgentId,
        actorUserId: issueExecutionDecisions.actorUserId,
        outcome: issueExecutionDecisions.outcome,
        body: issueExecutionDecisions.body,
        createdByRunId: issueExecutionDecisions.createdByRunId,
        createdAt: issueExecutionDecisions.createdAt,
      })
      .from(issueExecutionDecisions)
      .where(eq(issueExecutionDecisions.issueId, issueId))
      .orderBy(desc(issueExecutionDecisions.createdAt)),
  ]);

  return buildIssueValidationHistory({
    issueId,
    validatorReportRevisions,
    executionDecisions: executionDecisions.map((decision) => ({
      ...decision,
      stageType: decision.stageType as IssueExecutionStageType,
      outcome: decision.outcome as IssueExecutionDecisionOutcome,
    })),
  });
}
