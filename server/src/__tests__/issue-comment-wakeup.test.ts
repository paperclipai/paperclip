import { describe, expect, it } from "vitest";
import {
  MAX_WAKE_COMMENT_BODY_CHARS,
  buildIssueCommentWakeContextSnapshot,
  buildIssueCommentWakePayload,
} from "../routes/issue-comment-wakeup.js";

describe("issue comment wake helpers", () => {
  it("truncates wakeCommentBody in wake payloads", () => {
    const wakeCommentBody = "x".repeat(MAX_WAKE_COMMENT_BODY_CHARS + 25);

    expect(
      buildIssueCommentWakePayload({
        issueId: "issue-1",
        commentId: "comment-1",
        commentBody: wakeCommentBody,
        extras: { mutation: "comment" },
      }),
    ).toEqual({
      issueId: "issue-1",
      commentId: "comment-1",
      wakeCommentBody: "x".repeat(MAX_WAKE_COMMENT_BODY_CHARS),
      mutation: "comment",
    });
  });

  it("builds commented wake context with task and comment body", () => {
    expect(
      buildIssueCommentWakeContextSnapshot({
        issueId: "issue-1",
        commentId: "comment-1",
        commentBody: "Please continue from the latest feedback.",
        wakeReason: "issue_commented",
        source: "issue.comment",
      }),
    ).toEqual({
      issueId: "issue-1",
      taskId: "issue-1",
      commentId: "comment-1",
      wakeCommentBody: "Please continue from the latest feedback.",
      wakeReason: "issue_commented",
      source: "issue.comment",
    });
  });

  it("builds mention wake context with wakeCommentId", () => {
    expect(
      buildIssueCommentWakeContextSnapshot({
        issueId: "issue-1",
        commentId: "comment-1",
        commentBody: "@Polytope please review the new numbers.",
        wakeReason: "issue_comment_mentioned",
        source: "comment.mention",
        includeWakeCommentId: true,
      }),
    ).toEqual({
      issueId: "issue-1",
      taskId: "issue-1",
      commentId: "comment-1",
      wakeCommentId: "comment-1",
      wakeCommentBody: "@Polytope please review the new numbers.",
      wakeReason: "issue_comment_mentioned",
      source: "comment.mention",
    });
  });
});
