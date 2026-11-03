import { describe, expect, it } from "vitest";
import {
  buildIssueCommentWakeIdempotencyKey,
  isIssueCommentWakeIdempotencyKey,
  shouldWakeAssigneeForIssueComment,
} from "./issue-comment-wakeup.js";

describe("shouldWakeAssigneeForIssueComment", () => {
  it("suppresses explicit resume from the run that currently owns the issue", () => {
    expect(
      shouldWakeAssigneeForIssueComment({
        selfComment: true,
        resumeRequested: true,
        commentCreatedByRunId: "run-current",
        issueAtCommentStart: {
          checkoutRunId: "run-current",
          executionRunId: "run-current",
        },
        reopened: false,
        currentStatus: "in_progress",
      }),
    ).toBe(false);
  });

  it("preserves explicit resume from a completed prior run", () => {
    expect(
      shouldWakeAssigneeForIssueComment({
        selfComment: true,
        resumeRequested: true,
        commentCreatedByRunId: "run-prior",
        issueAtCommentStart: {
          checkoutRunId: "run-current",
          executionRunId: "run-current",
        },
        reopened: false,
        currentStatus: "in_progress",
      }),
    ).toBe(true);
  });

  it("keeps ordinary self-comments inert", () => {
    expect(
      shouldWakeAssigneeForIssueComment({
        selfComment: true,
        resumeRequested: false,
        commentCreatedByRunId: "run-prior",
        issueAtCommentStart: {},
        reopened: false,
        currentStatus: "in_progress",
      }),
    ).toBe(false);
  });

  it("does not wake a closed issue unless the comment reopened it", () => {
    const base = {
      selfComment: false,
      resumeRequested: false,
      issueAtCommentStart: {},
      currentStatus: "done",
    };
    expect(
      shouldWakeAssigneeForIssueComment({ ...base, reopened: false }),
    ).toBe(false);
    expect(shouldWakeAssigneeForIssueComment({ ...base, reopened: true })).toBe(
      true,
    );
  });

  it("binds durable wake retries to the exact comment and assignee", () => {
    const idempotencyKey = buildIssueCommentWakeIdempotencyKey(
      "comment-1",
      "agent-1",
    );
    expect(idempotencyKey).toBe("issue-comment:comment-1:agent-1");
    expect(
      isIssueCommentWakeIdempotencyKey({
        idempotencyKey,
        commentId: "comment-1",
        agentId: "agent-1",
      }),
    ).toBe(true);
    expect(
      isIssueCommentWakeIdempotencyKey({
        idempotencyKey,
        commentId: "comment-1",
        agentId: "agent-2",
      }),
    ).toBe(false);
  });
});
