import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { documents, issueComments, issueDocuments } from "@paperclipai/db";
import type { IssueWorkflowArtifactStatus } from "@paperclipai/shared";
import {
  parseQaSummary,
  parseQaVerification,
  qaCommentHasQaPassMarker,
  qaCommentHasReleaseConfirmedMarker,
  sortIssueCommentsDesc,
} from "./qa-gate.js";
import { resolveCompanyReleaseGateQaAgent } from "./release-gate-qa.js";

type ReadableDb = Pick<Db, "select">;

type WorkflowQaLaneIssue = {
  id: string;
  companyId: string;
  assigneeAgentId: string | null;
  assigneeUserId: string | null;
  workflowInvalidatedAt?: Date | null;
};

type WorkflowQaOwnerResolution = Awaited<ReturnType<typeof resolveCompanyReleaseGateQaAgent>>;

type WorkflowQaLaneGate = {
  artifactStatuses: IssueWorkflowArtifactStatus[];
  blockingReasons: string[];
  canComplete: boolean;
  authorizedOwnerAgentId: string | null;
  ownerResolution: WorkflowQaOwnerResolution;
};

const QA_VERDICT_DOCUMENT_KEY = "qa-verdict";

function workflowQaOwnerReason(input: {
  ownerResolution: WorkflowQaOwnerResolution;
  issue: WorkflowQaLaneIssue;
}) {
  if (!input.ownerResolution.releaseGateQaAgent) {
    if (input.ownerResolution.resolution === "configured_unavailable") {
      return "Workflow QA lane configured release-gate QA owner is unavailable.";
    }
    return input.ownerResolution.resolution === "none"
      ? "Workflow QA lane requires an eligible authorized release-gate QA owner."
      : "Workflow QA lane requires a single authorized release-gate QA owner.";
  }
  if (
    input.issue.assigneeUserId
    || input.issue.assigneeAgentId !== input.ownerResolution.releaseGateQaAgent.id
  ) {
    return "Workflow QA lane must be assigned to the authorized release-gate QA owner.";
  }
  return null;
}

async function listAuthorizedQaComments(db: ReadableDb, issueId: string, authorAgentId: string | null) {
  if (!authorAgentId) return [];
  const comments = await db
    .select({
      id: issueComments.id,
      body: issueComments.body,
      createdAt: issueComments.createdAt,
    })
    .from(issueComments)
    .where(
      and(
        eq(issueComments.issueId, issueId),
        eq(issueComments.authorAgentId, authorAgentId),
      ),
    );
  return comments.sort(sortIssueCommentsDesc);
}

async function getQaVerdictDocumentUpdatedAt(db: ReadableDb, issueId: string) {
  const rows = await db
    .select({ updatedAt: documents.updatedAt })
    .from(issueDocuments)
    .innerJoin(documents, eq(issueDocuments.documentId, documents.id))
    .where(
      and(
        eq(issueDocuments.issueId, issueId),
        eq(issueDocuments.key, QA_VERDICT_DOCUMENT_KEY),
      ),
    );
  return rows.reduce<Date | null>((latest, row) => {
    if (!latest || row.updatedAt.getTime() > latest.getTime()) return row.updatedAt;
    return latest;
  }, null);
}

function makeArtifactStatus(input: {
  key: string;
  label: string;
  kind: IssueWorkflowArtifactStatus["kind"];
  satisfied: boolean;
  stale?: boolean;
  detail: string | null;
}): IssueWorkflowArtifactStatus {
  return {
    key: input.key,
    label: input.label,
    kind: input.kind,
    blocking: true,
    satisfied: input.satisfied,
    stale: input.stale ?? false,
    detail: input.detail,
  };
}

export async function evaluateWorkflowQaLaneGate(
  db: ReadableDb,
  issue: WorkflowQaLaneIssue,
): Promise<WorkflowQaLaneGate> {
  const ownerResolution = await resolveCompanyReleaseGateQaAgent(db, issue.companyId);
  const authorizedOwnerAgentId = ownerResolution.releaseGateQaAgent?.id ?? null;
  const [qaVerdictUpdatedAt, authorizedComments] = await Promise.all([
    getQaVerdictDocumentUpdatedAt(db, issue.id),
    listAuthorizedQaComments(db, issue.id, authorizedOwnerAgentId),
  ]);

  const latestAuthorizedComment = authorizedComments[0] ?? null;
  const latestBody = latestAuthorizedComment?.body ?? "";
  const invalidatedAt = issue.workflowInvalidatedAt ? new Date(issue.workflowInvalidatedAt) : null;
  const qaVerdictStale = Boolean(
    qaVerdictUpdatedAt
    && invalidatedAt
    && qaVerdictUpdatedAt.getTime() < invalidatedAt.getTime(),
  );
  const qaVerdictSatisfied = Boolean(qaVerdictUpdatedAt) && !qaVerdictStale;
  const summary = parseQaSummary(latestBody);
  const verification = parseQaVerification(latestBody);
  const hasQaPass = qaCommentHasQaPassMarker(latestBody);
  const hasReleaseConfirmed = qaCommentHasReleaseConfirmedMarker(latestBody);

  const artifactStatuses: IssueWorkflowArtifactStatus[] = [
    makeArtifactStatus({
      key: QA_VERDICT_DOCUMENT_KEY,
      label: "QA verdict document",
      kind: "document",
      satisfied: qaVerdictSatisfied,
      stale: qaVerdictStale,
      detail:
        qaVerdictSatisfied
          ? null
          : qaVerdictStale
            ? "QA verdict document is stale and must be refreshed after upstream changes."
            : "QA verdict document is missing.",
    }),
    makeArtifactStatus({
      key: "smart-review-summary",
      label: "Smart Review summary",
      kind: "comment_marker",
      satisfied: summary.hasSummary && summary.overall !== "fail",
      detail:
        summary.hasSummary
          ? summary.overall === "fail"
            ? "Latest authorized QA verdict contains failing Smart Review findings."
            : null
          : "Latest authorized QA verdict must include the full Smart Review summary.",
    }),
    makeArtifactStatus({
      key: "verification-line",
      label: "Verification evidence",
      kind: "comment_marker",
      satisfied: verification.complete && verification.overall === "pass",
      detail:
        verification.complete
          ? verification.overall === "pass"
            ? null
            : "Latest authorized QA verdict must include passing verification evidence."
          : "Latest authorized QA verdict must include passing verification evidence.",
    }),
    makeArtifactStatus({
      key: "qa-pass",
      label: "[QA PASS] marker",
      kind: "comment_marker",
      satisfied: hasQaPass,
      detail: hasQaPass ? null : "Latest authorized QA verdict must include [QA PASS].",
    }),
    makeArtifactStatus({
      key: "release-confirmed",
      label: "[RELEASE CONFIRMED] marker",
      kind: "comment_marker",
      satisfied: hasReleaseConfirmed,
      detail:
        hasReleaseConfirmed
          ? null
          : "Latest authorized QA verdict must include [RELEASE CONFIRMED].",
    }),
  ];

  const blockingReasons = artifactStatuses
    .filter((artifact) => !artifact.satisfied)
    .map((artifact) => artifact.detail ?? `${artifact.label} is missing.`);
  const ownerReason = workflowQaOwnerReason({ ownerResolution, issue });
  if (ownerReason) {
    blockingReasons.unshift(ownerReason);
  }

  return {
    artifactStatuses,
    blockingReasons: Array.from(new Set(blockingReasons)),
    canComplete: !ownerReason && artifactStatuses.every((artifact) => artifact.satisfied),
    authorizedOwnerAgentId,
    ownerResolution,
  };
}

export async function resolveAuthorizedWorkflowQaOwnerAgentId(db: ReadableDb, companyId: string) {
  const ownerResolution = await resolveCompanyReleaseGateQaAgent(db, companyId);
  return ownerResolution.releaseGateQaAgent?.id ?? null;
}
