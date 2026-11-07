import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_MAX_REVIEW_HANDOFF_ATTEMPTS,
  EXECUTION_APPROVAL_REQUESTED_REASON,
  EXECUTION_REVIEW_REQUESTED_REASON,
  buildReviewHandoffRetryIdempotencyKey,
  buildReviewHandoffRetryIdempotencyKeyPrefix,
  decideReviewHandoffRetry,
  getPendingReviewStageTarget,
  isReviewHandoffRetryIdempotencyConflict,
} from "./review-handoff-retry.js";
import type { parseIssueExecutionState } from "../issue-execution-policy.js";

type ParsedExecutionState = NonNullable<ReturnType<typeof parseIssueExecutionState>>;

describe("review handoff retry", () => {
  const stageReviewId = randomUUID();
  const stageApprovalId = randomUUID();
  const reviewerAgentId = randomUUID();
  const workerAgentId = randomUUID();

  const pendingReviewState: ParsedExecutionState = {
    status: "pending",
    currentStageId: stageReviewId,
    currentStageIndex: 0,
    currentStageType: "review",
    currentParticipant: { type: "agent", agentId: reviewerAgentId, userId: null },
    returnAssignee: { type: "agent", agentId: workerAgentId, userId: null },
    reviewRequest: null,
    lastDecisionId: null,
    lastDecisionOutcome: null,
    completedStageIds: [],
    changesRequestedCount: 0,
  };

  const pendingApprovalState: ParsedExecutionState = {
    ...pendingReviewState,
    currentStageId: stageApprovalId,
    currentStageType: "approval",
  };

  it("keys every attempt of one issue and stage under one durable prefix", () => {
    const prefix = buildReviewHandoffRetryIdempotencyKeyPrefix({
      issueId: "issue-123",
      stageId: "stage-456",
    });
    expect(prefix).toBe("review-handoff:issue-123:stage-456:");
    expect(
      buildReviewHandoffRetryIdempotencyKey({
        issueId: "issue-123",
        stageId: "stage-456",
        attempt: 1,
      }),
    ).toBe("review-handoff:issue-123:stage-456:1");
    expect(
      buildReviewHandoffRetryIdempotencyKey({
        issueId: "issue-123",
        stageId: "stage-456",
        attempt: 2,
      }),
    ).toBe("review-handoff:issue-123:stage-456:2");
  });

  it("recognizes only the review handoff idempotency index as the coalesce signal", () => {
    const conflict = Object.assign(new Error("Failed query: insert into ..."), {
      cause: Object.assign(new Error("duplicate key value violates unique constraint"), {
        code: "23505",
        constraint_name: "agent_wakeup_requests_review_handoff_retry_idempotency_uq",
      }),
    });
    expect(isReviewHandoffRetryIdempotencyConflict(conflict)).toBe(true);

    const otherIndex = Object.assign(new Error("Failed query: insert into ..."), {
      cause: Object.assign(new Error("duplicate key value violates unique constraint"), {
        code: "23505",
        constraint_name: "agent_wakeup_requests_review_path_recovery_idempotency_uq",
      }),
    });
    expect(isReviewHandoffRetryIdempotencyConflict(otherIndex)).toBe(false);
    expect(isReviewHandoffRetryIdempotencyConflict(new Error("connection reset"))).toBe(false);
  });

  it("extracts pending review stage target only for eligible in_review issues", () => {
    expect(
      getPendingReviewStageTarget({
        status: "in_progress",
        executionState: pendingReviewState,
      }),
    ).toBeNull();

    expect(
      getPendingReviewStageTarget({
        status: "in_review",
        executionState: { ...pendingReviewState, status: "completed" },
      }),
    ).toBeNull();

    expect(
      getPendingReviewStageTarget({
        status: "in_review",
        executionState: { ...pendingReviewState, currentParticipant: { type: "user", userId: "user-1", agentId: null } },
      }),
    ).toBeNull();

    const target = getPendingReviewStageTarget({
      status: "in_review",
      executionState: pendingReviewState,
    });
    expect(target).toEqual({
      stageId: stageReviewId,
      stageType: "review",
      reviewerAgentId,
      executionState: pendingReviewState,
    });
  });

  it("skips when target is missing", () => {
    const decision = decideReviewHandoffRetry({
      target: null,
      issue: { id: "issue-1", companyId: "comp-1" },
      hasBlocker: false,
      blockerReason: null,
      hasActiveRun: false,
      hasQueuedWake: false,
      attemptCount: 0,
    });
    expect(decision).toEqual({
      kind: "skip",
      reason: "issue is not in_review with a pending agent review stage",
    });
  });

  it("skips when a valid blocker is present", () => {
    const target = getPendingReviewStageTarget({
      status: "in_review",
      executionState: pendingReviewState,
    });
    const decision = decideReviewHandoffRetry({
      target,
      issue: { id: "issue-1", companyId: "comp-1" },
      hasBlocker: true,
      blockerReason: "unresolved_dependency:blocker-99",
      hasActiveRun: false,
      hasQueuedWake: false,
      attemptCount: 0,
    });
    expect(decision).toEqual({
      kind: "skip",
      reason: "issue has valid blocker: unresolved_dependency:blocker-99",
    });
  });

  it("skips when an active review run is already running or queued", () => {
    const target = getPendingReviewStageTarget({
      status: "in_review",
      executionState: pendingReviewState,
    });
    const decision = decideReviewHandoffRetry({
      target,
      issue: { id: "issue-1", companyId: "comp-1" },
      hasBlocker: false,
      blockerReason: null,
      hasActiveRun: true,
      hasQueuedWake: false,
      attemptCount: 0,
    });
    expect(decision).toEqual({
      kind: "skip",
      reason: "active review run already exists",
    });
  });

  it("skips when a durable review retry is already queued", () => {
    const target = getPendingReviewStageTarget({
      status: "in_review",
      executionState: pendingReviewState,
    });
    const decision = decideReviewHandoffRetry({
      target,
      issue: { id: "issue-1", companyId: "comp-1" },
      hasBlocker: false,
      blockerReason: null,
      hasActiveRun: false,
      hasQueuedWake: true,
      attemptCount: 0,
    });
    expect(decision).toEqual({
      kind: "skip",
      reason: "durable review retry already queued",
    });
  });

  it("enqueues a review handoff retry with the correct payload and idempotency key", () => {
    const target = getPendingReviewStageTarget({
      status: "in_review",
      executionState: pendingReviewState,
    });
    const decision = decideReviewHandoffRetry({
      target,
      issue: { id: "issue-1", companyId: "comp-1" },
      hasBlocker: false,
      blockerReason: null,
      hasActiveRun: false,
      hasQueuedWake: false,
      attemptCount: 0,
    });

    expect(decision).toMatchObject({
      kind: "enqueue",
      targetAgentId: reviewerAgentId,
      idempotencyKey: `review-handoff:issue-1:${stageReviewId}:1`,
      reason: EXECUTION_REVIEW_REQUESTED_REASON,
      attempt: 1,
      maxAttempts: DEFAULT_MAX_REVIEW_HANDOFF_ATTEMPTS,
      payload: {
        issueId: "issue-1",
        mutation: "update",
        reviewHandoffAttempt: 1,
        maxReviewHandoffAttempts: DEFAULT_MAX_REVIEW_HANDOFF_ATTEMPTS,
        executionStage: {
          wakeRole: "reviewer",
          stageId: stageReviewId,
          stageType: "review",
          currentParticipant: { type: "agent", agentId: reviewerAgentId, userId: null },
        },
      },
      contextSnapshot: {
        issueId: "issue-1",
        taskId: "issue-1",
        wakeReason: EXECUTION_REVIEW_REQUESTED_REASON,
        source: "issue.review_handoff_retry",
        currentStageId: stageReviewId,
        reviewHandoffAttempt: 1,
      },
    });
  });

  it("enqueues an approval handoff retry with the correct approval reason and wake role", () => {
    const target = getPendingReviewStageTarget({
      status: "in_review",
      executionState: pendingApprovalState,
    });
    const decision = decideReviewHandoffRetry({
      target,
      issue: { id: "issue-2", companyId: "comp-1" },
      hasBlocker: false,
      blockerReason: null,
      hasActiveRun: false,
      hasQueuedWake: false,
      attemptCount: 1,
    });

    expect(decision).toMatchObject({
      kind: "enqueue",
      targetAgentId: reviewerAgentId,
      idempotencyKey: `review-handoff:issue-2:${stageApprovalId}:2`,
      reason: EXECUTION_APPROVAL_REQUESTED_REASON,
      attempt: 2,
      payload: {
        executionStage: {
          wakeRole: "approver",
          stageId: stageApprovalId,
          stageType: "approval",
        },
      },
    });
  });

  it("returns exhausted when attemptCount reaches maxAttempts", () => {
    const target = getPendingReviewStageTarget({
      status: "in_review",
      executionState: pendingReviewState,
    });
    const decision = decideReviewHandoffRetry({
      target,
      issue: { id: "issue-1", companyId: "comp-1" },
      hasBlocker: false,
      blockerReason: null,
      hasActiveRun: false,
      hasQueuedWake: false,
      attemptCount: 3,
      maxAttempts: 3,
    });

    expect(decision).toEqual({
      kind: "exhausted",
      reason: "review handoff retries exhausted (3/3)",
      stageId: stageReviewId,
      stageType: "review",
      reviewerAgentId,
      attemptsUsed: 3,
      maxAttempts: 3,
    });
  });
});
