import { describe, expect, it } from "vitest";
import {
  buildScheduledRetryTerminalSuppression,
  shouldAllowTerminalQueuedRunWake,
  shouldPromoteDeferredCommentWakeForTerminalIssue,
} from "../services/heartbeat.js";

describe("heartbeat terminal issue wake/retry gates", () => {
  it("does not allow a plain comment wake to start a queued run for done/cancelled issues", () => {
    expect(shouldAllowTerminalQueuedRunWake({
      issueStatus: "done",
      contextSnapshot: { wakeCommentId: "comment-1", wakeReason: "issue_commented" },
    })).toBe(false);

    expect(shouldAllowTerminalQueuedRunWake({
      issueStatus: "cancelled",
      contextSnapshot: { wakeCommentId: "comment-1", wakeReason: "issue_commented" },
    })).toBe(false);
  });

  it("allows terminal issue wakes only when explicit reopen/follow-up intent is present", () => {
    expect(shouldAllowTerminalQueuedRunWake({
      issueStatus: "done",
      contextSnapshot: { wakeCommentId: "comment-1", explicitReopenIntent: true },
    })).toBe(true);

    expect(shouldAllowTerminalQueuedRunWake({
      issueStatus: "cancelled",
      contextSnapshot: { wakeCommentId: "comment-1" },
      payload: { followUpRequested: true },
    })).toBe(true);
  });

  it("does not promote deferred terminal comment wakes without explicit reopen intent", () => {
    expect(shouldPromoteDeferredCommentWakeForTerminalIssue({
      issueStatus: "done",
      contextSnapshot: { wakeCommentId: "comment-1", wakeReason: "issue_commented" },
      payload: { commentId: "comment-1" },
      requestedByActorType: "user",
    })).toBe(false);

    expect(shouldPromoteDeferredCommentWakeForTerminalIssue({
      issueStatus: "done",
      contextSnapshot: { wakeCommentId: "comment-1", wakeReason: "issue_reopened_via_comment" },
      payload: { commentId: "comment-1", explicitReopenIntent: true },
      requestedByActorType: "user",
    })).toBe(true);
  });

  it("suppresses scheduled retries before scheduling/starting when an issue is terminal", () => {
    expect(buildScheduledRetryTerminalSuppression({ issueStatus: "done", issueId: "issue-1" })).toEqual({
      allowed: false,
      reason: "Scheduled retry suppressed because issue reached terminal status (done)",
      errorCode: "issue_terminal_status",
      issueId: "issue-1",
      details: { issueId: "issue-1", currentStatus: "done" },
    });

    expect(buildScheduledRetryTerminalSuppression({ issueStatus: "cancelled", issueId: "issue-1" })).toEqual({
      allowed: false,
      reason: "Scheduled retry suppressed because issue reached terminal status (cancelled)",
      errorCode: "issue_cancelled",
      issueId: "issue-1",
      details: { issueId: "issue-1", currentStatus: "cancelled" },
    });

    expect(buildScheduledRetryTerminalSuppression({ issueStatus: "in_progress", issueId: "issue-1" })).toEqual({
      allowed: true,
    });
  });
});
