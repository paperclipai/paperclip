import { describe, expect, it } from "vitest";
import { isNoWakeComment, shouldWakeAssigneeForIssueComment } from "./issue-comment-wakeup.js";

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
});

describe("no-wake comment marker", () => {
  const base = {
    selfComment: false,
    resumeRequested: false,
    commentCreatedByRunId: null,
    issueAtCommentStart: { checkoutRunId: null, executionRunId: null },
    reopened: false,
    currentStatus: "blocked",
  };

  it("recognises the marker only at the start of the body", () => {
    expect(isNoWakeComment("[no-wake] status: still waiting on CI")).toBe(true);
    expect(isNoWakeComment("  \n[No-Wake] note")).toBe(true);
    expect(isNoWakeComment("please act; [no-wake] later")).toBe(false);
    expect(isNoWakeComment("")).toBe(false);
    expect(isNoWakeComment(undefined)).toBe(false);
  });

  it("does not wake the assignee for a no-wake comment", () => {
    expect(shouldWakeAssigneeForIssueComment({ ...base, noWake: true })).toBe(false);
    expect(shouldWakeAssigneeForIssueComment({ ...base, noWake: false })).toBe(true);
  });

  it("lets an explicit resume or reopen override the marker", () => {
    expect(shouldWakeAssigneeForIssueComment({ ...base, noWake: true, resumeRequested: true })).toBe(true);
    expect(shouldWakeAssigneeForIssueComment({ ...base, noWake: true, reopened: true })).toBe(true);
  });
});
