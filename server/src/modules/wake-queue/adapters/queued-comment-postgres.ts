import { and, asc, eq, inArray } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agentWakeupRequests, agents, heartbeatRuns, issueComments, issues } from "@paperclipai/db";
import type { IssueComment, IssueQueuedCommentQueue } from "@paperclipai/shared";
import {
  buildQueuedCommentQueueSnapshot,
  decideQueuedCommentQueueSteering,
  queuedCommentIdsFromWakePayload,
  withQueuedCommentIdsInRunContext,
  withQueuedCommentIdsInWakePayload,
} from "../../../services/issue-queued-comment-queue.js";
import { logActivity as persistActivityLogRow, type ActivityPublication } from "../../../services/activity-log.js";
import {
  NativeSessionSteeringError,
  steerNativeSession,
} from "../../../services/native-runtime/native-session-executor.js";
import {
  acceptSteeredIdentity,
  reconcileSteeredIdentity,
  rejectSteeredIdentity,
  reserveSteeredIdentity,
  storedSteeringAcknowledgement,
} from "../../../services/run-identity.js";
import { decideQueuedCommentWakeLookup } from "../domain/policy.js";
import { parseObject, readNonEmptyString } from "../domain/values.js";
import { QueuedCommentMutationError, requireMutationTarget } from "../application/queued-comment-use-cases.js";
import type {
  LockedQueuedCommentState,
  QueuedCommentActivityLogInput,
  QueuedCommentActivityPublication,
  QueuedCommentIssueLockWriter,
  QueuedCommentQueueTransaction,
  QueuedCommentRunRow,
  QueuedCommentWakeRow,
  SteerQueuedWakeCommentInput,
  SteerQueuedWakeCommentResult,
} from "../application/queued-comment-ports.js";

type WakeRow = typeof agentWakeupRequests.$inferSelect;
type RunRow = typeof heartbeatRuns.$inferSelect;

function toWakeRow(row: WakeRow): QueuedCommentWakeRow {
  return { id: row.id, agentId: row.agentId, status: row.status, runId: row.runId, payload: parseObject(row.payload) };
}

function toRunRow(row: RunRow): QueuedCommentRunRow {
  return { id: row.id, status: row.status, runtimeMode: row.runtimeMode, contextSnapshot: parseObject(row.contextSnapshot) };
}

export type QueuedCommentQueuePostgresAdapterDeps = {
  /** `issueReferenceService(db).syncComment`; runs on the module's own transaction. */
  syncCommentReferences(commentId: string, tx: Db): Promise<void>;
  /** `issueReferenceService(db).deleteCommentSource`; runs on the module's own transaction. */
  deleteCommentReferenceSource(commentId: string, tx: Db): Promise<void>;
  /** `externalObjectService(db, opts).syncCommentSafely`; runs on the module's own transaction. */
  syncCommentExternalObjectsSafely(commentId: string, tx: Db): Promise<void>;
};

function buildTransaction(tx: Db, companyId: string, deps: QueuedCommentQueuePostgresAdapterDeps): QueuedCommentQueueTransaction {
  return {
    async updateCommentBody({ issueId, commentId, body, updatedAt }) {
      const updated = await tx
        .update(issueComments)
        .set({ body, updatedAt })
        .where(and(eq(issueComments.id, commentId), eq(issueComments.issueId, issueId), eq(issueComments.companyId, companyId)))
        .returning({ id: issueComments.id })
        .then((rows) => rows[0] ?? null);
      return updated !== null;
    },

    async touchIssueUpdatedAt({ issueId, updatedAt }) {
      await tx.update(issues).set({ updatedAt }).where(and(eq(issues.id, issueId), eq(issues.companyId, companyId)));
    },

    async updateWakeQueuedCommentIds({ wakeId, payload, ids, updatedAt }) {
      const row = await tx
        .update(agentWakeupRequests)
        .set({ payload: withQueuedCommentIdsInWakePayload(payload, ids), updatedAt })
        .where(and(eq(agentWakeupRequests.id, wakeId), eq(agentWakeupRequests.companyId, companyId)))
        .returning()
        .then((rows) => rows[0]);
      return toWakeRow(row);
    },

    async updateQueueRunCommentIds({ queueRunId, contextSnapshot, ids, updatedAt }) {
      const row = await tx
        .update(heartbeatRuns)
        .set({ contextSnapshot: withQueuedCommentIdsInRunContext(contextSnapshot, ids), updatedAt })
        .where(and(eq(heartbeatRuns.id, queueRunId), eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.status, "queued")))
        .returning()
        .then((rows) => rows[0] ?? null);
      return row ? toRunRow(row) : null;
    },

    async deleteComment({ issueId, commentId }) {
      const row = await tx
        .delete(issueComments)
        .where(and(eq(issueComments.id, commentId), eq(issueComments.issueId, issueId), eq(issueComments.companyId, companyId)))
        .returning()
        .then((rows) => rows[0] ?? null);
      return row ? (row as IssueComment) : null;
    },

    async cancelWake({ wakeId, reason, now }) {
      await tx
        .update(agentWakeupRequests)
        .set({ status: "cancelled", finishedAt: now, error: reason, updatedAt: now })
        .where(and(eq(agentWakeupRequests.id, wakeId), eq(agentWakeupRequests.companyId, companyId)));
    },

    async cancelQueueRun({ queueRunId, reason, now }) {
      const row = await tx
        .update(heartbeatRuns)
        .set({ status: "cancelled", finishedAt: now, error: reason, errorCode: "queued_comment_discarded", updatedAt: now })
        .where(and(eq(heartbeatRuns.id, queueRunId), eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.status, "queued")))
        .returning({ id: heartbeatRuns.id })
        .then((rows) => rows[0] ?? null);
      return row ? { id: row.id } : null;
    },

    async clearExecutionLockAndTouchIssue({ issueId, executionRunId, updatedAt }) {
      await tx
        .update(issues)
        .set({ executionRunId: null, executionAgentNameKey: null, executionLockedAt: null, updatedAt })
        .where(and(eq(issues.id, issueId), eq(issues.companyId, companyId), eq(issues.executionRunId, executionRunId)));
    },

    async buildQueueSnapshot({ issue, actor, wake, state, queueRun, activeRun }): Promise<IssueQueuedCommentQueue> {
      const commentIds = queuedCommentIdsFromWakePayload(wake?.payload ?? null);
      const rows =
        commentIds.length > 0
          ? await tx
              .select()
              .from(issueComments)
              .where(
                and(
                  eq(issueComments.companyId, companyId),
                  eq(issueComments.issueId, issue.id),
                  inArray(issueComments.id, commentIds),
                ),
              )
          : [];
      const byId = new Map(rows.map((row) => [row.id, row]));
      const comments = commentIds.flatMap((id) => {
        const row = byId.get(id);
        return row && !row.deletedAt ? [row] : [];
      });

      const assignedAgent = issue.assigneeAgentId
        ? await tx
            .select({ adapterType: agents.adapterType })
            .from(agents)
            .where(and(eq(agents.id, issue.assigneeAgentId), eq(agents.companyId, companyId)))
            .limit(1)
            .then((agentRows) => agentRows[0] ?? null)
        : null;

      // A queue mutation never delivers same-turn steering itself, so this
      // adapter never probes the live runner: it answers
      // "temporarily_unavailable" wherever the shared rule says a caller
      // may probe. Only the read path probes the live provider.
      const steering = decideQueuedCommentQueueSteering({
        state,
        queueRunRuntimeMode: queueRun?.runtimeMode ?? null,
        activeRun,
        assignedAgentAdapterType: assignedAgent?.adapterType ?? null,
        queuedCommentCount: comments.length,
      });
      const steeringDisposition: IssueQueuedCommentQueue["steeringDisposition"] =
        steering.kind === "probe" ? "temporarily_unavailable" : steering.kind;

      return buildQueuedCommentQueueSnapshot({
        issueId: issue.id,
        queueId: wake?.id ?? null,
        state,
        activeRunId: activeRun?.id ?? null,
        protocol: steering.protocol,
        steeringDisposition,
        comments,
        actorType: actor.actorType,
        actorId: actor.actorId,
      });
    },

    async syncCommentReferences(commentId) {
      await deps.syncCommentReferences(commentId, tx);
    },
    async deleteCommentReferenceSource(commentId) {
      await deps.deleteCommentReferenceSource(commentId, tx);
    },
    async syncCommentExternalObjectsSafely(commentId) {
      await deps.syncCommentExternalObjectsSafely(commentId, tx);
    },

    async logActivity(input: QueuedCommentActivityLogInput): Promise<QueuedCommentActivityPublication> {
      const publications: ActivityPublication[] = [];
      await persistActivityLogRow(
        tx,
        {
          companyId,
          actorType: input.actorType,
          actorId: input.actorId,
          agentId: input.agentId,
          runId: input.runId,
          agentApiKeyId: input.agentApiKeyId,
          action: input.action,
          entityType: "issue",
          entityId: input.entityId,
          details: input.details,
        },
        publications,
      );
      return publications[0];
    },
  };
}

/**
 * Finds the issue's current live queue. It scans the assigned agent's own
 * pending wakes, the same lookup the read-only queued-comments route runs.
 * The steering replay branch needs this fresh read for one reason: by the
 * time a retry arrives, the wake it named can already be cancelled. The
 * response must then show whatever queue is live now, not the old one.
 */
async function findCurrentQueuedCommentWake(
  tx: Db,
  companyId: string,
  issue: { id: string; assigneeAgentId: string | null },
): Promise<{ wake: WakeRow; state: "deferred" | "queued"; queueRun: RunRow | null } | null> {
  if (!issue.assigneeAgentId) return null;
  const rows = await tx
    .select()
    .from(agentWakeupRequests)
    .where(
      and(
        eq(agentWakeupRequests.companyId, companyId),
        eq(agentWakeupRequests.agentId, issue.assigneeAgentId),
        inArray(agentWakeupRequests.status, ["deferred_issue_execution", "queued"]),
      ),
    )
    .orderBy(asc(agentWakeupRequests.requestedAt));

  for (const wake of rows) {
    if (parseObject(wake.payload).issueId !== issue.id || queuedCommentIdsFromWakePayload(wake.payload).length === 0) {
      continue;
    }
    if (wake.status === "deferred_issue_execution") {
      return { wake, state: "deferred", queueRun: null };
    }
    if (!wake.runId) continue;
    const queueRun = await tx
      .select()
      .from(heartbeatRuns)
      .where(
        and(
          eq(heartbeatRuns.id, wake.runId),
          eq(heartbeatRuns.companyId, companyId),
          eq(heartbeatRuns.agentId, issue.assigneeAgentId),
          eq(heartbeatRuns.wakeupRequestId, wake.id),
          eq(heartbeatRuns.status, "queued"),
        ),
      )
      .limit(1)
      .then((queueRunRows) => queueRunRows[0] ?? null);
    if (queueRun) return { wake, state: "queued", queueRun };
  }
  return null;
}

export function createQueuedCommentIssueLockWriter(db: Db, deps: QueuedCommentQueuePostgresAdapterDeps): QueuedCommentIssueLockWriter {
  return {
    async withLockedQueue(input, fn) {
      return db.transaction(async (rawTx) => {
        const tx = rawTx as unknown as Db;
        const companyId = input.issue.companyId;

        await tx
          .select({ id: issues.id })
          .from(issues)
          .where(and(eq(issues.id, input.issue.id), eq(issues.companyId, companyId)))
          .for("update");

        const wakeRow = await tx
          .select()
          .from(agentWakeupRequests)
          .where(
            and(
              eq(agentWakeupRequests.id, input.queueId),
              eq(agentWakeupRequests.companyId, companyId),
              input.issue.assigneeAgentId ? eq(agentWakeupRequests.agentId, input.issue.assigneeAgentId) : undefined,
            ),
          )
          .for("update")
          .limit(1)
          .then((rows) => rows[0] ?? null);

        const wakePayload = parseObject(wakeRow?.payload);
        const lookup = decideQueuedCommentWakeLookup({
          wakePresent: wakeRow !== null,
          wakeIssueIdMatches: readNonEmptyString(wakePayload.issueId) === input.issue.id,
          hasQueuedCommentIds: queuedCommentIdsFromWakePayload(wakeRow?.payload ?? null).length > 0,
          wakeStatus: wakeRow?.status ?? null,
          wakeHasRunId: Boolean(wakeRow?.runId),
        });

        if (lookup.kind === "not_pending") {
          throw new QueuedCommentMutationError("queued_comment_not_pending", "The queued message is no longer pending");
        }
        if (lookup.kind === "already_dispatching") {
          throw new QueuedCommentMutationError("queued_comment_already_dispatching", "The queued message is already being dispatched");
        }

        // Unreachable: `decideQueuedCommentWakeLookup` only returns "deferred" or "check_queue_run" when the wake row is present.
        if (!wakeRow) throw new Error("wake-queue: queued-comment lookup resolved without a wake row");

        let state: "deferred" | "queued";
        let queueRunRow: RunRow | null = null;

        if (lookup.kind === "deferred") {
          state = "deferred";
        } else {
          // check_queue_run: `wakeHasRunId` was true for this branch to have been reached.
          queueRunRow = await tx
            .select()
            .from(heartbeatRuns)
            .where(
              and(
                eq(heartbeatRuns.id, wakeRow.runId!),
                eq(heartbeatRuns.companyId, companyId),
                eq(heartbeatRuns.agentId, wakeRow.agentId),
                eq(heartbeatRuns.wakeupRequestId, wakeRow.id),
              ),
            )
            .for("update")
            .limit(1)
            .then((rows) => rows[0] ?? null);
          if (!queueRunRow || queueRunRow.status !== "queued") {
            throw new QueuedCommentMutationError(
              "queued_comment_already_dispatching",
              "The queued message is already being dispatched",
            );
          }
          state = "queued";
        }

        const activeRunId = state === "deferred" ? input.issue.executionRunId : null;
        const activeRunRow = activeRunId
          ? await tx
              .select()
              .from(heartbeatRuns)
              .where(and(eq(heartbeatRuns.id, activeRunId), eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.status, "running")))
              .for("update")
              .limit(1)
              .then((rows) => rows[0] ?? null)
          : null;

        const transaction = buildTransaction(tx, companyId, deps);
        const wake = toWakeRow(wakeRow);
        const queueRun = queueRunRow ? toRunRow(queueRunRow) : null;
        const activeRun = activeRunRow ? toRunRow(activeRunRow) : null;

        const queue = await transaction.buildQueueSnapshot({
          issue: input.issue,
          actor: input.actor,
          wake,
          state,
          queueRun,
          activeRun,
        });

        const locked: LockedQueuedCommentState = { wake, state, queueRun, activeRun, queue };
        return fn(locked, transaction);
      });
    },

    async steerQueuedWakeComment(input: SteerQueuedWakeCommentInput): Promise<SteerQueuedWakeCommentResult> {
      const { issue, actor, commentId, queueId, targetRunId, revision } = input;
      const companyId = issue.companyId;

      // Reserve the run's pending steering identity on the root handle.
      // This call opens its own transaction and runs before this method's
      // own transaction opens. So the reservation survives a rollback of
      // the steer that follows it.
      const steeringIdentity = await reserveSteeredIdentity(db, {
        companyId,
        runId: targetRunId,
        issueId: issue.id,
        messageId: commentId,
      });

      let steeringDeliveryAttempted = false;
      let turnId: string | null = null;
      let duplicate = false;

      try {
        const queue = await db.transaction(async (rawTx) => {
          const tx = rawTx as unknown as Db;
          const transaction = buildTransaction(tx, companyId, deps);
          const now = new Date();

          // A client can lose the successful response after the final
          // queued message cancels its wake. Lock the issue row first. This
          // keeps the persisted acknowledgement a durable idempotency
          // record, even when no pending queue remains by the time a retry
          // arrives.
          await tx
            .select({ id: issues.id })
            .from(issues)
            .where(and(eq(issues.id, issue.id), eq(issues.companyId, companyId)))
            .for("update");

          const wakeRow = await tx
            .select()
            .from(agentWakeupRequests)
            .where(
              and(
                eq(agentWakeupRequests.id, queueId),
                eq(agentWakeupRequests.companyId, companyId),
                issue.assigneeAgentId ? eq(agentWakeupRequests.agentId, issue.assigneeAgentId) : undefined,
              ),
            )
            .for("update")
            .limit(1)
            .then((rows) => rows[0] ?? null);

          const retryRunRow =
            wakeRow && parseObject(wakeRow.payload).issueId === issue.id
              ? await tx
                  .select()
                  .from(heartbeatRuns)
                  .where(
                    and(
                      eq(heartbeatRuns.id, targetRunId),
                      eq(heartbeatRuns.companyId, companyId),
                      eq(heartbeatRuns.agentId, wakeRow.agentId),
                    ),
                  )
                  .for("update")
                  .limit(1)
                  .then((rows) => rows[0] ?? null)
              : null;

          const retryRunContext = parseObject(retryRunRow?.contextSnapshot);
          const retryRunResult = parseObject(retryRunRow?.resultJson);
          const retryAcknowledgements = parseObject(retryRunResult.queuedSteeringAcknowledgements);
          const retryAcknowledgement = parseObject(retryAcknowledgements[commentId]);

          if (
            retryRunRow &&
            (retryRunContext.issueId === issue.id || retryRunContext.taskId === issue.id) &&
            retryAcknowledgement.status === "acknowledged" &&
            retryAcknowledgement.queueId === queueId
          ) {
            duplicate = true;
            turnId = typeof retryAcknowledgement.turnId === "string" ? retryAcknowledgement.turnId : null;
            const current = await findCurrentQueuedCommentWake(tx, companyId, issue);
            return transaction.buildQueueSnapshot({
              issue,
              actor,
              wake: current ? toWakeRow(current.wake) : null,
              state: current?.state ?? null,
              queueRun: current?.queueRun ? toRunRow(current.queueRun) : null,
              activeRun: retryRunRow.status === "running" ? toRunRow(retryRunRow) : null,
            });
          }

          if (
            !wakeRow ||
            parseObject(wakeRow.payload).issueId !== issue.id ||
            queuedCommentIdsFromWakePayload(wakeRow.payload).length === 0
          ) {
            throw new QueuedCommentMutationError("queued_comment_not_pending", "The queued message is no longer pending");
          }

          let state: "deferred" | "queued";
          let queueRunRow: RunRow | null = null;
          if (wakeRow.status === "deferred_issue_execution") {
            state = "deferred";
          } else if (wakeRow.status === "queued" && wakeRow.runId) {
            queueRunRow = await tx
              .select()
              .from(heartbeatRuns)
              .where(
                and(
                  eq(heartbeatRuns.id, wakeRow.runId),
                  eq(heartbeatRuns.companyId, companyId),
                  eq(heartbeatRuns.agentId, wakeRow.agentId),
                  eq(heartbeatRuns.wakeupRequestId, wakeRow.id),
                ),
              )
              .for("update")
              .limit(1)
              .then((rows) => rows[0] ?? null);
            if (!queueRunRow || queueRunRow.status !== "queued") {
              throw new QueuedCommentMutationError(
                "queued_comment_already_dispatching",
                "The queued message is already being dispatched",
              );
            }
            state = "queued";
          } else if (
            wakeRow.status === "claimed" ||
            wakeRow.status === "running" ||
            (wakeRow.runId && (wakeRow.status === "succeeded" || wakeRow.status === "failed"))
          ) {
            throw new QueuedCommentMutationError(
              "queued_comment_already_dispatching",
              "The queued message is already being dispatched",
            );
          } else {
            throw new QueuedCommentMutationError("queued_comment_not_pending", "The queued message is no longer pending");
          }

          const activeRunId = state === "deferred" ? targetRunId : null;
          const activeRunRow = activeRunId
            ? await tx
                .select()
                .from(heartbeatRuns)
                .where(
                  and(
                    eq(heartbeatRuns.id, activeRunId),
                    eq(heartbeatRuns.companyId, companyId),
                    eq(heartbeatRuns.status, "running"),
                  ),
                )
                .for("update")
                .limit(1)
                .then((rows) => rows[0] ?? null)
            : null;
          const activeRunContext = parseObject(activeRunRow?.contextSnapshot);
          if (!activeRunRow || (activeRunContext.issueId !== issue.id && activeRunContext.taskId !== issue.id)) {
            throw new QueuedCommentMutationError("queued_comment_stale_target", "The queued message targets a stale run");
          }

          const lockedQueue = await transaction.buildQueueSnapshot({
            issue,
            actor,
            wake: toWakeRow(wakeRow),
            state,
            queueRun: queueRunRow ? toRunRow(queueRunRow) : null,
            activeRun: toRunRow(activeRunRow),
          });

          const runResult = parseObject(activeRunRow.resultJson);
          const acknowledgements = parseObject(runResult.queuedSteeringAcknowledgements);
          const priorAcknowledgement = parseObject(acknowledgements[commentId]);
          if (priorAcknowledgement.status === "acknowledged" && priorAcknowledgement.queueId === queueId) {
            duplicate = true;
            turnId = typeof priorAcknowledgement.turnId === "string" ? priorAcknowledgement.turnId : null;
            return lockedQueue;
          }

          requireMutationTarget(lockedQueue, queueId, revision);
          if (lockedQueue.protocol !== "paperclip_runner_v1") {
            throw new QueuedCommentMutationError("steering_unsupported", "This runner does not support same-turn steering");
          }
          const entry = lockedQueue.entries.find((candidate) => candidate.comment.id === commentId);
          if (!entry) {
            throw new QueuedCommentMutationError("queued_comment_not_pending", "The queued message is no longer pending");
          }

          steeringDeliveryAttempted = true;
          const acknowledgement =
            (steeringIdentity ? await storedSteeringAcknowledgement(tx, steeringIdentity) : null) ??
            (await steerNativeSession({
              runId: activeRunRow.id,
              message: entry.comment.body,
              correlationId: commentId,
              onAcknowledged: steeringIdentity ? () => reconcileSteeredIdentity(db, steeringIdentity) : undefined,
            }));
          if (steeringIdentity) await acceptSteeredIdentity(tx, steeringIdentity);
          turnId = acknowledgement.turnId;

          const remainingIds = lockedQueue.entries.map((candidate) => candidate.comment.id).filter((candidateId) => candidateId !== commentId);
          let nextWakeRow: WakeRow | null;
          if (remainingIds.length === 0) {
            await tx
              .update(agentWakeupRequests)
              .set({ status: "cancelled", finishedAt: now, updatedAt: now })
              .where(and(eq(agentWakeupRequests.id, wakeRow.id), eq(agentWakeupRequests.companyId, companyId)));
            nextWakeRow = null;
          } else {
            nextWakeRow = await tx
              .update(agentWakeupRequests)
              .set({ payload: withQueuedCommentIdsInWakePayload(wakeRow.payload, remainingIds), updatedAt: now })
              .where(and(eq(agentWakeupRequests.id, wakeRow.id), eq(agentWakeupRequests.companyId, companyId)))
              .returning()
              .then((rows) => rows[0] ?? wakeRow);
          }

          await tx
            .update(heartbeatRuns)
            .set({
              resultJson: {
                ...runResult,
                queuedSteeringAcknowledgements: {
                  ...acknowledgements,
                  [commentId]: {
                    status: "acknowledged",
                    queueId,
                    turnId: acknowledgement.turnId,
                    acknowledgedAt: now.toISOString(),
                  },
                },
              },
              updatedAt: now,
            })
            .where(and(eq(heartbeatRuns.id, activeRunRow.id), eq(heartbeatRuns.companyId, companyId)));

          return transaction.buildQueueSnapshot({
            issue,
            actor,
            wake: nextWakeRow ? toWakeRow(nextWakeRow) : null,
            state: nextWakeRow ? "deferred" : null,
            queueRun: null,
            activeRun: toRunRow(activeRunRow),
          });
        });
        return { queue, turnId, duplicate };
      } catch (error) {
        // A late native acknowledgement can arrive after this transaction
        // rolls back. Only a delivery attempt with a still-unknown outcome
        // keeps the identity reservation pending for later reconciliation.
        // A definite provider answer never keeps it pending.
        const uncertain =
          steeringDeliveryAttempted &&
          (!(error instanceof NativeSessionSteeringError) || error.code === "steering_timeout");
        if (steeringIdentity && !uncertain) {
          await rejectSteeredIdentity(db, steeringIdentity);
        }
        throw error;
      }
    },
  };
}
