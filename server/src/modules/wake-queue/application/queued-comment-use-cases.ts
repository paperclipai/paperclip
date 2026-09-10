import type { IssueComment } from "@paperclipai/shared";
import {
  decideQueuedCommentActorOwnsEntry,
  decideQueuedCommentMutationTarget,
  decideQueuedCommentRemovalOutcome,
  decideQueuedCommentReorder,
} from "../domain/policy.js";
import type {
  QueuedCommentActor,
  QueuedCommentIssueContext,
  QueuedCommentIssueLockWriter,
  QueuedCommentQueueSnapshot,
  QueuedCommentQueueTransaction,
  QueuedCommentRunRow,
} from "./queued-comment-ports.js";

export type QueuedCommentMutationErrorCode =
  | "queued_comment_not_pending"
  | "queued_comment_already_dispatching"
  | "queued_comment_stale_queue"
  | "queued_comment_revision_conflict"
  | "queued_comment_order_mismatch";

/** The route maps this 1:1 onto the `conflict(...)` HTTP error it threw before this move, using `code` and `message` unchanged. */
export class QueuedCommentMutationError extends Error {
  constructor(
    readonly code: QueuedCommentMutationErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "QueuedCommentMutationError";
  }
}

/** The route maps this onto the `forbidden(...)` HTTP error it threw before this move, using `message` unchanged. */
export class QueuedCommentMutationForbiddenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QueuedCommentMutationForbiddenError";
  }
}

function requireMutationTarget(queue: QueuedCommentQueueSnapshot, queueId: string, revision: string): void {
  const decision = decideQueuedCommentMutationTarget({
    queueIdMatches: queue.queueId === queueId,
    revisionMatches: queue.revision === revision,
  });
  if (decision.kind === "stale_queue") {
    throw new QueuedCommentMutationError("queued_comment_stale_queue", "The queued message targets a stale queue");
  }
  if (decision.kind === "revision_conflict") {
    throw new QueuedCommentMutationError("queued_comment_revision_conflict", "The queued messages changed in another session");
  }
}

async function updateQueueRunCommentIdsGuarded(
  tx: QueuedCommentQueueTransaction,
  input: { companyId: string; queueRun: QueuedCommentRunRow | null; ids: string[]; updatedAt: Date },
): Promise<QueuedCommentRunRow | null> {
  if (!input.queueRun) return null;
  const updated = await tx.updateQueueRunCommentIds({
    companyId: input.companyId,
    queueRunId: input.queueRun.id,
    contextSnapshot: input.queueRun.contextSnapshot,
    ids: input.ids,
    updatedAt: input.updatedAt,
  });
  if (!updated) {
    throw new QueuedCommentMutationError("queued_comment_already_dispatching", "The queued message is already being dispatched");
  }
  return updated;
}

export type EditQueuedCommentInput = {
  companyId: string;
  issue: QueuedCommentIssueContext;
  actor: QueuedCommentActor;
  commentId: string;
  queueId: string;
  revision: string;
  body: string;
  now: Date;
};

export function createEditQueuedComment(deps: { issueLock: QueuedCommentIssueLockWriter }) {
  return async function editQueuedComment(input: EditQueuedCommentInput): Promise<QueuedCommentQueueSnapshot> {
    return deps.issueLock.withLockedQueue(
      { companyId: input.companyId, issue: input.issue, actor: input.actor, queueId: input.queueId },
      async (locked, tx) => {
        requireMutationTarget(locked.queue, input.queueId, input.revision);
        const entry = locked.queue.entries.find((candidate) => candidate.comment.id === input.commentId);
        if (!entry) {
          throw new QueuedCommentMutationError("queued_comment_not_pending", "The queued message is no longer pending");
        }
        if (!entry.canEdit) {
          throw new QueuedCommentMutationForbiddenError("Only the queued message author can edit it");
        }

        const updated = await tx.updateCommentBody({
          companyId: input.companyId,
          issueId: input.issue.id,
          commentId: input.commentId,
          body: input.body,
          updatedAt: input.now,
        });
        if (!updated) {
          throw new QueuedCommentMutationError("queued_comment_not_pending", "The queued message is no longer pending");
        }
        await tx.touchIssueUpdatedAt({ companyId: input.companyId, issueId: input.issue.id, updatedAt: input.now });
        await tx.syncCommentReferences(input.commentId);
        await tx.syncCommentExternalObjectsSafely(input.commentId);

        const ids = locked.queue.entries.map((candidate) => candidate.comment.id);
        const updatedQueueRun = await updateQueueRunCommentIdsGuarded(tx, {
          companyId: input.companyId,
          queueRun: locked.queueRun,
          ids,
          updatedAt: input.now,
        });

        return tx.buildQueueSnapshot({
          companyId: input.companyId,
          issue: input.issue,
          actor: input.actor,
          wake: locked.wake,
          state: locked.state,
          queueRun: updatedQueueRun ?? locked.queueRun,
          activeRun: locked.activeRun,
        });
      },
    );
  };
}

export type ReorderQueuedCommentsInput = {
  companyId: string;
  issue: QueuedCommentIssueContext;
  actor: QueuedCommentActor;
  queueId: string;
  revision: string;
  orderedCommentIds: string[];
  now: Date;
};

export function createReorderQueuedComments(deps: { issueLock: QueuedCommentIssueLockWriter }) {
  return async function reorderQueuedComments(input: ReorderQueuedCommentsInput): Promise<QueuedCommentQueueSnapshot> {
    return deps.issueLock.withLockedQueue(
      { companyId: input.companyId, issue: input.issue, actor: input.actor, queueId: input.queueId },
      async (locked, tx) => {
        requireMutationTarget(locked.queue, input.queueId, input.revision);

        const currentIds = locked.queue.entries.map((entry) => entry.comment.id);
        const reorderDecision = decideQueuedCommentReorder({ currentIds, orderedIds: input.orderedCommentIds });
        if (reorderDecision.kind === "mismatch") {
          throw new QueuedCommentMutationError(
            "queued_comment_order_mismatch",
            "The queued message order does not match the current queue",
          );
        }

        const updatedWake = await tx.updateWakeQueuedCommentIds({
          companyId: input.companyId,
          wakeId: locked.wake.id,
          payload: locked.wake.payload,
          ids: input.orderedCommentIds,
          updatedAt: input.now,
        });
        const updatedQueueRun = await updateQueueRunCommentIdsGuarded(tx, {
          companyId: input.companyId,
          queueRun: locked.queueRun,
          ids: input.orderedCommentIds,
          updatedAt: input.now,
        });

        return tx.buildQueueSnapshot({
          companyId: input.companyId,
          issue: input.issue,
          actor: input.actor,
          wake: updatedWake,
          state: locked.state,
          queueRun: updatedQueueRun ?? locked.queueRun,
          activeRun: locked.activeRun,
        });
      },
    );
  };
}

export type DiscardQueuedCommentInput = {
  companyId: string;
  issue: QueuedCommentIssueContext;
  actor: QueuedCommentActor;
  commentId: string;
  queueId: string;
  /** Skipped entirely when omitted, matching the comment-delete route's cancellation call site, which does not carry a revision. */
  revision?: string;
  now: Date;
};

export type DiscardQueuedCommentResult = {
  /** The full deleted comment row; the comment-delete route echoes it back as its own response body. */
  deleted: IssueComment;
  queue: QueuedCommentQueueSnapshot;
  /** Set only when the discard emptied the queue and cancelled a queued run; the caller emits telemetry for it after the transaction commits. */
  cancelledRun: { id: string } | null;
};

export function createDiscardQueuedComment(deps: { issueLock: QueuedCommentIssueLockWriter }) {
  return async function discardQueuedComment(input: DiscardQueuedCommentInput): Promise<DiscardQueuedCommentResult> {
    return deps.issueLock.withLockedQueue(
      { companyId: input.companyId, issue: input.issue, actor: input.actor, queueId: input.queueId },
      async (locked, tx) => {
        if (input.revision !== undefined) {
          requireMutationTarget(locked.queue, input.queueId, input.revision);
        }

        const entry = locked.queue.entries.find((candidate) => candidate.comment.id === input.commentId);
        if (!entry) {
          throw new QueuedCommentMutationError("queued_comment_not_pending", "The queued message is no longer pending");
        }
        const owns = decideQueuedCommentActorOwnsEntry({
          actorType: input.actor.actorType,
          actorId: input.actor.actorId,
          actorAgentId: input.actor.agentId,
          authorAgentId: entry.comment.authorAgentId,
          authorUserId: entry.comment.authorUserId,
        });
        if (!owns) {
          throw new QueuedCommentMutationForbiddenError("Only the queued message author can discard it");
        }

        const deleted = await tx.deleteComment({ companyId: input.companyId, issueId: input.issue.id, commentId: input.commentId });
        if (!deleted) {
          throw new QueuedCommentMutationError("queued_comment_not_pending", "The queued message is no longer pending");
        }
        await tx.deleteCommentReferenceSource(input.commentId);
        await tx.syncCommentExternalObjectsSafely(input.commentId);

        const remainingIds = locked.queue.entries.map((candidate) => candidate.comment.id).filter((id) => id !== input.commentId);
        const outcome = decideQueuedCommentRemovalOutcome({ remainingCount: remainingIds.length });

        let cancelledRun: { id: string } | null = null;
        let nextWake = locked.wake;
        let nextQueueRun = locked.queueRun;

        if (outcome.kind === "empty") {
          await tx.cancelWake({
            companyId: input.companyId,
            wakeId: locked.wake.id,
            reason: "Queued message discarded before dispatch",
            now: input.now,
          });
          if (locked.queueRun) {
            const cancelled = await tx.cancelQueueRun({
              companyId: input.companyId,
              queueRunId: locked.queueRun.id,
              reason: "Queued message discarded before dispatch",
              now: input.now,
            });
            if (!cancelled) {
              throw new QueuedCommentMutationError(
                "queued_comment_already_dispatching",
                "The queued message is already being dispatched",
              );
            }
            cancelledRun = cancelled;
          }
          await tx.updateIssueAfterDiscard({
            companyId: input.companyId,
            issueId: input.issue.id,
            clearExecutionLock: locked.queueRun ? { executionRunId: locked.queueRun.id } : null,
            updatedAt: input.now,
          });
        } else {
          nextWake = await tx.updateWakeQueuedCommentIds({
            companyId: input.companyId,
            wakeId: locked.wake.id,
            payload: locked.wake.payload,
            ids: remainingIds,
            updatedAt: input.now,
          });
          nextQueueRun = await updateQueueRunCommentIdsGuarded(tx, {
            companyId: input.companyId,
            queueRun: locked.queueRun,
            ids: remainingIds,
            updatedAt: input.now,
          });
          await tx.updateIssueAfterDiscard({
            companyId: input.companyId,
            issueId: input.issue.id,
            clearExecutionLock: null,
            updatedAt: input.now,
          });
        }

        const queue = await tx.buildQueueSnapshot({
          companyId: input.companyId,
          issue: input.issue,
          actor: input.actor,
          wake: outcome.kind === "empty" ? null : nextWake,
          state: outcome.kind === "empty" ? null : locked.state,
          queueRun: outcome.kind === "empty" ? null : (nextQueueRun ?? locked.queueRun),
          activeRun: locked.activeRun,
        });

        return { deleted, queue, cancelledRun };
      },
    );
  };
}
