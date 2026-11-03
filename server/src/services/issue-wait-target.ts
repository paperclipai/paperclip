import { and, eq, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { issues } from "@paperclipai/db";
import { parseIssueExecutionState } from "./issue-execution-policy.js";

export async function readCurrentIssueWaitTarget(
  db: Db,
  issue: Pick<typeof issues.$inferSelect, "id" | "companyId" | "assigneeUserId" | "executionState">,
): Promise<boolean> {
  if (issue.assigneeUserId || parseIssueExecutionState(issue.executionState)?.status === "pending") return true;
  const [row] = await db.select({ hasTarget: sql<boolean>`
    exists(select 1 from issue_thread_interactions i
      where i.company_id = ${issue.companyId} and i.issue_id = ${issue.id}
        and i.status = 'pending')
    or exists(select 1 from issue_approvals ia
      join approvals a on a.id = ia.approval_id and a.company_id = ia.company_id
      where ia.company_id = ${issue.companyId} and ia.issue_id = ${issue.id}
        and a.status in ('pending', 'revision_requested'))
    or exists(select 1 from issue_work_products w
      where w.company_id = ${issue.companyId} and w.issue_id = ${issue.id}
        and w.status not in ('merged', 'closed', 'archived', 'failed')
        and (w.status = 'ready_for_review' or w.review_state = 'needs_board_review'))
    or exists(select 1 from issues child
      where child.company_id = ${issue.companyId} and child.parent_id = ${issue.id}
        and child.status = 'in_review' and child.hidden_at is null)
    or exists(select 1 from issue_relations relation
      join issues target on target.id = relation.issue_id and target.company_id = relation.company_id
      where relation.company_id = ${issue.companyId} and relation.related_issue_id = ${issue.id}
        and relation.type = 'blocks' and target.status = 'in_review' and target.hidden_at is null)
  ` }).from(issues).where(and(eq(issues.id, issue.id), eq(issues.companyId, issue.companyId))).limit(1);
  return row?.hasTarget ?? true;
}
