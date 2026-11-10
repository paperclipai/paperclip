import { and, eq, sql } from "drizzle-orm";
import { activityLog, issueComments, issues, type Db } from "@paperclipai/db";
import type { IssueRelatedWorkSummary } from "@paperclipai/shared";
import { notFound } from "../errors.js";
import { logActivity, publishActivity, type ActivityPublication, type LogActivityInput } from "./activity-log.js";
import type { issueReferenceService } from "./issue-references.js";

type CommentReferences = Pick<ReturnType<typeof issueReferenceService>,
  "syncComment" | "listIssueReferenceSummary" | "diffIssueReferenceSummary">;
type ReferenceDiff = ReturnType<CommentReferences["diffIssueReferenceSummary"]>;

export async function completeIssueCommentReceipt(db: Db, references: CommentReferences, input: {
  companyId: string;
  issueId: string;
  commentId: string;
  referenceSummaryBefore?: IssueRelatedWorkSummary;
  activity: (diff: ReferenceDiff) => LogActivityInput;
}) {
  const publications: ActivityPublication[] = [];
  await db.transaction(async tx => {
    const connection = tx as unknown as Db;
    // Match task deletion and comment mutation: lock the task before its
    // comment. NO KEY UPDATE still permits references from other tasks.
    const [issue] = await tx.select({ id: issues.id }).from(issues).where(and(
      eq(issues.id, input.issueId), eq(issues.companyId, input.companyId),
    )).for("no key update");
    if (!issue) throw notFound("Issue not found");
    const [comment] = await tx.select({ id: issueComments.id, deletedAt: issueComments.deletedAt }).from(issueComments).where(and(
      eq(issueComments.id, input.commentId), eq(issueComments.companyId, input.companyId),
      eq(issueComments.issueId, input.issueId),
    )).for("update");
    if (!comment || comment.deletedAt) throw notFound("Issue comment not found");
    const before = input.referenceSummaryBefore ?? await references.listIssueReferenceSummary(input.issueId, connection);
    await references.syncComment(input.commentId, connection);
    const after = await references.listIssueReferenceSummary(input.issueId, connection);
    const diff = references.diffIssueReferenceSummary(before, after);
    const [existing] = await tx.select({ id: activityLog.id }).from(activityLog).where(and(
      eq(activityLog.companyId, input.companyId), eq(activityLog.entityType, "issue"),
      eq(activityLog.entityId, input.issueId), eq(activityLog.action, "issue.comment_added"),
      sql`${activityLog.details}->>'commentId' = ${input.commentId}`,
    ));
    if (!existing) {
      const activity = input.activity(diff);
      await logActivity(connection, {
        ...activity, companyId: input.companyId, action: "issue.comment_added",
        entityType: "issue", entityId: input.issueId,
        details: { ...activity.details, commentId: input.commentId },
      }, publications);
    }
  });
  for (const publication of publications) publishActivity(publication);
}
