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
  return (
    input.reopened ||
    (input.currentStatus !== "done" && input.currentStatus !== "cancelled")
  );
}

/** Agent-to-agent courtesy replies carry no instruction or changed evidence. */
export function isAgentAcknowledgementOnly(input: {
  body: string;
  actorType: string;
  resumeRequested: boolean;
  reopened: boolean;
  hasAttachments: boolean;
}): boolean {
  if (input.actorType !== "agent" || input.resumeRequested || input.reopened || input.hasAttachments) {
    return false;
  }
  const body = input.body.trim().toLowerCase();
  return /^(?:ack|acknowledged|noted|received|thanks|thank you|understood)[.!]?$/u.test(body);
}
