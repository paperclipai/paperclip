import { and, asc, eq, gt, inArray, isNull, or, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { issueRelations, issues, toolActionRequests } from "@paperclipai/db";
import { parseIssueExecutionState, normalizeIssueExecutionPolicy } from "./issue-execution-policy.js";
import { issueService, executeIssuePostCommitActions, type IssuePostCommitAction } from "./issues.js";
import { issueTreeControlService } from "./issue-tree-control.js";
import { logActivity, publishActivity, type ActivityPublication } from "./activity-log.js";

/** Completion is separate from approval: a dependency hold never loses a verdict. */
export function holdReviewedIssueForDependencies(input: {
  status: string;
  executionState: unknown;
  unresolvedBlockerIssueIds: string[];
  now: Date;
}): Partial<typeof issues.$inferInsert> | null {
  const state = parseIssueExecutionState(input.executionState);
  if (!["in_review", "in_progress"].includes(input.status) || state?.status !== "completed" || state.lastDecisionOutcome !== "approved") return null;
  return {
    status: input.status,
    completedAt: null,
    executionState: {
      ...state,
      dependencyHold: {
        heldAt: state.dependencyHold?.heldAt ?? input.now.toISOString(),
        unresolvedBlockerIssueIds: input.unresolvedBlockerIssueIds,
      },
    },
  };
}

let dependencyHoldSweepCursor: string | null = null;

/** Called by dependency completion and the scheduler's existing dependency backstop. */
export async function reconcileReviewDependencyHolds(
  db: Db,
  input: { companyId?: string | null; blockerIssueId?: string | null; issueId?: string } = {},
): Promise<string[]> {
  const sweeping = !input.companyId && !input.blockerIssueId && !input.issueId;
  const candidates = await db.select({ id: issues.id, companyId: issues.companyId }).from(issues)
    .where(and(
      inArray(issues.status, ["in_review", "in_progress"]), isNull(issues.hiddenAt),
      sweeping && dependencyHoldSweepCursor ? gt(issues.id, dependencyHoldSweepCursor) : undefined,
      input.issueId ? or(eq(issues.id, input.issueId), sql`exists (select 1 from ${issueRelations} r
        where r.company_id = ${issues.companyId} and r.related_issue_id = ${issues.id}
          and r.type = 'blocks' and r.issue_id = ${input.issueId})`) : undefined,
      sql`${issues.executionState}->>'status' = 'completed'`,
      sql`${issues.executionState}->'dependencyHold' is not null and ${issues.executionState}->'dependencyHold' <> 'null'::jsonb`,
      input.companyId ? eq(issues.companyId, input.companyId) : undefined,
      input.blockerIssueId ? sql`exists (select 1 from ${issueRelations} r where r.company_id = ${issues.companyId}
        and r.related_issue_id = ${issues.id} and r.type = 'blocks' and r.issue_id = ${input.blockerIssueId})` : undefined,
    )).orderBy(asc(issues.id)).limit(100);
  if (sweeping) dependencyHoldSweepCursor = candidates.length === 100 ? candidates[99]!.id : null;
  const completed: string[] = [];
  const activityPublications: ActivityPublication[] = [];
  const postCommitActions: IssuePostCommitAction[] = [];
  const svc = issueService(db);
  for (const candidate of candidates) {
    await db.transaction(async (tx) => {
      const [issue] = await tx.select().from(issues)
        .where(and(eq(issues.companyId, candidate.companyId), eq(issues.id, candidate.id))).for("update");
      if (!issue || !["in_review", "in_progress"].includes(issue.status)) return;
      const state = parseIssueExecutionState(issue.executionState);
      if (state?.status !== "completed" || !state.dependencyHold || state.lastDecisionOutcome !== "approved") return;
      const policy = normalizeIssueExecutionPolicy(issue.executionPolicy);
      if (!policy?.stages.length || policy.stages.some((stage) => !state.completedStageIds.includes(stage.id))) return;
      const readiness = (await svc.listDependencyReadiness(issue.companyId, [issue.id], tx)).get(issue.id);
      if (!readiness?.isDependencyReady) return;
      if (await issueTreeControlService(tx as unknown as Db).getActivePauseHoldGate(issue.companyId, issue.id)) return;
      const [pendingToolReview] = await tx.select({ id: toolActionRequests.id }).from(toolActionRequests)
        .where(and(eq(toolActionRequests.companyId, issue.companyId), eq(toolActionRequests.issueId, issue.id),
          sql`${toolActionRequests.status} in ('pending', 'approved', 'executing')`)).limit(1);
      if (pendingToolReview) return;
      const updated = await svc.update(issue.id, { status: "done", executionState: { ...state, dependencyHold: null } },
        tx, activityPublications, postCommitActions);
      if (updated?.status !== "done") return;
      await logActivity(tx as unknown as Db, { companyId: issue.companyId, actorType: "system", actorId: "dependency_reconciliation",
        action: "issue.review_dependency_hold_resolved", entityType: "issue", entityId: issue.id,
        details: { completedStageIds: state.completedStageIds, blockerIssueIds: readiness.blockerIssueIds } }, activityPublications);
      completed.push(issue.id);
    });
  }
  for (const publication of activityPublications) publishActivity(publication);
  await executeIssuePostCommitActions(db, postCommitActions);
  return completed;
}
