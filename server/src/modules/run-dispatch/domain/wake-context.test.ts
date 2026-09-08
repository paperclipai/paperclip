import { describe, expect, it } from "vitest";
import {
  allowsIssueInteractionWake,
  deriveCommentId,
  extractWakeCommentIds,
  isNonAssigneeWorkspaceBusyRetry,
  isResolvedInteractionContinuationWakeContext,
  WORKSPACE_BUSY_RETRY_REASON,
} from "./wake-context.js";

describe("wake context", () => {
  it("recognizes only workspace-busy retries deferred outside assignee-ship", () => {
    expect(isNonAssigneeWorkspaceBusyRetry(WORKSPACE_BUSY_RETRY_REASON, {
      workspaceBusyDeferredWhileAssignee: false,
    })).toBe(true);
    expect(isNonAssigneeWorkspaceBusyRetry(WORKSPACE_BUSY_RETRY_REASON, {
      workspaceBusyDeferredWhileAssignee: true,
    })).toBe(false);
    expect(isNonAssigneeWorkspaceBusyRetry("another_reason", {
      workspaceBusyDeferredWhileAssignee: false,
    })).toBe(false);
  });

  it("keeps ordered, unique, non-empty wake comment ids", () => {
    expect(extractWakeCommentIds({
      wakeCommentIds: ["comment-1", "", null, "comment-2", "comment-1"],
    })).toEqual(["comment-1", "comment-2"]);
    expect(extractWakeCommentIds({ wakeCommentIds: "comment-1" })).toEqual([]);
    expect(extractWakeCommentIds(undefined)).toEqual([]);
  });

  it.each([
    [{ wakeCommentIds: ["batch-1", "batch-2"], wakeCommentId: "wake" }, {}, "batch-2"],
    [{ wakeCommentId: "wake", commentId: "context" }, {}, "wake"],
    [{ commentId: "context" }, { commentId: "payload" }, "context"],
    [{}, { commentId: "payload" }, "payload"],
    [{ wakeCommentId: "  " }, { commentId: "  " }, null],
  ])("derives comment ids by canonical precedence", (context, payload, expected) => {
    expect(deriveCommentId(context, payload)).toBe(expected);
  });

  it("allows interaction wakes only for an allowed reason with a comment id", () => {
    const allowed = new Set(["issue_commented"]);
    expect(allowsIssueInteractionWake({
      wakeReason: "issue_commented",
      wakeCommentId: "comment-1",
    }, allowed)).toBe(true);
    expect(allowsIssueInteractionWake({
      wakeReason: "timer",
      wakeCommentId: "comment-1",
    }, allowed)).toBe(false);
    expect(allowsIssueInteractionWake({ wakeReason: "issue_commented" }, allowed)).toBe(false);
  });

  it.each(["accepted", "answered", "rejected"])(
    "recognizes %s issue-comment interaction continuations",
    (interactionStatus) => {
      expect(isResolvedInteractionContinuationWakeContext({
        interactionId: "interaction-1",
        interactionStatus,
        mutation: "interaction",
        wakeReason: "issue_commented",
      })).toBe(true);
    },
  );

  it("recognizes infrastructure continuations and rejects incomplete contexts", () => {
    const base = { interactionId: "interaction-1", interactionStatus: "accepted" };
    expect(isResolvedInteractionContinuationWakeContext({
      ...base,
      wakeReason: "interaction_continuation_infra_retry",
    })).toBe(true);
    expect(isResolvedInteractionContinuationWakeContext({
      ...base,
      retryReason: "interaction_continuation_infra_retry",
    })).toBe(true);
    expect(isResolvedInteractionContinuationWakeContext({ ...base, interactionStatus: "pending" })).toBe(false);
    expect(isResolvedInteractionContinuationWakeContext({ interactionStatus: "accepted" })).toBe(false);
    expect(isResolvedInteractionContinuationWakeContext(null)).toBe(false);
  });
});
