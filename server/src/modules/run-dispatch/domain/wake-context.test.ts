import { describe, expect, it } from "vitest";
import {
  allowsIssueInteractionWake,
  deriveCommentId,
  extractWakeCommentIds,
  isNonAssigneeWorkspaceBusyRetry,
  isResolvedInteractionContinuationWakeContext,
  readPendingInteractionWakeId,
  WORKSPACE_BUSY_RETRY_REASON,
} from "./wake-context.js";

describe("wake context", () => {
  it("recognizes a retired available connection without accepting ordinary expiry", () => {
    const context = { interactionId: "connection", interactionStatus: "expired", interactionKind: "connection_intent",
      connectionIntentResolution: "existing_connection", mutation: "interaction", wakeReason: "issue_commented" };
    expect(isResolvedInteractionContinuationWakeContext(context)).toBe(true);
    expect(isResolvedInteractionContinuationWakeContext({ ...context, interactionKind: "request_confirmation" })).toBe(false);
    expect(isResolvedInteractionContinuationWakeContext({ ...context, connectionIntentResolution: undefined })).toBe(false);
  });
  it("requires the subscription-specific non-assignee receipt for a subscription wait", () => {
    expect(isNonAssigneeWorkspaceBusyRetry("ai_connection_busy", {
      aiConnectionBusyDeferredWhileAssignee: false,
    })).toBe(true);
    for (const context of [ {}, { aiConnectionBusyDeferredWhileAssignee: true }, { workspaceBusyDeferredWhileAssignee: false } ]) {
      expect(isNonAssigneeWorkspaceBusyRetry("ai_connection_busy", context)).toBe(false);
    }
    expect(isNonAssigneeWorkspaceBusyRetry("transient_failure", { aiConnectionBusyDeferredWhileAssignee: false })).toBe(false);
  });
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

  it("reads the interaction id only from a pending-card wake snapshot", () => {
    expect(readPendingInteractionWakeId({
      wakeReason: "interaction_pending",
      interactionId: "interaction-1",
    })).toBe("interaction-1");
    expect(readPendingInteractionWakeId({
      wakeReason: "issue_commented",
      interactionId: "interaction-1",
    })).toBeNull();
    expect(readPendingInteractionWakeId({ wakeReason: "interaction_pending" })).toBeNull();
    expect(readPendingInteractionWakeId({
      wakeReason: "interaction_pending",
      interactionId: "  ",
    })).toBeNull();
    expect(readPendingInteractionWakeId(null)).toBeNull();
  });

  it("keeps the pending-card identity across a bounded retry", () => {
    expect(readPendingInteractionWakeId({
      wakeReason: "transient_failure_retry",
      retryReason: "transient_failure",
      originalWakeReason: "interaction_pending",
      interactionId: "interaction-1",
    })).toBe("interaction-1");
    expect(readPendingInteractionWakeId({
      wakeReason: "transient_failure_retry",
      originalWakeReason: "issue_commented",
      interactionId: "interaction-1",
    })).toBeNull();
    expect(readPendingInteractionWakeId({
      wakeReason: "transient_failure_retry",
      originalWakeReason: "interaction_pending",
    })).toBeNull();
  });

  it.each(["accepted", "answered", "cancelled", "rejected"])(
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

  it.each(["accepted", "answered", "cancelled", "rejected"])(
    "recognizes %s infrastructure continuations and rejects incomplete contexts",
    (interactionStatus) => {
      const base = { interactionId: "interaction-1", interactionStatus };
      expect(isResolvedInteractionContinuationWakeContext({
        ...base,
        wakeReason: "interaction_continuation_infra_retry",
      })).toBe(true);
      expect(isResolvedInteractionContinuationWakeContext({
        ...base,
        retryReason: "interaction_continuation_infra_retry",
      })).toBe(true);
      expect(isResolvedInteractionContinuationWakeContext({ ...base, interactionStatus: "pending" })).toBe(false);
      expect(isResolvedInteractionContinuationWakeContext({ interactionStatus })).toBe(false);
      expect(isResolvedInteractionContinuationWakeContext(null)).toBe(false);
    },
  );
});

 it("preserves non-assignee pool wait authority", () => {
   expect(isNonAssigneeWorkspaceBusyRetry("ai_connection_pool_wait", { aiConnectionBusyDeferredWhileAssignee: false })).toBe(true);
   expect(isNonAssigneeWorkspaceBusyRetry("ai_connection_pool_wait", { aiConnectionBusyDeferredWhileAssignee: true })).toBe(false);
 });
