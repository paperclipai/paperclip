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
