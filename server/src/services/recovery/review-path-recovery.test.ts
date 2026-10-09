import { describe, expect, it } from "vitest";
import {
  ISSUE_REVIEW_PATH_LOST_WAKE_REASON,
  buildIssueReviewPathLostIdempotencyKey,
  decideIssueReviewPathRecovery,
  isReviewPathRecoveryIdempotencyConflict,
} from "./review-path-recovery.js";

const stalled = {
  state: "stalled" as const,
  paths: [],
  reason: "in_review issue has no participant, interaction, approval, monitor, active run, queued wake, or recovery path",
};

describe("review-path recovery", () => {
  it("queues one bounded recovery wake fingerprinted to the consumed path", () => {
    const first = decideIssueReviewPathRecovery({
      issueId: "issue-1",
      sourceRunId: "run-1",
      assigneeAgentId: "agent-1",
      contextSnapshot: {
        wakeReason: "issue_commented",
        reviewPathConsumedRef: "interaction-1",
      },
      reviewAttention: stalled,
      existingWake: false,
    });

    expect(first).toMatchObject({
      kind: "enqueue",
      idempotencyKey: buildIssueReviewPathLostIdempotencyKey({
        issueId: "issue-1",
        consumedPathRef: "interaction-1",
      }),
      payload: {
        issueId: "issue-1",
        sourceRunId: "run-1",
        reviewPathLost: true,
        reviewPathConsumedRef: "interaction-1",
        reviewPathRecoveryAttempt: 1,
        maxReviewPathRecoveryAttempts: 1,
      },
      contextSnapshot: {
        wakeReason: ISSUE_REVIEW_PATH_LOST_WAKE_REASON,
        reviewPathRecoveryAttempt: 1,
      },
    });

    const duplicate = decideIssueReviewPathRecovery({
      issueId: "issue-1",
      sourceRunId: "run-1",
      assigneeAgentId: "agent-1",
      contextSnapshot: { reviewPathConsumedRef: "interaction-1" },
      reviewAttention: stalled,
      existingWake: true,
    });
    expect(duplicate).toEqual({ kind: "skip", reason: "review-path recovery wake already exists" });
  });

  it.each(["chat:slack", "chat:slack:recovery", "chat:discord"])(
    "retains the admitted message batch for %s without inheriting authorization",
    (source) => {
      const decision = decideIssueReviewPathRecovery({
        issueId: "issue-1",
        sourceRunId: "run-1",
        assigneeAgentId: "agent-1",
        contextSnapshot: {
          issueId: "issue-1",
          source,
          wakeCommentIds: ["comment-1", "comment-2", "comment-1"],
          wakeCommentId: "stale-comment",
          commentId: "stale-comment",
          paperclipHarnessCheckedOut: true,
          paperclipExternalChatExecutionBound: true,
          paperclipWake: { checkedOutByHarness: true },
          sessionId: "old-session",
          instruction: "old instruction",
        },
        reviewAttention: stalled,
        existingWake: false,
      });
      expect(decision.kind).toBe("enqueue");
      if (decision.kind !== "enqueue") return;
      expect(decision.contextSnapshot).toMatchObject({
        issueId: "issue-1",
        source,
        wakeReason: ISSUE_REVIEW_PATH_LOST_WAKE_REASON,
        wakeCommentIds: ["comment-1", "comment-2"],
        wakeCommentId: "comment-2",
        commentId: "comment-2",
      });
      for (const key of [
        "paperclipHarnessCheckedOut",
        "paperclipExternalChatExecutionBound",
        "paperclipWake",
        "sessionId",
      ]) expect(decision.contextSnapshot).not.toHaveProperty(key);
      expect(decision.contextSnapshot.instruction).not.toBe("old instruction");
    },
  );

  it.each([undefined, null, "comment-1", [], [null, 1, " "]])(
    "does not invent an admitted message batch from invalid input %j",
    (wakeCommentIds) => {
      const decision = decideIssueReviewPathRecovery({
        issueId: "issue-1",
        sourceRunId: "run-1",
        assigneeAgentId: "agent-1",
        contextSnapshot: {
          source: "chat:slack",
          wakeCommentIds,
          wakeCommentId: "unproven-comment",
        },
        reviewAttention: stalled,
        existingWake: false,
      });
      expect(decision.kind).toBe("enqueue");
      if (decision.kind !== "enqueue") return;
      expect(decision.contextSnapshot.source).toBe("chat:slack");
      expect(decision.contextSnapshot).not.toHaveProperty("wakeCommentIds");
      expect(decision.contextSnapshot).not.toHaveProperty("wakeCommentId");
    },
  );

  it.each(["issue.comment", "chat:agentmail", "chat:agentmail:recovery"])(
    "does not carry a chat batch for unsupported source %s",
    (source) => {
      const decision = decideIssueReviewPathRecovery({
        issueId: "issue-1",
        sourceRunId: "run-1",
        assigneeAgentId: "agent-1",
        contextSnapshot: { source, wakeCommentIds: ["comment-1"] },
        reviewAttention: stalled,
        existingWake: false,
      });
      expect(decision.kind).toBe("enqueue");
      if (decision.kind !== "enqueue") return;
      expect(decision.contextSnapshot).not.toHaveProperty("wakeCommentIds");
    },
  );

  it("does not requeue when the bounded recovery run also ends pathless", () => {
    const decision = decideIssueReviewPathRecovery({
      issueId: "issue-1",
      sourceRunId: "run-2",
      assigneeAgentId: "agent-1",
      contextSnapshot: {
        wakeReason: ISSUE_REVIEW_PATH_LOST_WAKE_REASON,
        reviewPathRecoveryAttempt: 1,
      },
      reviewAttention: stalled,
      existingWake: false,
    });

    expect(decision).toEqual({ kind: "skip", reason: "bounded review-path recovery already ran" });
  });

  it("never wakes a healthy review", () => {
    const decision = decideIssueReviewPathRecovery({
      issueId: "issue-1",
      sourceRunId: "run-1",
      assigneeAgentId: "agent-1",
      contextSnapshot: { reviewPathConsumedRef: "interaction-1" },
      reviewAttention: {
        state: "covered",
        paths: [{
          kind: "interaction",
          label: "Pending request confirmation",
          responder: "Board",
          since: null,
          ref: "interaction-2",
        }],
        reason: "Review is covered by 1 maintained path.",
      },
      existingWake: false,
    });

    expect(decision).toEqual({ kind: "skip", reason: "review issue still has a maintained path" });
  });

  it("recognizes wrapped atomic deduplication conflicts without swallowing unrelated uniqueness errors", () => {
    expect(isReviewPathRecoveryIdempotencyConflict({
      cause: {
        code: "23505",
        constraint_name: "agent_wakeup_requests_review_path_recovery_idempotency_uq",
      },
    })).toBe(true);
    expect(isReviewPathRecoveryIdempotencyConflict({
      code: "23505",
      constraint_name: "some_other_unique_index",
    })).toBe(false);
  });
});
