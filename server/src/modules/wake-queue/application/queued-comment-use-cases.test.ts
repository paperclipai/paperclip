import { describe, expect, it, vi } from "vitest";
import type { IssueComment } from "@paperclipai/shared";
import {
  createDiscardQueuedComment,
  createEditQueuedComment,
  createReorderQueuedComments,
  QueuedCommentMutationError,
  QueuedCommentMutationForbiddenError,
} from "./queued-comment-use-cases.js";
import type {
  LockedQueuedCommentState,
  QueuedCommentActivityPublication,
  QueuedCommentActor,
  QueuedCommentEntrySnapshot,
  QueuedCommentIssueContext,
  QueuedCommentIssueLockWriter,
  QueuedCommentQueueSnapshot,
  QueuedCommentQueueTransaction,
  QueuedCommentRunRow,
  QueuedCommentWakeRow,
} from "./queued-comment-ports.js";

const ISSUE: QueuedCommentIssueContext = {
  id: "issue-1",
  companyId: "company-1",
  assigneeAgentId: "agent-1",
  executionRunId: null,
};

const USER_ACTOR: QueuedCommentActor = {
  actorType: "user",
  actorId: "user-1",
  agentId: null,
  runId: null,
  agentApiKeyId: null,
};
const AGENT_ACTOR: QueuedCommentActor = {
  actorType: "agent",
  actorId: "agent-1",
  agentId: "agent-1",
  runId: "run-1",
  agentApiKeyId: "api-key-1",
};

function activityPublicationFixture(overrides: Partial<QueuedCommentActivityPublication> = {}): QueuedCommentActivityPublication {
  return { companyId: ISSUE.companyId, payload: {}, pluginEvent: null, ...overrides };
}

function wakeRow(overrides: Partial<QueuedCommentWakeRow> = {}): QueuedCommentWakeRow {
  return { id: "wake-1", agentId: "agent-1", status: "deferred_issue_execution", runId: null, payload: {}, ...overrides };
}

function runRow(overrides: Partial<QueuedCommentRunRow> = {}): QueuedCommentRunRow {
  return { id: "run-1", status: "queued", runtimeMode: null, contextSnapshot: {}, ...overrides };
}

function commentFixture(overrides: Partial<IssueComment> = {}): IssueComment {
  return {
    id: "comment-1",
    companyId: "company-1",
    issueId: "issue-1",
    authorType: "user",
    authorAgentId: null,
    authorUserId: "user-1",
    body: "queued comment",
    presentation: null,
    metadata: null,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  };
}

function entry(overrides: Partial<QueuedCommentEntrySnapshot> = {}): QueuedCommentEntrySnapshot {
  return {
    comment: commentFixture(),
    position: 0,
    canEdit: true,
    canDiscard: true,
    ...overrides,
  };
}

function queueSnapshot(overrides: Partial<QueuedCommentQueueSnapshot> = {}): QueuedCommentQueueSnapshot {
  return {
    issueId: ISSUE.id,
    queueId: "wake-1",
    state: "deferred",
    targetRunId: null,
    revision: "rev-1",
    protocol: "legacy",
    steeringDisposition: "unsupported",
    entries: [entry()],
    ...overrides,
  };
}

function lockedState(overrides: Partial<LockedQueuedCommentState> = {}): LockedQueuedCommentState {
  return {
    wake: wakeRow(),
    state: "deferred",
    queueRun: null,
    activeRun: null,
    queue: queueSnapshot(),
    ...overrides,
  };
}

function createFakeTransaction(overrides: Partial<QueuedCommentQueueTransaction> = {}): QueuedCommentQueueTransaction {
  return {
    updateCommentBody: vi.fn(async () => true),
    touchIssueUpdatedAt: vi.fn(async () => {}),
    updateWakeQueuedCommentIds: vi.fn(async (input) => wakeRow({ id: input.wakeId })),
    updateQueueRunCommentIds: vi.fn(async (input) => runRow({ id: input.queueRunId })),
    deleteComment: vi.fn(async () => commentFixture()),
    cancelWake: vi.fn(async () => {}),
    cancelQueueRun: vi.fn(async () => ({ id: "run-1" })),
    clearExecutionLockAndTouchIssue: vi.fn(async () => {}),
    buildQueueSnapshot: vi.fn(async () => queueSnapshot()),
    syncCommentReferences: vi.fn(async () => {}),
    deleteCommentReferenceSource: vi.fn(async () => {}),
    syncCommentExternalObjectsSafely: vi.fn(async () => {}),
    logActivity: vi.fn(async () => activityPublicationFixture()),
    ...overrides,
  };
}

function createFakeIssueLock(locked: LockedQueuedCommentState, transaction: QueuedCommentQueueTransaction): QueuedCommentIssueLockWriter {
  return {
    withLockedQueue: vi.fn(async (_input, fn) => fn(locked, transaction)),
  };
}

describe("editQueuedComment", () => {
  it("updates the comment body and rebuilds the queue snapshot", async () => {
    const locked = lockedState();
    const transaction = createFakeTransaction();
    const issueLock = createFakeIssueLock(locked, transaction);
    const editQueuedComment = createEditQueuedComment({ issueLock });

    const result = await editQueuedComment({
      issue: ISSUE,
      actor: USER_ACTOR,
      commentId: "comment-1",
      queueId: "wake-1",
      revision: "rev-1",
      body: "updated body",
      now: new Date("2026-01-01T00:00:00Z"),
    });

    expect(transaction.updateCommentBody).toHaveBeenCalledWith(
      expect.objectContaining({ issueId: "issue-1", commentId: "comment-1", body: "updated body" }),
    );
    expect(transaction.syncCommentReferences).toHaveBeenCalledWith("comment-1");
    expect(transaction.syncCommentExternalObjectsSafely).toHaveBeenCalledWith("comment-1");
    expect(result.queue).toEqual(queueSnapshot());
    // Proves the activity write runs on the same locked transaction as the
    // mutation, not as a separate statement after it commits.
    expect(transaction.logActivity).toHaveBeenCalledWith({
      actorType: "user",
      actorId: "user-1",
      agentId: null,
      runId: null,
      agentApiKeyId: null,
      action: "issue.queued_comment_edited",
      entityId: "issue-1",
      details: { commentId: "comment-1", queueId: "wake-1", revision: "rev-1" },
    });
    expect(result.activityPublication).toEqual(activityPublicationFixture());
  });

  it("rejects a stale queue id with queued_comment_stale_queue", async () => {
    const locked = lockedState({ queue: queueSnapshot({ queueId: "wake-1" }) });
    const editQueuedComment = createEditQueuedComment({ issueLock: createFakeIssueLock(locked, createFakeTransaction()) });

    await expect(
      editQueuedComment({
        issue: ISSUE,
        actor: USER_ACTOR,
        commentId: "comment-1",
        queueId: "wake-2",
        revision: "rev-1",
        body: "x",
        now: new Date(),
      }),
    ).rejects.toMatchObject({ code: "queued_comment_stale_queue" });
  });

  it("rejects a stale revision with queued_comment_revision_conflict", async () => {
    const locked = lockedState();
    const editQueuedComment = createEditQueuedComment({ issueLock: createFakeIssueLock(locked, createFakeTransaction()) });

    await expect(
      editQueuedComment({
        issue: ISSUE,
        actor: USER_ACTOR,
        commentId: "comment-1",
        queueId: "wake-1",
        revision: "stale-rev",
        body: "x",
        now: new Date(),
      }),
    ).rejects.toBeInstanceOf(QueuedCommentMutationError);
  });

  it("rejects a comment the actor cannot edit", async () => {
    const locked = lockedState({ queue: queueSnapshot({ entries: [entry({ canEdit: false })] }) });
    const editQueuedComment = createEditQueuedComment({ issueLock: createFakeIssueLock(locked, createFakeTransaction()) });

    await expect(
      editQueuedComment({
        issue: ISSUE,
        actor: USER_ACTOR,
        commentId: "comment-1",
        queueId: "wake-1",
        revision: "rev-1",
        body: "x",
        now: new Date(),
      }),
    ).rejects.toBeInstanceOf(QueuedCommentMutationForbiddenError);
  });

  it("surfaces queued_comment_already_dispatching when the linked run left the queued status mid-mutation", async () => {
    const locked = lockedState({ queueRun: runRow({ id: "run-1" }) });
    const transaction = createFakeTransaction({ updateQueueRunCommentIds: vi.fn(async () => null) });
    const editQueuedComment = createEditQueuedComment({ issueLock: createFakeIssueLock(locked, transaction) });

    await expect(
      editQueuedComment({
        issue: ISSUE,
        actor: USER_ACTOR,
        commentId: "comment-1",
        queueId: "wake-1",
        revision: "rev-1",
        body: "x",
        now: new Date(),
      }),
    ).rejects.toMatchObject({ code: "queued_comment_already_dispatching" });
  });
});

describe("reorderQueuedComments", () => {
  it("rewrites the wake payload with the submitted order", async () => {
    const locked = lockedState({
      queue: queueSnapshot({ entries: [
        entry({ comment: commentFixture({ id: "a" }), position: 0 }),
        entry({ comment: commentFixture({ id: "b" }), position: 1 }),
      ] }),
    });
    const transaction = createFakeTransaction();
    const reorderQueuedComments = createReorderQueuedComments({ issueLock: createFakeIssueLock(locked, transaction) });

    const result = await reorderQueuedComments({
      issue: ISSUE,
      actor: USER_ACTOR,
      queueId: "wake-1",
      revision: "rev-1",
      orderedCommentIds: ["b", "a"],
      now: new Date(),
    });

    expect(transaction.updateWakeQueuedCommentIds).toHaveBeenCalledWith(
      expect.objectContaining({ wakeId: "wake-1", ids: ["b", "a"] }),
    );
    // Proves the activity write runs on the same locked transaction as the
    // mutation, not as a separate statement after it commits.
    expect(transaction.logActivity).toHaveBeenCalledWith({
      actorType: "user",
      actorId: "user-1",
      agentId: null,
      runId: null,
      agentApiKeyId: null,
      action: "issue.queued_comments_reordered",
      entityId: "issue-1",
      details: { queueId: "wake-1", revision: "rev-1", orderedCommentIds: ["b", "a"] },
    });
    expect(result.activityPublication).toEqual(activityPublicationFixture());
  });

  it("rejects an order that is not a permutation of the current queue", async () => {
    const locked = lockedState({ queue: queueSnapshot({ entries: [
      entry({ comment: commentFixture({ id: "a" }) }),
      entry({ comment: commentFixture({ id: "b" }) }),
    ] }) });
    const reorderQueuedComments = createReorderQueuedComments({ issueLock: createFakeIssueLock(locked, createFakeTransaction()) });

    await expect(
      reorderQueuedComments({
        issue: ISSUE,
        actor: USER_ACTOR,
        queueId: "wake-1",
        revision: "rev-1",
        orderedCommentIds: ["a"],
        now: new Date(),
      }),
    ).rejects.toMatchObject({ code: "queued_comment_order_mismatch" });
  });
});

describe("discardQueuedComment", () => {
  it("cancels the wake and the queued run when the discard empties the queue", async () => {
    const locked = lockedState({ state: "queued", queueRun: runRow({ id: "run-1" }) });
    const transaction = createFakeTransaction();
    const discardQueuedComment = createDiscardQueuedComment({ issueLock: createFakeIssueLock(locked, transaction) });

    const result = await discardQueuedComment({
      issue: ISSUE,
      actor: USER_ACTOR,
      commentId: "comment-1",
      queueId: "wake-1",
      revision: "rev-1",
      now: new Date(),
      logActivity: true,
    });

    expect(transaction.cancelWake).toHaveBeenCalledWith(expect.objectContaining({ wakeId: "wake-1" }));
    expect(transaction.cancelQueueRun).toHaveBeenCalledWith(expect.objectContaining({ queueRunId: "run-1" }));
    expect(transaction.clearExecutionLockAndTouchIssue).toHaveBeenCalledWith(
      expect.objectContaining({ executionRunId: "run-1" }),
    );
    expect(result.cancelledRun).toEqual({ id: "run-1" });
    // Proves the activity write runs on the same locked transaction as the
    // mutation, and that the cancelled run's own id lands in its details.
    expect(transaction.logActivity).toHaveBeenCalledWith({
      actorType: "user",
      actorId: "user-1",
      agentId: null,
      runId: null,
      agentApiKeyId: null,
      action: "issue.queued_comment_discarded",
      entityId: "issue-1",
      details: { commentId: "comment-1", queueId: "wake-1", revision: "rev-1", cancelledRunId: "run-1" },
    });
    expect(result.activityPublication).toEqual(activityPublicationFixture());
  });

  it("logs no activity row when the caller does not request one, matching the comment-delete route's cancellation call site", async () => {
    const locked = lockedState({ state: "queued", queueRun: runRow({ id: "run-1" }) });
    const transaction = createFakeTransaction();
    const discardQueuedComment = createDiscardQueuedComment({ issueLock: createFakeIssueLock(locked, transaction) });

    const result = await discardQueuedComment({
      issue: ISSUE,
      actor: USER_ACTOR,
      commentId: "comment-1",
      queueId: "wake-1",
      revision: "rev-1",
      now: new Date(),
    });

    expect(transaction.logActivity).not.toHaveBeenCalled();
    expect(result.activityPublication).toBeNull();
  });

  it("rewrites the remaining ids when other queued comments are left", async () => {
    const locked = lockedState({
      queue: queueSnapshot({ entries: [
        entry({ comment: commentFixture({ id: "comment-1" }) }),
        entry({ comment: commentFixture({ id: "comment-2" }) }),
      ] }),
    });
    const transaction = createFakeTransaction();
    const discardQueuedComment = createDiscardQueuedComment({ issueLock: createFakeIssueLock(locked, transaction) });

    const result = await discardQueuedComment({
      issue: ISSUE,
      actor: USER_ACTOR,
      commentId: "comment-1",
      queueId: "wake-1",
      revision: "rev-1",
      now: new Date(),
    });

    expect(transaction.updateWakeQueuedCommentIds).toHaveBeenCalledWith(expect.objectContaining({ ids: ["comment-2"] }));
    expect(transaction.cancelWake).not.toHaveBeenCalled();
    expect(transaction.touchIssueUpdatedAt).toHaveBeenCalledWith(expect.objectContaining({ issueId: ISSUE.id }));
    expect(result.cancelledRun).toBeNull();
  });

  it("skips the mutation-target check when no revision is submitted, matching the comment-delete route's cancellation call site", async () => {
    const locked = lockedState({ queue: queueSnapshot({ revision: "some-other-revision" }) });
    const transaction = createFakeTransaction();
    const discardQueuedComment = createDiscardQueuedComment({ issueLock: createFakeIssueLock(locked, transaction) });

    await expect(
      discardQueuedComment({
        issue: ISSUE,
        actor: USER_ACTOR,
        commentId: "comment-1",
        queueId: "wake-1",
        now: new Date(),
      }),
    ).resolves.toBeDefined();
  });

  it("rejects a discard from an actor who did not author the comment", async () => {
    const locked = lockedState({ queue: queueSnapshot({ entries: [
      entry({ comment: commentFixture({ authorUserId: "user-2", authorAgentId: null }) }),
    ] }) });
    const discardQueuedComment = createDiscardQueuedComment({ issueLock: createFakeIssueLock(locked, createFakeTransaction()) });

    await expect(
      discardQueuedComment({
        issue: ISSUE,
        actor: USER_ACTOR,
        commentId: "comment-1",
        queueId: "wake-1",
        revision: "rev-1",
        now: new Date(),
      }),
    ).rejects.toBeInstanceOf(QueuedCommentMutationForbiddenError);
  });

  it("authorizes an agent actor discarding its own queued message", async () => {
    const locked = lockedState({
      queue: queueSnapshot({ entries: [
        entry({ comment: commentFixture({ authorUserId: null, authorAgentId: "agent-1" }) }),
      ] }),
    });
    const transaction = createFakeTransaction();
    const discardQueuedComment = createDiscardQueuedComment({ issueLock: createFakeIssueLock(locked, transaction) });

    await expect(
      discardQueuedComment({
        issue: ISSUE,
        actor: AGENT_ACTOR,
        commentId: "comment-1",
        queueId: "wake-1",
        now: new Date(),
      }),
    ).resolves.toBeDefined();
  });

  it("rolls back when the queued run to cancel already left the queued status", async () => {
    const locked = lockedState({ queueRun: runRow({ id: "run-1" }) });
    const transaction = createFakeTransaction({ cancelQueueRun: vi.fn(async () => null) });
    const discardQueuedComment = createDiscardQueuedComment({ issueLock: createFakeIssueLock(locked, transaction) });

    await expect(
      discardQueuedComment({
        issue: ISSUE,
        actor: USER_ACTOR,
        commentId: "comment-1",
        queueId: "wake-1",
        revision: "rev-1",
        now: new Date(),
      }),
    ).rejects.toMatchObject({ code: "queued_comment_already_dispatching" });
  });
});
