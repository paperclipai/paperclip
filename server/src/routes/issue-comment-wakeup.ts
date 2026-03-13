import {
  MAX_WAKE_COMMENT_BODY_CHARS,
  normalizeWakeCommentBody,
} from "@paperclipai/adapter-utils/server-utils";

type IssueCommentWakeInput = {
  issueId: string;
  commentId: string;
  commentBody: string;
};

type IssueCommentWakePayloadInput = IssueCommentWakeInput & {
  extras?: Record<string, unknown>;
};

type IssueCommentWakeContextInput = IssueCommentWakeInput & {
  wakeReason: string;
  source: string;
  includeWakeCommentId?: boolean;
  extras?: Record<string, unknown>;
};

export { MAX_WAKE_COMMENT_BODY_CHARS };

export function buildIssueCommentWakePayload(input: IssueCommentWakePayloadInput) {
  const wakeCommentBody = normalizeWakeCommentBody(input.commentBody);
  return {
    issueId: input.issueId,
    commentId: input.commentId,
    ...(wakeCommentBody ? { wakeCommentBody } : {}),
    ...(input.extras ?? {}),
  };
}

export function buildIssueCommentWakeContextSnapshot(input: IssueCommentWakeContextInput) {
  const wakeCommentBody = normalizeWakeCommentBody(input.commentBody);
  return {
    issueId: input.issueId,
    taskId: input.issueId,
    commentId: input.commentId,
    ...(input.includeWakeCommentId ? { wakeCommentId: input.commentId } : {}),
    ...(wakeCommentBody ? { wakeCommentBody } : {}),
    wakeReason: input.wakeReason,
    source: input.source,
    ...(input.extras ?? {}),
  };
}
