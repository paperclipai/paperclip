import { and, desc, eq, gt, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { heartbeatRuns, issueComments, issues, type Db } from "@paperclipai/db";
import { issueService } from "../issues.js";
import { systemNoticePresentation } from "../recovery/notice-format.js";

export const PROVIDER_LIMIT_HOLD_NOTICE_TITLE = "Waiting for the AI usage limit";

function readCommentIds(context: Record<string, unknown> | null | undefined) {
  const ids = [context?.wakeCommentId, ...(Array.isArray(context?.wakeCommentIds) ? context.wakeCommentIds : [])];
  return [...new Set(ids.filter((id): id is string => typeof id === "string" && id.length > 0))];
}

function formatResetTime(at: Date) {
  return `${at.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

/**
 * A same-run bootstrap retry held until the agent's provider limit resets
 * starts no work, so nothing else tells the person who wrote. Posts one
 * notice per wait in a chat or after a person's message: a notice already
 * posted since the agent's last reply covers every later held run.
 */
export async function postProviderLimitHoldNotice(db: Db, input: {
  companyId: string;
  issueId: string;
  runId: string;
  agentId: string;
  retryAt: Date;
}): Promise<boolean> {
  return db.transaction(async (transaction) => {
    const tx = transaction as unknown as Db;
    const [issue] = await tx.select({ conversationAgentId: issues.conversationAgentId }).from(issues)
      .where(and(eq(issues.id, input.issueId), eq(issues.companyId, input.companyId))).for("update");
    if (!issue) return false;
    if (!issue.conversationAgentId) {
      const [run] = await tx.select({ contextSnapshot: heartbeatRuns.contextSnapshot }).from(heartbeatRuns)
        .where(and(eq(heartbeatRuns.id, input.runId), eq(heartbeatRuns.companyId, input.companyId)));
      const commentIds = readCommentIds(run?.contextSnapshot);
      if (commentIds.length === 0) return false;
      const [personMessage] = await tx.select({ id: issueComments.id }).from(issueComments).where(and(
        eq(issueComments.companyId, input.companyId), eq(issueComments.issueId, input.issueId),
        inArray(issueComments.id, commentIds), isNotNull(issueComments.authorUserId),
        isNull(issueComments.authorAgentId))).limit(1);
      if (!personMessage) return false;
    }
    const [lastReply] = await tx.select({ createdAt: issueComments.createdAt }).from(issueComments).where(and(
      eq(issueComments.companyId, input.companyId), eq(issueComments.issueId, input.issueId),
      eq(issueComments.authorAgentId, input.agentId))).orderBy(desc(issueComments.createdAt)).limit(1);
    const [posted] = await tx.select({ id: issueComments.id }).from(issueComments).where(and(
      eq(issueComments.companyId, input.companyId), eq(issueComments.issueId, input.issueId),
      eq(issueComments.authorType, "system"),
      sql`${issueComments.presentation}->>'title' = ${PROVIDER_LIMIT_HOLD_NOTICE_TITLE}`,
      ...(lastReply ? [gt(issueComments.createdAt, lastReply.createdAt)] : []))).limit(1);
    if (posted) return false;
    await issueService(tx).addComment(input.issueId,
      `This agent reached its AI usage limit, so it could not start. It will answer your messages after the limit resets, at about ${formatResetTime(input.retryAt)}. You do not need to do anything.`,
      // Not a reply of the held run's chat turn, so it carries no run authority.
      {},
      { authorType: "system", presentation: systemNoticePresentation({ tone: "warning", title: PROVIDER_LIMIT_HOLD_NOTICE_TITLE }) },
      tx);
    return true;
  });
}
