import { describe, expect, it } from "vitest";
import { shouldWakeAssigneeForIssueComment } from "./issue-comment-wakeup.js";

describe("shouldWakeAssigneeForIssueComment", () => {
  it("does not wake on a comment that marks a running task blocked", () => {
    const input = { selfComment: false, resumeRequested: false, issueAtCommentStart: { status: "in_progress" }, reopened: false, currentStatus: "blocked" };
    expect(shouldWakeAssigneeForIssueComment(input)).toBe(false);
    expect(shouldWakeAssigneeForIssueComment({ ...input, resumeRequested: true })).toBe(true);
    expect(shouldWakeAssigneeForIssueComment({ ...input, issueAtCommentStart: { status: "blocked" } })).toBe(true);
  });

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
});
