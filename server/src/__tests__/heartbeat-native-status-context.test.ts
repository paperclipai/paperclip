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

describe("child completion wake context provenance", () => {
  const childCompletion = {
    issueId: "issue-1",
    taskId: "issue-1",
    source: "issue.children_completed",
    wakeReason: "issue_children_completed",
    completedChildIssueId: "child-1",
  };
  const checkedOutSlackContext = {
    issueId: "issue-1",
    source: "chat:slack",
    wakeReason: "External chat message received",
    wakeCommentIds: ["comment-1"],
    paperclipHarnessCheckedOut: true,
    paperclipWake: {
      issue: { id: "issue-1", status: "in_progress" },
      commentIds: ["comment-1"],
      externalChatProvider: "slack",
      externalChatExecutionBound: false,
      checkedOutByHarness: true,
    },
  };
  const executionBoundContext = {
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

  it("preserves a verified chat source when a same-issue child completion coalesces into the run", () => {
    const merged = mergeCoalescedContextSnapshot(
      {
        issueId: "issue-1",
        source: "chat:slack",
        wakeCommentId: "comment-1",
        wakeCommentIds: ["comment-1"],
      },
      childCompletion,
    );

    expect(merged).toMatchObject({
      source: "chat:slack",
      wakeReason: "issue_children_completed",
      completedChildIssueId: "child-1",
      wakeCommentId: "comment-1",
      wakeCommentIds: ["comment-1"],
    });
  });

  it("retains the exact harness checked-out chat wake when a same-issue child completion coalesces", () => {
    const merged = mergeCoalescedContextSnapshot(
      checkedOutSlackContext,
      childCompletion,
    );
    expect(merged).toMatchObject(checkedOutSlackContext);
    expect(merged.completedChildIssueId).toBe("child-1");
    expect(merged.paperclipWake).toBe(checkedOutSlackContext.paperclipWake);
    expect(merged.paperclipExternalChatExecutionBound).toBeUndefined();
  });

  it("retains the exact execution-bound chat wake when a same-issue child completion coalesces", () => {
    const merged = mergeCoalescedContextSnapshot(
      executionBoundContext,
      childCompletion,
    );
    expect(merged).toMatchObject(executionBoundContext);
    expect(merged.completedChildIssueId).toBe("child-1");
    expect(merged.paperclipWake).toBe(executionBoundContext.paperclipWake);
  });

  it.each([checkedOutSlackContext, executionBoundContext])(
    "invalidates the admitted chat wake when a child completion brings new wake comments: %j",
    (existing) => {
      const merged = mergeCoalescedContextSnapshot(existing, {
        ...childCompletion,
        wakeCommentIds: ["new-comment"],
      });
      expect(merged.paperclipWake).toBeUndefined();
      expect(merged.paperclipExternalChatExecutionBound).toBeUndefined();
      expect(merged.wakeReason).toBe("issue_children_completed");
      expect(merged.wakeCommentIds).toEqual(["comment-1", "new-comment"]);
    },
  );

  it.each([
    {
      ...childCompletion,
      issueId: "unrelated-issue",
      taskId: "unrelated-issue",
    },
    { ...childCompletion, wakeReason: "issue_commented" },
  ])(
    "does not preserve chat provenance for a child completion outside the admitted scope: %j",
    (incoming) => {
      const merged = mergeCoalescedContextSnapshot(
        checkedOutSlackContext,
        incoming,
      );
      expect(merged.source).toBe("issue.children_completed");
      expect(merged.paperclipWake).toBeUndefined();
    },
  );
});
