/**
 * Info-only comment marker (synthiq fork, 2026-10-16). A comment whose body starts with `[no-wake]` (case-insensitive,
 * leading whitespace allowed) is recorded and shown normally, but it does not wake the assignee and does not
 * implicitly reopen a blocked or closed issue. An explicit `resume: true` or `reopen: true` on the same request still
 * wins. Without the marker nothing changes. Use it for status notes that need no action; a comment that carries a
 * decision the assignee must act on must not carry it.
 */
export const NO_WAKE_COMMENT_MARKER = "[no-wake]";

export function isNoWakeComment(body: unknown): boolean {
  return typeof body === "string" && body.trimStart().toLowerCase().startsWith(NO_WAKE_COMMENT_MARKER);
}

export function shouldWakeAssigneeForIssueComment(input: {
  selfComment: boolean;
  resumeRequested: boolean;
  commentCreatedByRunId?: string | null;
  issueAtCommentStart: {
    checkoutRunId?: string | null;
    executionRunId?: string | null;
  };
  reopened: boolean;
  currentStatus: string | null | undefined;
  noWake?: boolean;
}) {
  if (input.noWake && !input.resumeRequested && !input.reopened) return false;
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
  return (
    input.reopened ||
    (input.currentStatus !== "done" && input.currentStatus !== "cancelled")
  );
}
