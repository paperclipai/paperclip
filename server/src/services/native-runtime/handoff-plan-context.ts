import { and, desc, eq, lte } from "drizzle-orm";
import { documentRevisions, heartbeatRuns, issueDocuments, issues, issueThreadInteractions, type Db } from "@paperclipai/db";

/** Approval evidence belongs to the source conversation and exact revision.
 * It informs scope; it does not approve the new task's document or waive gates. */
export async function handoffPlanContext(db: Db, task: typeof issues.$inferSelect) {
  if (!task.originRunId || task.conversationAgentId) return null;
  const [sourceRun] = await db.select().from(heartbeatRuns).where(and(
    eq(heartbeatRuns.id, task.originRunId), eq(heartbeatRuns.companyId, task.companyId),
  ));
  const sourceId = sourceRun?.nativeIssueId ?? sourceRun?.contextSnapshot?.issueId;
  if (typeof sourceId !== "string" || sourceId === task.id) return null;
  const [source] = await db.select().from(issues).where(and(eq(issues.id, sourceId), eq(issues.companyId, task.companyId)));
  if (!source?.conversationAgentId) return null;
  const accepted = await db.select().from(issueThreadInteractions).where(and(
    eq(issueThreadInteractions.companyId, task.companyId), eq(issueThreadInteractions.issueId, source.id),
    eq(issueThreadInteractions.kind, "request_confirmation"), eq(issueThreadInteractions.status, "accepted"),
    lte(issueThreadInteractions.resolvedAt, task.createdAt),
  )).orderBy(desc(issueThreadInteractions.resolvedAt));
  for (const interaction of accepted) {
    const target = (interaction.payload as { target?: { type?: string; key?: string; revisionId?: string; issueId?: string } }).target;
    if (target?.type !== "issue_document" || target.key !== "plan" || !target.revisionId ||
        (target.issueId && target.issueId !== source.id)) continue;
    const [revision] = await db.select({ markdown: documentRevisions.body, revisionId: documentRevisions.id })
      .from(documentRevisions).innerJoin(issueDocuments, and(
        eq(issueDocuments.documentId, documentRevisions.documentId), eq(issueDocuments.companyId, task.companyId),
        eq(issueDocuments.issueId, source.id), eq(issueDocuments.key, "plan"),
      )).where(and(eq(documentRevisions.id, target.revisionId), eq(documentRevisions.companyId, task.companyId)));
    if (revision) return { sourceIssueId: source.id, interactionId: interaction.id, ...revision,
      guidance: "This source plan was accepted before this task was created. Execute the assigned scope within that plan; planning and handoff steps already completed in the source are not new work. This is not approval of changes to scope or of a new task document. Preserve other applicable gates." };
  }
  return null;
}
