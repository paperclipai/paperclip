import { instanceSettingsService } from "../../../services/instance-settings.js";
import { currentConversationCommentCondition } from "../../../services/agent-conversations.js";
import { getExecutionBlocker } from "../../../services/execution-blocker.js";
import { and, asc, eq, inArray, isNull, notInArray, or, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  agentWakeupRequests,
  agents,
  chatActions,
  heartbeatRuns,
  issueComments,
  issueRecoveryActions,
  issueRelations,
  issues,
  nativeRunFinalizations,
} from "@paperclipai/db";
import { hasConversationContinuationPolicy } from "../../../services/conversation-continuation.js";
import { legacyExecutionNeedsReconciliation } from "../../../services/legacy-execution-recovery.js";
import {
  authorizeFailedChatRunRetryWake,
  FailedChatRunRetryAuthorizationError,
} from "../../../services/durable-chat-wakeup.js";
import { isRetiredExternalChatQuestionSource } from "../../../services/question-response-delivery.js";
import { HttpError } from "../../../errors.js";
import { evaluateAgentInvokabilityFromDb } from "../../../services/agent-invokability.js";
import { issueTreeControlService, isVerifiedIssueTreeControlInteractionWake } from "../../../services/issue-tree-control.js";
import { isAutomaticRecoverySuppressedByPauseHold } from "../../../services/recovery/pause-hold-guard.js";
import { classifyContinuationFailure } from "../../../services/recovery/service.js";
import { issueService } from "../../../services/issues.js";
import { issueRecoveryActionService } from "../../../services/issue-recovery-actions.js";
import { readContinuationAttempt } from "../../../services/recovery/run-liveness-continuations.js";
import { withRecoveryContext } from "../../../services/recovery/status-only-context.js";
import { parseIssueExecutionState } from "../../../services/issue-execution-policy.js";
import {
  queuedCommentIdsFromWakePayload,
  withQueuedCommentIdsInWakePayload,
} from "../../../services/issue-queued-comment-queue.js";
import { extractWakeCommentIds } from "../../run-dispatch/index.js";
import { hasInteractionContinuationWakeContext } from "../domain/context.js";
import { decidePreDrain, type PreDrainFacts } from "../domain/policy.js";
import {
  EXECUTION_REVIEW_PARTICIPANT_RECOVERY_RETRY_REASON,
  isConfigurationIncompleteFailedRun,
  isWorkspaceValidationFailedRun,
  parseObject,
  readNonEmptyString,
} from "../domain/values.js";
import { requireTransactionScopeTx, TransactionScope } from "../application/ports.js";
import type {
  DeferredWakeCandidate,
  InvokableAgentSnapshot,
  IssueLockWriter,
  IssueSnapshot,
  LockedIssueExecution,
  ReleaseTransactionResult,
  RunSnapshot,
  WakeAdmissionReader,
  WakeAdmissionWriter,
  WakeQueueHost,
  WakeQueueTransaction,
} from "../application/ports.js";
import type { RunSummary } from "../application/types.js";

const DEFERRED_WAKE_STATUS = "deferred_issue_execution";
const DEFERRED_WAKE_CONTEXT_KEY = "_paperclipWakeContext";
const EXECUTION_PATH_HEARTBEAT_RUN_STATUSES = ["queued", "running", "scheduled_retry"] as const;

type HeartbeatRunRow = typeof heartbeatRuns.$inferSelect;
type IssueRow = typeof issues.$inferSelect;

function normalizeAgentNameKey(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  return normalized.length > 0 ? normalized : null;
}

function toRequestedByActorType(value: string | null): "user" | "agent" | "system" | null {
  // The database column is free text; map any value outside the union to
  // null instead of widening the type back to string.
  return value === "user" || value === "agent" || value === "system" ? value : null;
}

function toRunSnapshot(row: HeartbeatRunRow): RunSnapshot {
  const configurationIncompletePayload = parseObject(parseObject(row.resultJson).configurationIncomplete);
  return {
    id: row.id,
    companyId: row.companyId,
    agentId: row.agentId,
    status: row.status,
    runtimeMode: row.runtimeMode,
    conversationContinuation: row.runtimeMode === "legacy" && hasConversationContinuationPolicy(row.resultJson),
    errorCode: row.errorCode,
    responsibleUserId: row.responsibleUserId,
    contextSnapshot: parseObject(row.contextSnapshot),
    configurationIncompletePayload: Object.keys(configurationIncompletePayload).length > 0 ? configurationIncompletePayload : null,
  };
}

function toIssueSnapshot(row: IssueRow): IssueSnapshot {
  return {
    conversationAgentId: row.conversationAgentId,
    conversationUserId: row.conversationUserId,
    conversationState: row.conversationState,
    id: row.id,
    companyId: row.companyId,
    identifier: row.identifier ?? "",
    status: row.status,
    assigneeAgentId: row.assigneeAgentId,
    assigneeUserId: row.assigneeUserId,
    hiddenAt: row.hiddenAt,
    originKind: row.originKind,
    monitorNextCheckAt: row.monitorNextCheckAt,
    executionState: (row.executionState as Record<string, unknown> | null) ?? null,
    responsibleUserId: row.responsibleUserId,
    parentId: row.parentId,
    originId: row.originId,
    originRunId: row.originRunId,
  };
}

function toRunSummary(row: HeartbeatRunRow): RunSummary {
  return {
    id: row.id,
    companyId: row.companyId,
    agentId: row.agentId,
    invocationSource: row.invocationSource,
    triggerDetail: row.triggerDetail,
    wakeupRequestId: row.wakeupRequestId,
  };
}

function toDeferredWakeCandidate(row: typeof agentWakeupRequests.$inferSelect): DeferredWakeCandidate {
  const payload = parseObject(row.payload);
  const queuedCommentIds = queuedCommentIdsFromWakePayload(payload);
  const deferredContextSeed = parseObject(payload[DEFERRED_WAKE_CONTEXT_KEY]);
  const deferredCommentIds = extractWakeCommentIds(deferredContextSeed);
  const wakeReason = readNonEmptyString(deferredContextSeed.wakeReason);
  const queuedReason = wakeReason ?? readNonEmptyString(row.reason);
  const queuedWakeIsCommentOnly =
    !queuedReason ||
    queuedReason === "issue_commented" ||
    queuedReason === "issue_reopened_via_comment" ||
    queuedReason === "issue_comment_mentioned";
  const preservesIndependentContinuation =
    hasInteractionContinuationWakeContext(deferredContextSeed) ||
    deferredContextSeed.resumeIntent === true ||
    !queuedWakeIsCommentOnly;

  return {
    id: row.id,
    companyId: row.companyId,
    agentId: row.agentId,
    reason: row.reason,
    source: row.source,
    triggerDetail: row.triggerDetail,
    requestedByActorType: toRequestedByActorType(row.requestedByActorType),
    requestedByActorId: row.requestedByActorId,
    payload,
    queuedCommentIds,
    preservesIndependentContinuation,
    deferredContextSeed,
    deferredCommentIds,
    wakeReason,
  };
}

export type WakeQueuePostgresAdapterDeps = {
  resolveResponsibleUserId: WakeQueueHost["resolveResponsibleUserId"];
  getRoutineEnv: WakeQueueHost["getRoutineEnv"];
  resolveSessionBeforeForWakeup: WakeQueueHost["resolveSessionBeforeForWakeup"];
};

function buildHost(_tx: Db, deps: WakeQueuePostgresAdapterDeps): WakeQueueHost {
  return {
    resolveResponsibleUserId: deps.resolveResponsibleUserId,
    getRoutineEnv: deps.getRoutineEnv,
    resolveSessionBeforeForWakeup: deps.resolveSessionBeforeForWakeup,
  };
}

function buildTransaction(tx: Db, deps: WakeQueuePostgresAdapterDeps, db: Db, run: HeartbeatRunRow): WakeQueueTransaction {
  const treeControlSvc = issueTreeControlService(tx);
  const issuesSvc = issueService(tx);
  const interruptQueueId = run.runtimeMode !== "native" && run.status === "cancelled"
    ? readNonEmptyString(run.resultJson?.queuedCommentInterruptQueueId)
    : null;

  return {
    async findInvokableAgent({ companyId, agentId }): Promise<InvokableAgentSnapshot | null> {
      const agent = await tx
        .select()
        .from(agents)
        .where(and(eq(agents.id, agentId), eq(agents.companyId, companyId)))
        .then((rows) => rows[0] ?? null);
      if (!agent) return null;
      const invokability = await evaluateAgentInvokabilityFromDb(tx, agent);
      return { id: agent.id, companyId: agent.companyId, name: agent.name, invokable: invokability.invokable };
    },

    async findNextDeferredWake({ companyId, issueId }) {
      while (true) {
        const row = await tx
          .select()
          .from(agentWakeupRequests)
          .where(
            and(
              eq(agentWakeupRequests.companyId, companyId),
              eq(agentWakeupRequests.status, DEFERRED_WAKE_STATUS),
              sql`${agentWakeupRequests.payload} ->> 'issueId' = ${issueId}`,
              interruptQueueId ? eq(agentWakeupRequests.id, interruptQueueId) : undefined,
              interruptQueueId ? eq(agentWakeupRequests.agentId, run.agentId) : undefined,
            ),
          )
          .orderBy(asc(agentWakeupRequests.requestedAt))
          .limit(1)
          .then((rows) => rows[0] ?? null);
        if (!row) return null;
        const candidate = toDeferredWakeCandidate(row);
        try {
          const authorizedFailedChatRetry = await authorizeFailedChatRunRetryWake(
            db,
            tx,
            {
              phase: "promotion",
              wakeupRequestId: row.id,
              companyId,
              agentId: row.agentId,
              issueId,
              contextSnapshot: candidate.deferredContextSeed,
            },
          );
          return { ...candidate, authorizedFailedChatRetry };
        } catch (error) {
          // Retire only a proven denial. Transient failures roll back this
          // transaction instead of discarding otherwise authorized work.
          if (
            !(error instanceof FailedChatRunRetryAuthorizationError) &&
            !(
              error instanceof HttpError &&
              error.status >= 400 &&
              error.status < 500
            )
          ) {
            throw error;
          }
          const now = new Date();
          await tx
            .update(agentWakeupRequests)
            .set({
              status: "cancelled",
              finishedAt: now,
              error:
                "The exact failed chat request is no longer authorized. Send a new request in the current connected conversation.",
              updatedAt: now,
            })
            .where(
              and(
                eq(agentWakeupRequests.companyId, companyId),
                eq(agentWakeupRequests.id, row.id),
                eq(agentWakeupRequests.status, DEFERRED_WAKE_STATUS),
              ),
            );
        }
      }
    },

    async getQueuedCommentLiveness({ companyId, issueId, wakeAgentId, finishingRunId, finishingRunAgentId, queuedCommentIds }) {
      const rows = await tx
        .select({ id: issueComments.id, deletedAt: issueComments.deletedAt, createdByRunId: issueComments.createdByRunId })
        .from(issueComments)
        .where(and(eq(issueComments.companyId, companyId), eq(issueComments.issueId, issueId), inArray(issueComments.id, queuedCommentIds), currentConversationCommentCondition()));
      const targetsFinishingRunAgent = wakeAgentId === finishingRunAgentId;
      const liveNonSelfCommentIds = queuedCommentIds.filter((commentId) => {
        const row = rows.find((candidate) => candidate.id === commentId);
        return Boolean(row && !row.deletedAt && (!targetsFinishingRunAgent || row.createdByRunId !== finishingRunId));
      });
      const containedSelfAuthoredComment = rows.some(
        (row) => targetsFinishingRunAgent && !row.deletedAt && row.createdByRunId === finishingRunId,
      );
      return { liveNonSelfCommentIds, containedSelfAuthoredComment };
    },

    async cancelDeferredWake({ companyId, wakeId, reason, now }) {
      const rows = await tx
        .update(agentWakeupRequests)
        .set({ status: "cancelled", finishedAt: now, error: reason, updatedAt: now })
        .where(
          and(
            eq(agentWakeupRequests.id, wakeId),
            eq(agentWakeupRequests.companyId, companyId),
            eq(agentWakeupRequests.status, DEFERRED_WAKE_STATUS),
          ),
        )
        .returning({ id: agentWakeupRequests.id });
      return rows.length > 0;
    },

    async normalizeDeferredWakeCommentIds({ companyId, wakeId, payload, liveCommentIds, now }) {
      const rows = await tx
        .update(agentWakeupRequests)
        .set({ payload: withQueuedCommentIdsInWakePayload(payload, liveCommentIds), updatedAt: now })
        .where(
          and(
            eq(agentWakeupRequests.id, wakeId),
            eq(agentWakeupRequests.companyId, companyId),
            eq(agentWakeupRequests.status, DEFERRED_WAKE_STATUS),
          ),
        )
        .returning();
      const row = rows[0];
      return row ? toDeferredWakeCandidate(row) : null;
    },

    async failDeferredWake({ companyId, wakeId, now }) {
      const rows = await tx
        .update(agentWakeupRequests)
        .set({
          status: "failed",
          finishedAt: now,
          error: "Deferred wake could not be promoted: agent is not invokable",
          updatedAt: now,
        })
        .where(
          and(
            eq(agentWakeupRequests.id, wakeId),
            eq(agentWakeupRequests.companyId, companyId),
            eq(agentWakeupRequests.status, DEFERRED_WAKE_STATUS),
          ),
        )
        .returning({ id: agentWakeupRequests.id });
      return rows.length > 0;
    },

    async getPauseHoldFacts({ companyId, issueId, wakeAgentId, deferredContextSeed, requestedByActorType, requestedByActorId }) {
      const activePauseHold = await treeControlSvc.getActivePauseHoldGate(companyId, issueId);
      if (!activePauseHold) {
        return {
          activePauseHold: false,
          treeHoldInteractionWake: false,
          holdId: null,
          rootIssueId: null,
          mode: null,
          reason: null,
          releasePolicy: null,
        };
      }
      const treeHoldInteractionWake = await isVerifiedIssueTreeControlInteractionWake(tx, {
        companyId,
        issueId,
        agentId: wakeAgentId,
        contextSnapshot: deferredContextSeed,
        requestedByActorType,
        requestedByActorId,
      });
      return {
        activePauseHold: true,
        treeHoldInteractionWake,
        holdId: activePauseHold.holdId,
        rootIssueId: activePauseHold.rootIssueId,
        mode: activePauseHold.mode,
        reason: activePauseHold.reason,
        releasePolicy: activePauseHold.releasePolicy,
      };
    },

    async getCommentSelfAuthorship({ companyId, issueId, finishingRunId, commentIds }) {
      const rows = await tx
        .select({ createdByRunId: issueComments.createdByRunId })
        .from(issueComments)
        .where(and(eq(issueComments.companyId, companyId), eq(issueComments.issueId, issueId), inArray(issueComments.id, commentIds)));
      return { allSelfAuthored: rows.length > 0 && rows.every((row) => row.createdByRunId === finishingRunId) };
    },

    async reopenIssue({ companyId, issueId }) {
      const updated = await issuesSvc.updateForCompany(issueId, companyId, { status: "todo", executionState: null }, tx);
      return updated ? toIssueSnapshot(updated as unknown as IssueRow) : null;
    },

    async claimDeferredWakeForPromotion({ companyId, wakeId, now }) {
      const claimed = await tx
        .update(agentWakeupRequests)
        .set({
          status: "queued",
          reason: "issue_execution_promoted",
          claimedAt: null,
          finishedAt: null,
          error: null,
          updatedAt: now,
        })
        .where(
          and(
            eq(agentWakeupRequests.id, wakeId),
            eq(agentWakeupRequests.companyId, companyId),
            eq(agentWakeupRequests.status, DEFERRED_WAKE_STATUS),
          ),
        )
        .returning({ id: agentWakeupRequests.id });
      return claimed.length > 0;
    },

    async finalizePromotedWake(input) {
      const newRun = await tx
        .insert(heartbeatRuns)
        .values({
          companyId: input.deferredAgent.companyId,
          agentId: input.deferredAgent.id,
          invocationSource: input.source,
          triggerDetail: input.triggerDetail,
          status: "queued",
          wakeupRequestId: input.wakeId,
          retryOfRunId: input.authorizedFailedChatRetry
            ? readNonEmptyString(input.contextSnapshot.retryOfRunId)
            : null,
          contextSnapshot: input.contextSnapshot,
          responsibleUserId: input.responsibleUserId,
          sessionIdBefore: input.sessionBefore,
          continuationAttempt: readContinuationAttempt(input.contextSnapshot.livenessContinuationAttempt),
        })
        .returning()
        .then((rows) => rows[0]);

      // `claimDeferredWakeForPromotion` already moved this row off
      // `deferred_issue_execution` inside this same transaction, so no
      // concurrent claimer can still match that guard; this extra `runId is
      // null` guard only protects against writing the link twice.
      await tx
        .update(agentWakeupRequests)
        .set({ runId: newRun.id, updatedAt: input.now })
        .where(
          and(
            eq(agentWakeupRequests.id, input.wakeId),
            eq(agentWakeupRequests.companyId, input.companyId),
            isNull(agentWakeupRequests.runId),
          ),
        );

      // Promoted mention wakes are issue-scoped, not issue ownership
      // transfers. The lock-clearing step earlier in this transaction
      // already set `executionRunId` to null for this issue, so the `is
      // null` guard only protects against taking the lock twice.
      await tx
        .update(issues)
        .set({
          executionRunId: newRun.id,
          executionAgentNameKey: normalizeAgentNameKey(input.deferredAgent.name),
          executionLockedAt: input.now,
          updatedAt: input.now,
        })
        .where(
          and(
            eq(issues.id, input.issue.id),
            eq(issues.companyId, input.companyId),
            eq(issues.assigneeAgentId, input.deferredAgent.id),
            isNull(issues.executionRunId),
          ),
        );

      return toRunSummary(newRun);
    },

    async hasExistingExecutionPath({ companyId, issueId, excludeRunId, agentId }) {
      const row = await tx
        .select({ id: heartbeatRuns.id })
        .from(heartbeatRuns)
        .where(
          and(
            eq(heartbeatRuns.companyId, companyId),
            inArray(heartbeatRuns.status, [...EXECUTION_PATH_HEARTBEAT_RUN_STATUSES]),
            sql`${heartbeatRuns.contextSnapshot} ->> 'issueId' = ${issueId}`,
            sql`${heartbeatRuns.id} <> ${excludeRunId}`,
            agentId ? eq(heartbeatRuns.agentId, agentId) : sql`true`,
          ),
        )
        .limit(1)
        .then((rows) => rows[0] ?? null);
      return row !== null;
    },

    async hasExplicitBlockerPath({ companyId, issueId }) {
      const row = await tx
        .select({ issueId: issueRelations.issueId })
        .from(issueRelations)
        .innerJoin(issues, eq(issueRelations.issueId, issues.id))
        .where(
          and(
            eq(issueRelations.companyId, companyId),
            eq(issueRelations.relatedIssueId, issueId),
            eq(issueRelations.type, "blocks"),
            eq(issues.companyId, companyId),
            notInArray(issues.status, ["done", "cancelled"]),
            isNull(issues.hiddenAt),
          ),
        )
        .limit(1)
        .then((rows) => rows[0] ?? null);
      return row !== null;
    },

    async isAutomaticRecoverySuppressedByPauseHold({ companyId, issueId }) {
      return isAutomaticRecoverySuppressedByPauseHold(tx, companyId, issueId, treeControlSvc);
    },

    async isImmediateRecoverySourceBlocked({ companyId, runId }) {
      if (companyId !== run.companyId || runId !== run.id) {
        throw new Error(
          "wake-queue: recovery source does not match the locked execution",
        );
      }
      const failedChatRequestOwner = run.wakeupRequestId
        ? await tx
            .select({ id: chatActions.id })
            .from(chatActions)
            .where(
              and(
                eq(chatActions.id, run.wakeupRequestId),
                eq(chatActions.companyId, run.companyId),
                inArray(chatActions.kind, ["inbound_wakeup", "failed_run_retry"]),
              ),
            )
            .limit(1)
            .then((rows) => rows[0] ?? null)
        : null;
      return (
        Boolean(failedChatRequestOwner) ||
        run.errorCode === "chat_failed_run_retry_not_authorized" ||
        classifyContinuationFailure(run).kind === "non_retryable"
      );
    },

    async queueReviewParticipantRecoveryRun({ companyId, issue, finishingRun, recoveryAgent, sessionBefore, now }) {
      const executionState = parseIssueExecutionState(issue.executionState);
      const wakeupRequest = await tx
        .insert(agentWakeupRequests)
        .values({
          companyId,
          agentId: recoveryAgent.id,
          source: "automation",
          triggerDetail: "system",
          reason: EXECUTION_REVIEW_PARTICIPANT_RECOVERY_RETRY_REASON,
          payload: withRecoveryContext(
            {
              issueId: issue.id,
              retryOfRunId: finishingRun.id,
              retryReason: EXECUTION_REVIEW_PARTICIPANT_RECOVERY_RETRY_REASON,
              currentStageId: executionState?.currentStageId ?? null,
              currentStageType: executionState?.currentStageType ?? null,
            },
            "normal_model",
          ),
          status: "queued",
          requestedByActorType: "system",
          requestedByActorId: null,
          updatedAt: now,
        })
        .returning()
        .then((rows) => rows[0]);

      const queuedRun = await tx
        .insert(heartbeatRuns)
        .values({
          companyId,
          agentId: recoveryAgent.id,
          invocationSource: "automation",
          triggerDetail: "system",
          status: "queued",
          wakeupRequestId: wakeupRequest.id,
          contextSnapshot: withRecoveryContext(
            {
              issueId: issue.id,
              taskId: issue.id,
              wakeReason: EXECUTION_REVIEW_PARTICIPANT_RECOVERY_RETRY_REASON,
              retryReason: EXECUTION_REVIEW_PARTICIPANT_RECOVERY_RETRY_REASON,
              source: "issue.execution_review_recovery",
              retryOfRunId: finishingRun.id,
              currentStageId: executionState?.currentStageId ?? null,
              currentStageType: executionState?.currentStageType ?? null,
              reviewRecoveryInstruction:
                "The previous reviewer run ended while this execution-review stage was still pending. Submit the review decision now, or mark the issue blocked with the exact unblock action.",
            },
            "normal_model",
          ),
          sessionIdBefore: sessionBefore,
          retryOfRunId: finishingRun.id,
          updatedAt: now,
        })
        .returning()
        .then((rows) => rows[0]);

      await tx
        .update(agentWakeupRequests)
        .set({ runId: queuedRun.id, updatedAt: now })
        .where(and(eq(agentWakeupRequests.id, wakeupRequest.id), eq(agentWakeupRequests.companyId, companyId)));

      await tx
        .update(issues)
        .set({
          executionRunId: queuedRun.id,
          executionAgentNameKey: normalizeAgentNameKey(recoveryAgent.name),
          executionLockedAt: now,
          updatedAt: now,
        })
        .where(and(eq(issues.id, issue.id), eq(issues.companyId, companyId)));

      return toRunSummary(queuedRun);
    },

    async queueImmediateRecoveryRun({
      companyId,
      issue,
      finishingRun,
      recoveryAgent,
      reason,
      contextSnapshot,
      responsibleUserId,
      sessionBefore,
      now,
    }) {
      const wakeupRequest = await tx
        .insert(agentWakeupRequests)
        .values({
          companyId,
          agentId: recoveryAgent.id,
          source: "automation",
          triggerDetail: "system",
          reason,
          payload: withRecoveryContext({ issueId: issue.id, retryOfRunId: finishingRun.id }, "normal_model"),
          status: "queued",
          requestedByActorType: "system",
          requestedByActorId: null,
          updatedAt: now,
        })
        .returning()
        .then((rows) => rows[0]);

      const queuedRun = await tx
        .insert(heartbeatRuns)
        .values({
          companyId,
          agentId: recoveryAgent.id,
          invocationSource: "automation",
          triggerDetail: "system",
          status: "queued",
          wakeupRequestId: wakeupRequest.id,
          contextSnapshot,
          responsibleUserId,
          sessionIdBefore: sessionBefore,
          retryOfRunId: finishingRun.id,
          updatedAt: now,
        })
        .returning()
        .then((rows) => rows[0]);

      await tx
        .update(agentWakeupRequests)
        .set({ runId: queuedRun.id, updatedAt: now })
        .where(and(eq(agentWakeupRequests.id, wakeupRequest.id), eq(agentWakeupRequests.companyId, companyId)));

      await tx
        .update(issues)
        .set({
          executionRunId: queuedRun.id,
          executionAgentNameKey: normalizeAgentNameKey(recoveryAgent.name),
          executionLockedAt: now,
          updatedAt: now,
        })
        .where(and(eq(issues.id, issue.id), eq(issues.companyId, companyId)));

      return toRunSummary(queuedRun);
    },
  };
}

async function recordNativeTerminalRecoveryIfNeeded(tx: Db, run: HeartbeatRunRow, issue: IssueRow, now: Date): Promise<boolean> {
  const applies =
    run.runtimeMode === "native" &&
    ["failed", "timed_out", "interrupted", "cancelled"].includes(run.status) &&
    issue.assigneeAgentId === run.agentId &&
    !["done", "cancelled"].includes(issue.status);
  if (!applies) return false;

  const existing = await tx
    .select({ id: issueRecoveryActions.id })
    .from(issueRecoveryActions)
    .where(
      and(
        eq(issueRecoveryActions.companyId, issue.companyId),
        eq(issueRecoveryActions.sourceIssueId, issue.id),
        or(
          inArray(issueRecoveryActions.status, ["active", "escalated"]),
          sql`${issueRecoveryActions.evidence}->'automaticRecovery'->>'runId' = ${run.id}`,
        ),
      ),
    )
    .limit(1);
  if (!existing.length) {
    await tx
      .update(nativeRunFinalizations)
      .set({
        phase: "terminal_failure",
        leaseOwner: null,
        leaseExpiresAt: null,
        nextAttemptAt: null,
        recoveryState: "blocked",
        failureCode: "native_continuation_requires_reconciliation",
        updatedAt: now,
      })
      .where(
        and(
          eq(nativeRunFinalizations.companyId, issue.companyId),
          eq(nativeRunFinalizations.runId, run.id),
          isNull(nativeRunFinalizations.resultId),
        ),
      );
    await issueRecoveryActionService(tx).upsertSourceScoped({
      companyId: issue.companyId,
      sourceIssueId: issue.id,
      kind: "active_run_watchdog",
      ownerType: "board",
      returnOwnerAgentId: run.agentId,
      cause: "native_continuation_requires_reconciliation",
      fingerprint: `native-continuation:${run.id}`,
      evidence: { runId: run.id, originalFailureCode: run.errorCode },
      nextAction:
        "Inspect the original failure and reconcile the previous execution before continuing. Automatic recovery cannot start another incident.",
      maxAttempts: 3,
      wakePolicy: null,
      supersedeOnIdentityChange: true,
    });
  }
  return true;
}

/**
 * Builds the temporary transaction-scope handle the admission port needs.
 * `heartbeat.ts` calls this through `createWakeQueue`'s own wrapper; it
 * never builds a `TransactionScope` itself.
 */
export function createAdmissionTransactionScope(companyId: string, tx: Db): TransactionScope {
  return TransactionScope.create(companyId, tx);
}

function requireAdmissionTx(scope: TransactionScope | null | undefined, companyId: string): Db {
  return requireTransactionScopeTx(scope, companyId) as Db;
}

export function createWakeAdmissionReader(): WakeAdmissionReader {
  return {
    async matchesActiveWakeActor(scope, input) {
      const tx = requireAdmissionTx(scope, input.companyId);
      if (!input.wakeupRequestId) return false;
      const actor = await tx
        .select({
          type: agentWakeupRequests.requestedByActorType,
          id: agentWakeupRequests.requestedByActorId,
        })
        .from(agentWakeupRequests)
        .where(
          and(
            eq(agentWakeupRequests.companyId, input.companyId),
            eq(agentWakeupRequests.id, input.wakeupRequestId),
          ),
        )
        .limit(1)
        .then((rows) => rows[0] ?? null);
      return (
        actor !== null &&
        actor.type === input.requestedByActorType &&
        actor.id === input.requestedByActorId
      );
    },
    async isSameExecutionAgent(
      scope,
      {
        companyId,
        activeExecutionRunAgentId,
        issueExecutionAgentNameKey,
        agentNameKey,
      },
    ) {
      const tx = requireAdmissionTx(scope, companyId);
      const executionAgent = await tx
        .select({ name: agents.name })
        .from(agents)
        .where(
          and(
            eq(agents.id, activeExecutionRunAgentId),
            eq(agents.companyId, companyId),
          ),
        )
        .then((rows) => rows[0] ?? null);
      const executionAgentNameKey =
        normalizeAgentNameKey(issueExecutionAgentNameKey) ??
        normalizeAgentNameKey(executionAgent?.name);
      return (
        Boolean(executionAgentNameKey) && executionAgentNameKey === agentNameKey
      );
    },

    async findExistingDeferredWake(
      scope,
      { companyId, agentId, issueId, durableActor },
    ) {
      const tx = requireAdmissionTx(scope, companyId);
      const row = await tx
        .select()
        .from(agentWakeupRequests)
        .where(
          and(
            eq(agentWakeupRequests.companyId, companyId),
            eq(agentWakeupRequests.agentId, agentId),
            eq(agentWakeupRequests.status, DEFERRED_WAKE_STATUS),
            sql`${agentWakeupRequests.payload} ->> 'issueId' = ${issueId}`,
            ...(durableActor
              ? [
                  durableActor.type === null
                    ? isNull(agentWakeupRequests.requestedByActorType)
                    : eq(
                        agentWakeupRequests.requestedByActorType,
                        durableActor.type,
                      ),
                  durableActor.id === null
                    ? isNull(agentWakeupRequests.requestedByActorId)
                    : eq(
                        agentWakeupRequests.requestedByActorId,
                        durableActor.id,
                      ),
                ]
              : []),
          ),
        )
        .orderBy(asc(agentWakeupRequests.requestedAt))
        .limit(1)
        .then((rows) => rows[0] ?? null);
      if (!row) return null;
      const payload = parseObject(row.payload);
      return {
        id: row.id,
        runId: row.runId,
        payload,
        deferredContext: parseObject(payload[DEFERRED_WAKE_CONTEXT_KEY]),
        coalescedCount: row.coalescedCount,
      };
    },
  };
}

export function createWakeAdmissionWriter(): WakeAdmissionWriter {
  return {
    async coalesceIntoActiveExecutionRun(scope, input) {
      const tx = requireAdmissionTx(scope, input.companyId);
      const now = new Date();
      const mergedRun = await tx
        .update(heartbeatRuns)
        .set({ contextSnapshot: input.mergedContextSnapshot, updatedAt: now })
        .where(
          and(
            eq(heartbeatRuns.id, input.activeExecutionRunId),
            eq(heartbeatRuns.companyId, input.companyId),
          ),
        )
        .returning()
        .then((rows) => rows[0] ?? null);
      if (!mergedRun) {
        // The compare-and-set write affected no row. Throw to roll the
        // transaction back instead of recording a coalesced wake against a
        // run this write never touched.
        throw new Error(
          "wake-queue: the coalesce target run was not found for this company",
        );
      }
      await tx.insert(agentWakeupRequests).values({
        ...input.durableReceipt,
        companyId: input.companyId,
        agentId: input.agentId,
        source: input.source,
        triggerDetail: input.triggerDetail,
        reason: "issue_execution_same_name",
        payload: input.payload,
        status: "coalesced",
        coalescedCount: 1,
        requestedByActorType: input.requestedByActorType,
        requestedByActorId: input.requestedByActorId,
        idempotencyKey: input.idempotencyKey,
        runId: mergedRun.id,
        finishedAt: now,
      });
      return mergedRun as unknown as Record<string, unknown>;
    },

    async mergeIntoExistingDeferredWake(scope, input) {
      const tx = requireAdmissionTx(scope, input.companyId);
      const rows = await tx
        .update(agentWakeupRequests)
        .set({
          payload: input.mergedPayload,
          coalescedCount: input.nextCoalescedCount,
          ...(input.manualUserWakeActorId ? {
            requestedByActorType: "user",
            requestedByActorId: input.manualUserWakeActorId,
          } : {}),
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(agentWakeupRequests.id, input.existingDeferredWakeId),
            eq(agentWakeupRequests.companyId, input.companyId),
            eq(agentWakeupRequests.status, DEFERRED_WAKE_STATUS),
          ),
        )
        .returning({ id: agentWakeupRequests.id });
      if (rows.length === 0) {
        // The compare-and-set write affected no row: a concurrent writer
        // already moved this wake off `deferred_issue_execution`. Roll the
        // transaction back instead of leaving the merge half-applied.
        throw new Error(
          "wake-queue: the deferred wake to merge into was not found for this company",
        );
      }
      if (input.coalescedReceipt) {
        await tx.insert(agentWakeupRequests).values({
          ...input.coalescedReceipt,
          companyId: input.companyId,
          status: "coalesced",
          coalescedCount: 1,
          finishedAt: new Date(),
        });
      }
    },

    async insertNewDeferredWake(scope, input) {
      const tx = requireAdmissionTx(scope, input.companyId);
      await tx.insert(agentWakeupRequests).values({
        ...input.durableReceipt,
        companyId: input.companyId,
        agentId: input.agentId,
        source: input.source,
        triggerDetail: input.triggerDetail,
        reason: "issue_execution_deferred",
        payload: input.payload,
        status: DEFERRED_WAKE_STATUS,
        requestedByActorType: input.requestedByActorType,
        requestedByActorId: input.requestedByActorId,
        idempotencyKey: input.idempotencyKey,
      });
    },
  };
}

export function createPostgresWakeQueueAdapter(db: Db, deps: WakeQueuePostgresAdapterDeps): IssueLockWriter {
  return {
    async withIssueExecutionLock(input, fn): Promise<ReleaseTransactionResult & { run: RunSnapshot }> {
      return db.transaction(async (rawTx) => {
        const tx = rawTx as unknown as Db;
        const run = await tx
          .select()
          .from(heartbeatRuns)
          .where(and(eq(heartbeatRuns.id, input.runId), eq(heartbeatRuns.companyId, input.companyId)))
          .then((rows) => rows[0] ?? null);
        if (!run) {
          throw new Error(`wake-queue: run ${input.runId} was not found while releasing issue execution`);
        }
        const runSnapshot = toRunSnapshot(run);
        const contextIssueId = readNonEmptyString(parseObject(run.contextSnapshot).issueId);

        // Lock the context issue (if any) and every issue that still references this
        // run, in id order, so two concurrent finalizations can never deadlock on
        // each other's row-lock acquisition order.
        await tx.execute(
          contextIssueId
            ? sql`
                select id from issues
                where company_id = ${input.companyId}
                  and (
                    id = ${contextIssueId}
                    or execution_run_id = ${run.id}
                    or checkout_run_id = ${run.id}
                  )
                order by id
                for update
              `
            : sql`
                select id from issues
                where company_id = ${input.companyId}
                  and (execution_run_id = ${run.id} or checkout_run_id = ${run.id})
                order by id
                for update
              `,
        );

        const candidateIssues = await tx
          .select()
          .from(issues)
          .where(
            and(
              eq(issues.companyId, input.companyId),
              contextIssueId
                ? or(eq(issues.id, contextIssueId), eq(issues.executionRunId, run.id), eq(issues.checkoutRunId, run.id))
                : or(eq(issues.executionRunId, run.id), eq(issues.checkoutRunId, run.id)),
            ),
          )
          .orderBy(asc(issues.id));

        // Two separate updates: a retry can move `executionRunId` to a new run
        // while `checkoutRunId` still points at this one finishing.
        await tx
          .update(issues)
          .set({ executionRunId: null, executionAgentNameKey: null, executionLockedAt: null, updatedAt: input.now })
          .where(and(eq(issues.companyId, input.companyId), eq(issues.executionRunId, run.id)));
        await tx
          .update(issues)
          .set({ checkoutRunId: null, updatedAt: input.now })
          .where(and(eq(issues.companyId, input.companyId), eq(issues.checkoutRunId, run.id)));

        const issueRow =
          (contextIssueId ? candidateIssues.find((candidate) => candidate.id === contextIssueId) : candidateIssues[0]) ?? null;

        // A queue interrupt authorizes only its original pending queue. Replays
        // after dispatch or deleting the final message cannot launch other work.
        const interruptQueueId = run.runtimeMode !== "native"
          ? readNonEmptyString(run.resultJson?.queuedCommentInterruptQueueId)
          : null;
        const [interruptedQueue] = interruptQueueId && issueRow
          ? await tx.select({ id: agentWakeupRequests.id }).from(agentWakeupRequests).where(and(
              eq(agentWakeupRequests.id, interruptQueueId),
              eq(agentWakeupRequests.companyId, run.companyId),
              eq(agentWakeupRequests.agentId, run.agentId),
              eq(agentWakeupRequests.status, "deferred_issue_execution"),
              sql`${agentWakeupRequests.payload}->>'issueId' = ${issueRow.id}`,
            )).limit(1)
          : [];
        const preDrainFacts: PreDrainFacts = {
          issueRowPresent: issueRow !== null,
          executionRunIdMatchesRun: !issueRow || !issueRow.executionRunId || issueRow.executionRunId === run.id,
          isWorkspaceValidationFailedRun: isWorkspaceValidationFailedRun(run),
          isConfigurationIncompleteFailedRun: isConfigurationIncompleteFailedRun(run),
          issueStatus: issueRow?.status ?? "",
          hasAssigneeUser: Boolean(issueRow?.assigneeUserId),
          assigneeAgentMatchesRunAgent: issueRow?.assigneeAgentId === run.agentId,
          legacyExecutionNeedsReconciliation: legacyExecutionNeedsReconciliation(run),
          // An operator stop never promotes old queued work by itself. The
          // next explicit wake adopts those messages atomically when it
          // queues a run.
          executionCancellationAcknowledged:
            run.status === "cancelled" &&
            parseObject(run.resultJson?.executionCancellation).state === "acknowledged" &&
            !interruptedQueue,
        };
        const preDrain = decidePreDrain(preDrainFacts);

        if (preDrain.kind === "released") {
          return { outcome: { kind: "released" }, postCommitEffects: [], run: runSnapshot };
        }

        // decidePreDrain only returns "blocked" or "proceed" when the issue row is present.
        if (!issueRow) {
          throw new Error(`wake-queue: pre-drain decision ${preDrain.kind} reached without an issue row`);
        }

        // Enqueue does not stamp executionRunId until dispatch. A concurrent
        // queued successor still owns the next turn, including during a late
        // finalization/stranded-queue retry under this issue lock. Another
        // agent's review participation retains its separate recovery path.
        const [successor] = await tx.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(and(
          eq(heartbeatRuns.companyId, input.companyId),
          eq(heartbeatRuns.agentId, run.agentId),
          sql`${heartbeatRuns.id} <> ${run.id}`,
          or(eq(heartbeatRuns.nativeIssueId, issueRow.id),
            sql`${heartbeatRuns.contextSnapshot}->>'issueId' = ${issueRow.id}`),
          inArray(heartbeatRuns.status, ["queued", "running", "scheduled_retry"]),
        )).limit(1);
        if (successor) return { outcome: { kind: "released" }, postCommitEffects: [], run: runSnapshot };

        if (preDrain.kind === "blocked") {
          return {
            outcome: {
              kind: "blocked",
              issue: toIssueSnapshot(issueRow),
              previousStatus: issueRow.status as "todo" | "in_progress",
              noticeKind: preDrain.noticeKind,
            },
            postCommitEffects: [],
            run: runSnapshot,
          };
        }

        // The durable external answer owns the sole successor of this retired
        // question source; release locks without creating another incident.
        if (
          run.runtimeMode === "native" &&
          run.status === "cancelled" &&
          run.errorCode === "external_chat_continuation" &&
          (await isRetiredExternalChatQuestionSource(tx, {
            companyId: run.companyId,
            issueId: issueRow.id,
            agentId: run.agentId,
            runId: run.id,
          }))
        ) {
          return {
            outcome: { kind: "released" },
            postCommitEffects: [],
            run: runSnapshot,
          };
        }

        if (await recordNativeTerminalRecoveryIfNeeded(tx, run, issueRow, input.now)) {
          return { outcome: { kind: "released" }, postCommitEffects: [], run: runSnapshot };
        }

        // A release must leave deferred messages intact while execution is held.
        // The finishing conversation may still own its lease until finally cleanup.
        // Allow only bounded retry planning in that case; admission stays gated.
        const executionBlocker = await getExecutionBlocker(tx, issueRow.companyId, issueRow.id);
        const recoveryOnly = Boolean(executionBlocker &&
          executionBlocker.cause === "execution_owner_active" && executionBlocker.runId === run.id &&
          runSnapshot.conversationContinuation && ["failed", "timed_out", "interrupted"].includes(run.status));
        if (executionBlocker && !recoveryOnly) {
          return { outcome: { kind: "released" }, postCommitEffects: [], run: runSnapshot };
        }

        // Releases still settle while Agent Chat is disabled, but no deferred
        // turn or recovery successor may be created. Check here in the shared
        // transaction so cleanup retries and restart sweeps use the same gate.
        if (issueRow.conversationAgentId && !(await instanceSettingsService(tx).getExperimental()).enableAgentChat) {
          return { outcome: { kind: "released" }, postCommitEffects: [], run: runSnapshot };
        }

        const locked: LockedIssueExecution = { primaryIssue: toIssueSnapshot(issueRow), run: runSnapshot, recoveryOnly };
        const result = await fn(locked, { host: buildHost(tx, deps), transaction: buildTransaction(tx, deps, db, run) });
        return { ...result, run: runSnapshot };
      });
    },
  };
}
