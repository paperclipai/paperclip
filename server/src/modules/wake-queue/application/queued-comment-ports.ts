// Ports for the three queued-comment queue mutations (edit, reorder,
// discard). Mirrors the release half's `IssueLockWriter` shape: the adapter
// owns the one transaction each mutation runs in, locks the issue and the
// wake row the caller named, classifies the locked state, and hands the
// caller a `LockedQueuedCommentState` plus a `QueuedCommentQueueTransaction`
// bound to that same transaction for every further read and write.

import type { IssueComment, IssueQueuedCommentEntry, IssueQueuedCommentQueue } from "@paperclipai/shared";

export type QueuedCommentActor = {
  actorType: "agent" | "user";
  /** The user id for a user actor, the agent id for an agent actor -- the same value `getActorInfo` names `actorId`. */
  actorId: string;
  /** Null for a user actor. */
  agentId: string | null;
  runId: string | null;
  agentApiKeyId: string | null;
};

/** The fields a mutation needs to log its own activity row; entity type is always "issue". */
export type QueuedCommentActivityLogInput = {
  actorType: "agent" | "user";
  actorId: string;
  agentId: string | null;
  runId: string | null;
  agentApiKeyId: string | null;
  action: string;
  entityId: string;
  details: Record<string, unknown>;
};

/**
 * Structurally mirrors the server's `ActivityPublication` (from
 * `services/activity-log.ts`), which this layer cannot import by name --
 * the module boundary check forbids the application layer from importing
 * server services. The route casts this back to `ActivityPublication`
 * before calling `publishActivity`.
 */
export type QueuedCommentActivityPublication = {
  companyId: string;
  payload: Record<string, unknown>;
  pluginEvent: unknown;
};

export type QueuedCommentIssueContext = {
  id: string;
  companyId: string;
  assigneeAgentId: string | null;
  executionRunId: string | null;
};

export type QueuedCommentWakeRow = {
  id: string;
  agentId: string;
  status: string;
  runId: string | null;
  payload: Record<string, unknown>;
};

export type QueuedCommentRunRow = {
  id: string;
  status: string;
  runtimeMode: string | null;
  contextSnapshot: Record<string, unknown>;
};

/** The module's entry shape is the shared contract, so the compiler checks it directly; the route needs no cast. */
export type QueuedCommentEntrySnapshot = IssueQueuedCommentEntry;

/** The module's queue-snapshot shape is the shared contract, so the compiler checks it directly; the route needs no cast. */
export type QueuedCommentQueueSnapshot = IssueQueuedCommentQueue;

/** The locked, transaction-scoped state a mutation reads before it decides what to write. */
export type LockedQueuedCommentState = {
  wake: QueuedCommentWakeRow;
  state: "deferred" | "queued";
  queueRun: QueuedCommentRunRow | null;
  activeRun: QueuedCommentRunRow | null;
  queue: QueuedCommentQueueSnapshot;
};

/**
 * Every member is bound to the one transaction `withLockedQueue` owns, and
 * to the one company that transaction is open for. Every read and every
 * write names that bound `companyId` in its own predicate; a
 * caller-supplied `issue`/`wake`/`queueRun` value is never trusted as an
 * authorization boundary by itself.
 */
export interface QueuedCommentQueueTransaction {
  updateCommentBody(input: {
    issueId: string;
    commentId: string;
    body: string;
    updatedAt: Date;
  }): Promise<boolean>;
  touchIssueUpdatedAt(input: { issueId: string; updatedAt: Date }): Promise<void>;
  /** Compare-and-set on `id`; the wake's current status is not re-checked here because the row is already locked for the duration of this transaction. */
  updateWakeQueuedCommentIds(input: {
    wakeId: string;
    payload: Record<string, unknown>;
    ids: string[];
    updatedAt: Date;
  }): Promise<QueuedCommentWakeRow>;
  /** Guarded on the run's current `queued` status. Returns `null` when a concurrent writer already moved the run off `queued`. */
  updateQueueRunCommentIds(input: {
    queueRunId: string;
    /** The run's own context snapshot, as already read under lock; the rewrite is derived from this base. */
    contextSnapshot: Record<string, unknown>;
    ids: string[];
    updatedAt: Date;
  }): Promise<QueuedCommentRunRow | null>;
  /** Returns the full deleted comment row so the caller can echo it back as the delete route's response body. */
  deleteComment(input: {
    issueId: string;
    commentId: string;
  }): Promise<IssueComment | null>;
  cancelWake(input: { wakeId: string; reason: string; now: Date }): Promise<void>;
  /**
   * Guarded on the run's current `queued` status. Returns `null` when a
   * concurrent writer already moved the run off `queued`; returns just the
   * cancelled run's id, which is all a post-commit telemetry emission needs.
   */
  cancelQueueRun(input: {
    queueRunId: string;
    reason: string;
    now: Date;
  }): Promise<{ id: string } | null>;
  /**
   * Clears the issue's execution-lock columns and performs the `updatedAt`
   * touch, in the one update the original route issued for a discard that
   * empties the queue with a live queue run. The write is guarded on the
   * issue's current `executionRunId`; a lost guard silently skips the whole
   * update, matching the pre-existing behavior of this best-effort touch.
   */
  clearExecutionLockAndTouchIssue(input: {
    issueId: string;
    executionRunId: string;
    updatedAt: Date;
  }): Promise<void>;
  buildQueueSnapshot(input: {
    issue: QueuedCommentIssueContext;
    actor: QueuedCommentActor;
    wake: QueuedCommentWakeRow | null;
    state: "deferred" | "queued" | null;
    queueRun: QueuedCommentRunRow | null;
    activeRun: QueuedCommentRunRow | null;
  }): Promise<QueuedCommentQueueSnapshot>;
  syncCommentReferences(commentId: string): Promise<void>;
  deleteCommentReferenceSource(commentId: string): Promise<void>;
  syncCommentExternalObjectsSafely(commentId: string): Promise<void>;
  /**
   * Persists the activity row on this same transaction, so a mutation and
   * its audit record commit or roll back together. Returns the publication
   * for the caller to publish once the transaction has committed; this
   * write never publishes the live event itself.
   */
  logActivity(input: QueuedCommentActivityLogInput): Promise<QueuedCommentActivityPublication>;
}

export interface QueuedCommentIssueLockWriter {
  /**
   * Opens the one transaction a mutation runs in: locks the issue row, locks
   * the wake row named by `queueId`, classifies it (reading and locking the
   * linked heartbeat run when the classification needs it), and builds the
   * queue snapshot the caller's mutation target check compares against.
   * Throws `QueuedCommentMutationError` with code `queued_comment_not_pending`
   * or `queued_comment_already_dispatching` when the lock step itself cannot
   * resolve a live queue; `fn` never runs in that case.
   */
  withLockedQueue<T>(
    input: {
      /** Also carries the company id; every locked read and write binds its `companyId` predicate to `issue.companyId`. */
      issue: QueuedCommentIssueContext;
      actor: QueuedCommentActor;
      queueId: string;
    },
    fn: (locked: LockedQueuedCommentState, transaction: QueuedCommentQueueTransaction) => Promise<T>,
  ): Promise<T>;
}
