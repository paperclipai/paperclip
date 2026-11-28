import { extractAgentMentionIds } from "@paperclipai/shared";

export function shouldWakeAssigneeForIssueComment(input: {
  selfComment: boolean;
  assigneeMentioned?: boolean;
  resumeRequested: boolean;
  commentCreatedByRunId?: string | null;
  issueAtCommentStart: {
    checkoutRunId?: string | null;
    executionRunId?: string | null;
  };
  reopened: boolean;
  currentStatus: string | null | undefined;
}) {
  const sourceRunId = input.commentCreatedByRunId;
  const commentIsFromCurrentIssueRun = Boolean(
    sourceRunId &&
    (sourceRunId === input.issueAtCommentStart.checkoutRunId ||
      sourceRunId === input.issueAtCommentStart.executionRunId),
  );
  if (
    input.selfComment &&
    (!input.resumeRequested || commentIsFromCurrentIssueRun)
  ) {
    return false;
  }
  if (input.currentStatus === "blocked") return false;
  if (!input.reopened && !input.resumeRequested && !input.assigneeMentioned) return false;
  return (
    input.reopened ||
    (input.currentStatus !== "done" && input.currentStatus !== "cancelled")
  );
}

/** A mention routes input; it does not grant execution or change task state. */
export function canNotifyIssueCommentAssignee(body: string, assigneeAgentId: string | null | undefined, status: string | null | undefined, actionable = false) {
  return actionable && !!assigneeAgentId && !["blocked", "done", "cancelled"].includes(status ?? "")
    && extractAgentMentionIds(body).includes(assigneeAgentId);
}

/** Structured interaction/recovery/status operations keep their independent admission. */
export function isOrdinaryIssueCommentWake(reason: string | null | undefined, context: Record<string, unknown>) {
  return ["issue_commented", "issue_comment_mentioned", "issue_reopened_via_comment"].includes(reason ?? "") && !context.interactionId && context.source !== "issue.stop_relay";
}

/** Never read intent from wake payloads or body prose. Match the stored writer and destination. */
export function hasActionableCommentIntent(comment: {
  companyId?: string; issueId?: string; authorAgentId?: string | null; authorUserId?: string | null;
  metadata?: unknown;
}, recipientAgentId: string | null | undefined) {
  const m = comment.metadata as {commentWake?: Record<string, unknown>} | null | undefined;
  const w=m?.commentWake;
  if (!w || w.version!==1 || w.kind!=="actionable" || w.companyId!==comment.companyId || w.issueId!==comment.issueId ||
      w.recipientAgentId!==recipientAgentId || typeof w.request!=="string" || !w.request.trim()) return false;
  return w.actorType==="agent" ? !!comment.authorAgentId && w.actorId===comment.authorAgentId
    : w.actorType==="user" && !comment.authorAgentId && !!comment.authorUserId && w.actorId===comment.authorUserId;
}
