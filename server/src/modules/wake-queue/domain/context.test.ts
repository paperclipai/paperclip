import { describe, expect, it } from "vitest";
import { enrichPromotedWakeContext } from "./context.js";

describe("enrichPromotedWakeContext", () => {
  it("clears stale derived comment projections when the canonical id list is empty, but keeps an independent interaction continuation", () => {
    const contextSnapshot: Record<string, unknown> = {
      // Normalization already dropped the canonical wake comment ids upstream
      // of this function; no wakeCommentIds field remains on the snapshot.
      paperclipWake: { commentId: "comment-2" },
      paperclipWakeComment: { id: "comment-2", body: "stale body" },
      paperclipTaskMarkdown: "stale markdown",
      paperclipTaskMarkdownCompact: "stale compact markdown",
      // Independent interaction continuation the promoted run must keep.
      interactionId: "interaction-1",
      interactionKind: "request_confirmation",
      interactionStatus: "accepted",
    };

    const result = enrichPromotedWakeContext({
      contextSnapshot,
      reason: "issue_execution_promoted",
      source: "automation",
      triggerDetail: null,
      payload: { mutation: "interaction" },
    });

    expect(result.contextSnapshot.wakeCommentIds).toBeUndefined();
    expect(result.contextSnapshot.commentId).toBeUndefined();
    expect(result.contextSnapshot.wakeCommentId).toBeUndefined();
    expect(result.contextSnapshot.paperclipWake).toBeUndefined();
    expect(result.contextSnapshot.paperclipWakeComment).toBeUndefined();
    expect(result.contextSnapshot.paperclipTaskMarkdown).toBeUndefined();
    expect(result.contextSnapshot.paperclipTaskMarkdownCompact).toBeUndefined();
    // The independent interaction continuation survives the clear.
    expect(result.contextSnapshot.interactionId).toBe("interaction-1");
    expect(result.contextSnapshot.interactionStatus).toBe("accepted");
  });

  it("sets the canonical id and latest-id fields when the recomputed list has entries, and still clears the stale projections", () => {
    const contextSnapshot: Record<string, unknown> = {
      wakeCommentIds: ["comment-1"],
      paperclipWake: { commentId: "comment-1" },
      paperclipWakeComment: { id: "comment-1", body: "will be rebuilt" },
      paperclipTaskMarkdown: "will be rebuilt",
      paperclipTaskMarkdownCompact: "will be rebuilt",
    };

    const result = enrichPromotedWakeContext({
      contextSnapshot,
      reason: "issue_execution_promoted",
      source: "automation",
      triggerDetail: null,
      payload: {},
    });

    expect(result.contextSnapshot.wakeCommentIds).toEqual(["comment-1"]);
    expect(result.contextSnapshot.commentId).toBe("comment-1");
    expect(result.contextSnapshot.wakeCommentId).toBe("comment-1");
    // The derived projections are cleared so the run rebuilds them from the
    // canonical ids instead of carrying forward a queue-time snapshot.
    expect(result.contextSnapshot.paperclipWake).toBeUndefined();
    expect(result.contextSnapshot.paperclipWakeComment).toBeUndefined();
    expect(result.contextSnapshot.paperclipTaskMarkdown).toBeUndefined();
    expect(result.contextSnapshot.paperclipTaskMarkdownCompact).toBeUndefined();
  });

  it("adds a new id from the payload to the canonical list and clears the stale projections", () => {
    const contextSnapshot: Record<string, unknown> = {
      wakeCommentIds: ["comment-1"],
      paperclipWakeComment: { id: "comment-1", body: "stale body" },
    };

    const result = enrichPromotedWakeContext({
      contextSnapshot,
      reason: "issue_execution_promoted",
      source: "automation",
      triggerDetail: null,
      payload: { commentId: "comment-2" },
    });

    expect(result.contextSnapshot.wakeCommentIds).toEqual(["comment-1", "comment-2"]);
    expect(result.contextSnapshot.commentId).toBe("comment-2");
    expect(result.contextSnapshot.wakeCommentId).toBe("comment-2");
    expect(result.contextSnapshot.paperclipWakeComment).toBeUndefined();
  });
});
