import { describe, expect, it } from "vitest";
import { mergeCoalescedContextSnapshot } from "../services/heartbeat.ts";

describe("native status wake context provenance", () => {
  it("preserves a verified chat source when status control flow coalesces into the run", () => {
    const merged = mergeCoalescedContextSnapshot(
      {
        issueId: "issue-1",
        source: "chat:discord",
        wakeCommentId: "comment-1",
        wakeCommentIds: ["comment-1"],
      },
      {
        issueId: "issue-1",
        source: "native_status_decision",
        statusDecisionSource: "native_status_decision",
        wakeReason: "issue_status_changed",
      },
    );

    expect(merged).toMatchObject({
      source: "chat:discord",
      statusDecisionSource: "native_status_decision",
      wakeReason: "issue_status_changed",
      wakeCommentId: "comment-1",
      wakeCommentIds: ["comment-1"],
    });
  });

  it("does not preserve chat provenance for an unmarked ordinary incoming wake", () => {
    const merged = mergeCoalescedContextSnapshot(
      { source: "chat:discord" },
      { source: "native_status_decision" },
    );

    expect(merged.source).toBe("native_status_decision");
    expect(merged.statusDecisionSource).toBeUndefined();
  });

  const reviewedContext = {
    issueId: "issue-1",
    source: "chat:telegram",
    wakeReason: "External chat message received",
    wakeCommentIds: ["comment-1"],
    paperclipExternalChatExecutionBound: true,
    paperclipWake: {
      issue: { id: "issue-1", status: "in_review" },
      commentIds: ["comment-1"],
      externalChatProvider: "telegram",
      externalChatExecutionBound: true,
      checkedOutByHarness: false,
    },
  };
  const statusControl = {
    issueId: "issue-1",
    source: "native_status_decision",
    statusDecisionSource: "native_status_decision",
    wakeReason: "issue_status_changed",
  };

  it("retains the exact admitted review-chat wake when same-issue status metadata coalesces", () => {
    const merged = mergeCoalescedContextSnapshot(
      reviewedContext,
      statusControl,
    );
    expect(merged).toMatchObject(reviewedContext);
    expect(merged.statusDecisionSource).toBe("native_status_decision");
    expect(merged.paperclipWake).toBe(reviewedContext.paperclipWake);
    expect(merged.paperclipHarnessCheckedOut).toBeUndefined();
  });

  it("also retains the exact legacy checked-out chat wake for pure status control", () => {
    const checkedOut = {
      ...reviewedContext,
      paperclipExternalChatExecutionBound: false,
      paperclipHarnessCheckedOut: true,
      paperclipWake: {
        ...reviewedContext.paperclipWake,
        checkedOutByHarness: true,
        externalChatExecutionBound: false,
      },
    };
    const merged = mergeCoalescedContextSnapshot(checkedOut, statusControl);
    expect(merged.paperclipWake).toBe(checkedOut.paperclipWake);
    expect(merged.paperclipExternalChatExecutionBound).toBeUndefined();
  });

  it.each([
    { ...statusControl, issueId: "unrelated-issue" },
    { ...statusControl, wakeCommentIds: ["new-comment"] },
    { ...statusControl, statusDecisionSource: "ordinary-control" },
    { issueId: "issue-1", source: "chat:discord" },
  ])(
    "invalidates prior review binding when coalescence changes admitted scope: %j",
    (incoming) => {
      const merged = mergeCoalescedContextSnapshot(reviewedContext, incoming);
      expect(merged.paperclipExternalChatExecutionBound).toBeUndefined();
      expect(merged.paperclipWake).toBeUndefined();
    },
  );

  it("does not preserve mismatched provider or payload-comment provenance", () => {
    for (const paperclipWake of [
      { ...reviewedContext.paperclipWake, externalChatProvider: "github" },
      { ...reviewedContext.paperclipWake, commentIds: ["different-comment"] },
      { ...reviewedContext.paperclipWake, externalChatExecutionBound: false },
    ]) {
      const merged = mergeCoalescedContextSnapshot(
        { ...reviewedContext, paperclipWake },
        statusControl,
      );
      expect(merged.paperclipExternalChatExecutionBound).toBeUndefined();
      expect(merged.paperclipWake).toBeUndefined();
    }
  });

  it("never adopts an attestation supplied only by an incoming wake", () => {
    const merged = mergeCoalescedContextSnapshot({}, reviewedContext);
    expect(merged.paperclipExternalChatExecutionBound).toBeUndefined();
    expect(merged.paperclipWake).toBeUndefined();
  });
});
