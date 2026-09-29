import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { heartbeatRuns, issues, issueThreadInteractions, statusDecisions, type Db } from "@paperclipai/db";
import type { ExecutionContinuationEnvelope } from "@paperclipai/shared";

/** Recorded decisions are evidence for the parent, never new review authority. */
export async function childReviewOutcomes(
  db: Db,
  companyId: string,
  parentIssueId: string,
): Promise<ExecutionContinuationEnvelope["interactionOutcomes"]> {
  const rows = await db.select({
    id: issueThreadInteractions.id,
    status: issueThreadInteractions.status,
    childTaskId: issues.id,
    childTaskIdentifier: issues.identifier,
    childTaskStatus: issues.status,
    sourceDecisionId: statusDecisions.id,
    sourceRunId: issueThreadInteractions.sourceRunId,
    reviewerAgentId: issueThreadInteractions.resolvedByAgentId,
    reviewerUserId: issueThreadInteractions.resolvedByUserId,
    reviewerRunId: issueThreadInteractions.resolvedByRunId,
    resolvedAt: issueThreadInteractions.resolvedAt,
  }).from(issues)
    .innerJoin(issueThreadInteractions, and(
      eq(issueThreadInteractions.issueId, issues.id),
      eq(issueThreadInteractions.companyId, issues.companyId),
    ))
    .innerJoin(statusDecisions, and(
      eq(statusDecisions.issueId, issues.id),
      eq(statusDecisions.companyId, issues.companyId),
      eq(statusDecisions.runId, issueThreadInteractions.sourceRunId),
      sql`${statusDecisions.id}::text = ${issueThreadInteractions.payload}->'target'->>'revisionId'`,
      eq(statusDecisions.applicationState, "applied"),
    ))
    .innerJoin(heartbeatRuns, and(
      eq(heartbeatRuns.id, statusDecisions.runId),
      eq(heartbeatRuns.companyId, issues.companyId),
      eq(heartbeatRuns.nativeIssueId, issues.id),
    ))
    .where(and(
      eq(issues.companyId, companyId),
      eq(issues.parentId, parentIssueId),
      eq(issueThreadInteractions.kind, "request_confirmation"),
      inArray(issueThreadInteractions.status, ["accepted", "rejected"]),
      sql`${issueThreadInteractions.payload}->'target'->>'type' = 'custom'`,
      sql`${issueThreadInteractions.payload}->'target'->>'key' = 'native_completion_review'`,
    ))
    .orderBy(desc(issueThreadInteractions.resolvedAt), desc(issueThreadInteractions.id))
    .limit(50);
  return rows.map(({ id, status, resolvedAt, ...result }) => ({
    id,
    kind: "native_completion_review",
    status,
    result: { ...result, resolvedAt: resolvedAt?.toISOString() ?? null },
  }));
}
