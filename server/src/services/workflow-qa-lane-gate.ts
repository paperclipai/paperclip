import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, documents, issueComments, issueDocuments } from "@paperclipai/db";
import type { IssueWorkflowArtifactStatus } from "@paperclipai/shared";
import {
  parseQaSummary,
  parseQaVerification,
  qaCommentHasExplicitVerificationTokens,
  qaCommentHasQaPassMarker,
  qaCommentHasReleaseConfirmedMarker,
  sortIssueCommentsDesc,
} from "./qa-gate.js";

type ReadableDb = Pick<Db, "select">;

type WorkflowQaLaneIssue = {
  id: string;
  companyId: string;
  assigneeAgentId: string | null;
  assigneeUserId: string | null;
  qaReviewerAgentId?: string | null;
  workflowInvalidatedAt?: Date | null;
};

type WorkflowQaLaneGate = {
  artifactStatuses: IssueWorkflowArtifactStatus[];
  blockingReasons: string[];
  canComplete: boolean;
  authorizedOwnerAgentId: string | null;
};

const QA_VERDICT_DOCUMENT_KEY = "qa-verdict";

function workflowQaOwnerReason(input: {
  issue: WorkflowQaLaneIssue;
  assigneeRole: string | null;
}) {
  if (input.issue.assigneeUserId || !input.issue.assigneeAgentId) {
    return "Workflow QA lane must be assigned to an active QA reviewer.";
  }
  if (input.assigneeRole !== "qa") {
    return "Workflow QA lane must be assigned to an active QA reviewer.";
  }
  return null;
}

async function getWorkflowQaAssigneeRole(db: ReadableDb, issue: WorkflowQaLaneIssue) {
  if (!issue.assigneeAgentId) return null;
  const assignee = await db
    .select({
      role: agents.role,
    })
    .from(agents)
    .where(and(eq(agents.id, issue.assigneeAgentId), eq(agents.companyId, issue.companyId)))
    .then((rows) => rows[0] ?? null);
  return assignee?.role ?? null;
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
  const assigneeRole = await getWorkflowQaAssigneeRole(db, issue);
  const ownerReason = workflowQaOwnerReason({ issue, assigneeRole });
  const authorizedOwnerAgentId = ownerReason
    ? null
    : issue.assigneeAgentId ?? null;
  const [qaVerdictUpdatedAt, authorizedComments] = await Promise.all([
    getQaVerdictDocumentUpdatedAt(db, issue.id),
    listAuthorizedQaComments(db, issue.id, authorizedOwnerAgentId),
  ]);

  const latestAuthorizedComment = authorizedComments[0] ?? null;
  const invalidatedAt = issue.workflowInvalidatedAt ? new Date(issue.workflowInvalidatedAt) : null;
  const latestAuthorizedCommentStale = Boolean(
    latestAuthorizedComment
    && invalidatedAt
    && latestAuthorizedComment.createdAt.getTime() < invalidatedAt.getTime(),
  );
  const latestBody = latestAuthorizedCommentStale ? "" : (latestAuthorizedComment?.body ?? "");
  const staleCommentDetail = "Latest assigned QA verdict comment is stale and must be refreshed after upstream changes.";
  const qaVerdictStale = Boolean(
    qaVerdictUpdatedAt
    && invalidatedAt
    && qaVerdictUpdatedAt.getTime() < invalidatedAt.getTime(),
  );
  const qaVerdictSatisfied = Boolean(qaVerdictUpdatedAt) && !qaVerdictStale;
  const summary = parseQaSummary(latestBody);
  const verification = parseQaVerification(latestBody);
  const hasExplicitVerification = qaCommentHasExplicitVerificationTokens(latestBody);
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
      stale: latestAuthorizedCommentStale,
      detail:
        latestAuthorizedCommentStale
          ? staleCommentDetail
          : summary.hasSummary
          ? summary.overall === "fail"
            ? "Latest assigned QA verdict contains failing Smart Review findings."
            : null
          : "Latest assigned QA verdict must include the full Smart Review summary.",
    }),
    makeArtifactStatus({
      key: "verification-line",
      label: "Verification evidence",
      kind: "comment_marker",
      satisfied: hasExplicitVerification && verification.complete && verification.overall === "pass",
      stale: latestAuthorizedCommentStale,
      detail:
        latestAuthorizedCommentStale
          ? staleCommentDetail
          : hasExplicitVerification && verification.complete
          ? verification.overall === "pass"
            ? null
            : "Latest assigned QA verdict must include passing verification evidence."
          : "Latest assigned QA verdict must include passing verification evidence.",
    }),
    makeArtifactStatus({
      key: "qa-pass",
      label: "[QA PASS] marker",
      kind: "comment_marker",
      satisfied: hasQaPass,
      stale: latestAuthorizedCommentStale,
      detail: latestAuthorizedCommentStale
        ? staleCommentDetail
        : hasQaPass ? null : "Latest assigned QA verdict must include [QA PASS].",
    }),
    makeArtifactStatus({
      key: "release-confirmed",
      label: "[RELEASE CONFIRMED] marker",
      kind: "comment_marker",
      satisfied: hasReleaseConfirmed,
      stale: latestAuthorizedCommentStale,
      detail:
        latestAuthorizedCommentStale
          ? staleCommentDetail
          : hasReleaseConfirmed
          ? null
          : "Latest assigned QA verdict must include [RELEASE CONFIRMED].",
    }),
  ];

  const blockingReasons = artifactStatuses
    .filter((artifact) => !artifact.satisfied)
    .map((artifact) => artifact.detail ?? `${artifact.label} is missing.`);
  if (ownerReason) {
    blockingReasons.unshift(ownerReason);
  }

  return {
    artifactStatuses,
    blockingReasons: Array.from(new Set(blockingReasons)),
    canComplete: !ownerReason && artifactStatuses.every((artifact) => artifact.satisfied),
    authorizedOwnerAgentId,
  };
}
