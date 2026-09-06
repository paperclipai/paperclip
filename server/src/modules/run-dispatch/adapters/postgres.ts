import { and, asc, eq, gte, inArray, lte } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  agentWakeupRequests,
  agents,
  heartbeatRuns,
  issueRecoveryActions,
  issues,
} from "@paperclipai/db";
import { ISSUE_DISPOSITION_REPAIR_RETRY_REASON } from "@paperclipai/shared";
import { parseObject } from "../../../adapters/utils.js";
import { evaluateAgentInvokabilityFromDb } from "../../../services/agent-invokability.js";
import { budgetService } from "../../../services/budgets.js";
import { isHeartbeatWakeOnDemandEnabled } from "../../../services/heartbeat-policy.js";
import { collectDispositionRepairSourceState } from "../../../services/recovery/disposition-repair.js";
import { appendHeartbeatRunEvent } from "../../../services/heartbeat-run-events.js";
import { emitAgentTaskRun } from "../../../services/agent-task-run-telemetry.js";
import { issueService } from "../../../services/issues.js";
import {
  issueTreeControlService,
  isVerifiedIssueTreeControlInteractionWake,
  ISSUE_TREE_CONTROL_INTERACTION_WAKE_REASONS,
} from "../../../services/issue-tree-control.js";
import {
  continuationSummaryParksExecutor,
  getIssueContinuationSummaryDocument,
} from "../../../services/issue-continuation-summary.js";
import { parseIssueExecutionState } from "../../../services/issue-execution-policy.js";
import type {
  QueuedRunFacts,
  ReviewParticipantFacts,
  RetryReasonKind,
  ScheduledRetryFacts,
} from "../domain/policy.js";
import type {
  CancelStaleQueuedRunInput,
  CancelStaleQueuedRunWriteResult,
  CancelSuppressedRetryInput,
  CancelSuppressedRetryResult,
  DueRetryRun,
  ListDueRetriesInput,
  LoadGateFactsInput,
  LoadGateFactsResult,
  LoadStalenessFactsInput,
  PromoteDueRetryInput,
  PromoteDueRetryResult,
  QueuedRunReader,
  RunDispatchWriter,
  ScheduledRetryReader,
} from "../application/ports.js";
import type { HeartbeatRunRecord, PostCommitEffect } from "../application/types.js";

// Mirrors `MAX_TURN_CONTINUATION_RETRY_REASON` in `server/src/services/heartbeat.ts`.
// Duplicated here, rather than imported, so this adapter never depends back
// on the service it was extracted from.
const MAX_TURN_CONTINUATION_RETRY_REASON = "max_turns_continuation";
const RESOLVED_INTERACTION_CONTINUATION_STATUSES = new Set([
  "accepted",
  "answered",
  "rejected",
]);
const INTERACTION_CONTINUATION_INFRA_WAKE_REASON = "interaction_continuation_infra_retry";
const INTERACTION_CONTINUATION_INFRA_RETRY_REASON = "interaction_continuation_infra_retry";
const WAKE_COMMENT_IDS_KEY = "wakeCommentIds";
const WORKSPACE_BUSY_RETRY_REASON = "workspace_busy";

const NO_REVIEW_PARTICIPANT: ReviewParticipantFacts = {
  isInReview: false,
  hasParticipant: false,
  participantIsAgent: false,
  participantAgentId: null,
  currentStageType: null,
  currentParticipant: null,
};

function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function classifyRetryReasonKind(retryReason: string | null): RetryReasonKind {
  if (retryReason === MAX_TURN_CONTINUATION_RETRY_REASON) return "max_turn_continuation";
  if (retryReason === ISSUE_DISPOSITION_REPAIR_RETRY_REASON) return "disposition_repair";
  return "other";
}

function buildReviewParticipantFacts(input: {
  isInReview: boolean;
  executionState: ReturnType<typeof parseIssueExecutionState>;
}): ReviewParticipantFacts {
  const currentParticipant = input.executionState?.currentParticipant ?? null;
  return {
    isInReview: input.isInReview,
    hasParticipant: currentParticipant !== null,
    participantIsAgent: currentParticipant?.type === "agent",
    participantAgentId:
      currentParticipant?.type === "agent" ? (currentParticipant.agentId ?? null) : null,
    currentStageType: input.executionState?.currentStageType ?? null,
    currentParticipant: currentParticipant as Record<string, unknown> | null,
  };
}

function extractWakeCommentIds(
  contextSnapshot: Record<string, unknown> | null | undefined,
): string[] {
  const raw = contextSnapshot?.[WAKE_COMMENT_IDS_KEY];
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const entry of raw) {
    const value = readNonEmptyString(entry);
    if (!value || out.includes(value)) continue;
    out.push(value);
  }
  return out;
}

function deriveCommentId(
  contextSnapshot: Record<string, unknown> | null | undefined,
): string | null {
  const batchedCommentId = extractWakeCommentIds(contextSnapshot).at(-1);
  return (
    batchedCommentId ??
    readNonEmptyString(contextSnapshot?.wakeCommentId) ??
    readNonEmptyString(contextSnapshot?.commentId) ??
    null
  );
}

/**
 * True for the retry of a workspace-busy deferral whose original run did not
 * execute under assignee-ship (a comment or review-participant wake). Such a
 * retry has an expected assignee mismatch, so the gate must not treat it as
 * a reassignment. Mirrors `isNonAssigneeWorkspaceBusyRetry` in
 * `server/src/services/heartbeat.ts`.
 */
function isNonAssigneeWorkspaceBusyRetry(
  retryReason: string | null | undefined,
  contextSnapshot: Record<string, unknown>,
): boolean {
  return (
    retryReason === WORKSPACE_BUSY_RETRY_REASON &&
    contextSnapshot.workspaceBusyDeferredWhileAssignee === false
  );
}

function allowsIssueInteractionWake(
  contextSnapshot: Record<string, unknown> | null | undefined,
): boolean {
  const wakeReason = readNonEmptyString(contextSnapshot?.wakeReason);
  if (!wakeReason || !ISSUE_TREE_CONTROL_INTERACTION_WAKE_REASONS.has(wakeReason)) return false;
  return Boolean(deriveCommentId(contextSnapshot));
}

function isResolvedInteractionContinuationWakeContext(contextSnapshot: unknown): boolean {
  const context = parseObject(contextSnapshot);
  const interactionId = readNonEmptyString(context.interactionId);
  const interactionStatus = readNonEmptyString(context.interactionStatus);
  if (!interactionId || !interactionStatus) return false;
  if (!RESOLVED_INTERACTION_CONTINUATION_STATUSES.has(interactionStatus)) return false;

  const mutation = readNonEmptyString(context.mutation);
  const wakeReason = readNonEmptyString(context.wakeReason);
  const retryReason = readNonEmptyString(context.retryReason);
  return (
    (mutation === "interaction" && wakeReason === "issue_commented") ||
    wakeReason === INTERACTION_CONTINUATION_INFRA_WAKE_REASON ||
    retryReason === INTERACTION_CONTINUATION_INFRA_RETRY_REASON
  );
}

export function createPostgresRunDispatchAdapter(
  db: Db,
): ScheduledRetryReader & QueuedRunReader & RunDispatchWriter {
  const budgets = budgetService(db);
  const treeControlSvc = issueTreeControlService(db);
  const issuesSvc = issueService(db);

  async function loadGateFacts(
    input: LoadGateFactsInput,
    now: Date,
  ): Promise<LoadGateFactsResult> {
    const agent = await db
      .select()
      .from(agents)
      .where(and(eq(agents.id, input.agentId), eq(agents.companyId, input.companyId)))
      .then((rows) => rows[0] ?? null);
    if (!agent) {
      return { agentFound: false, issueId: readNonEmptyString(input.contextSnapshot.issueId) };
    }

    const retryReason =
      input.retryReasonOverride ??
      readNonEmptyString(input.contextSnapshot.retryReason) ??
      input.scheduledRetryReason ??
      null;
    const issueId = readNonEmptyString(input.contextSnapshot.issueId);
    const retryReasonKind = classifyRetryReasonKind(retryReason);

    const budgetBlock = await budgets.getInvocationBlock(input.companyId, input.agentId, {
      issueId,
      projectId: readNonEmptyString(input.contextSnapshot.projectId),
    });
    const agentInvokability = await evaluateAgentInvokabilityFromDb(db, agent);
    const heartbeatWakeOnDemandEnabled = isHeartbeatWakeOnDemandEnabled(agent);

    const issue = issueId
      ? await db
          .select({
            id: issues.id,
            companyId: issues.companyId,
            status: issues.status,
            assigneeAgentId: issues.assigneeAgentId,
            assigneeUserId: issues.assigneeUserId,
            executionRunId: issues.executionRunId,
            executionPolicy: issues.executionPolicy,
            executionState: issues.executionState,
            monitorNextCheckAt: issues.monitorNextCheckAt,
          })
          .from(issues)
          .where(and(eq(issues.id, issueId), eq(issues.companyId, input.companyId)))
          .then((rows) => rows[0] ?? null)
      : null;

    const dispositionRepair =
      issue && retryReasonKind === "disposition_repair"
        ? await (async () => {
            const expectedFingerprint = readNonEmptyString(
              input.contextSnapshot.dispositionRepairFingerprint,
            );
            const sourceState = await collectDispositionRepairSourceState(db, {
              issue,
              excludeRunId: input.runId,
              excludeWakeupRequestId: input.wakeupRequestId,
            });
            return {
              expectedFingerprintPresent: expectedFingerprint !== null,
              fingerprintMatches: sourceState.fingerprint === expectedFingerprint,
              hasActiveExecutionPath: sourceState.hasActiveExecutionPath,
              hasDurableWaitingPath: sourceState.hasDurableWaitingPath,
              expectedFingerprint,
              currentFingerprint: sourceState.fingerprint,
              durablePathReason: sourceState.durablePathReason,
            };
          })()
        : null;

    const activePauseHold =
      issue && issueId ? await treeControlSvc.getActivePauseHoldGate(input.companyId, issueId) : null;

    const dependenciesBlocked =
      issue && issueId
        ? await (async () => {
            const dependencyReadiness = await issuesSvc.listDependencyReadiness(input.companyId, [issueId]);
            const readiness = dependencyReadiness.get(issueId);
            return readiness && !readiness.isDependencyReady
              ? {
                  unresolvedBlockerIssueIds: readiness.unresolvedBlockerIssueIds,
                  unresolvedBlockerCount: readiness.unresolvedBlockerCount,
                }
              : null;
          })()
        : null;

    const facts: ScheduledRetryFacts = {
      runId: input.runId,
      runAgentId: input.agentId,
      issueId,
      retryReasonKind,
      enforceIssueExecutionLock: retryReasonKind === "max_turn_continuation",
      budgetBlock: budgetBlock
        ? { reason: budgetBlock.reason, scopeType: budgetBlock.scopeType, scopeId: budgetBlock.scopeId }
        : null,
      agentInvokable: agentInvokability.invokable,
      agentInvokabilityDetails: agentInvokability.invokable ? {} : agentInvokability.details,
      agentInvokabilityInvalidOrgChain: agentInvokability.invokable
        ? false
        : agentInvokability.invalidOrgChain,
      heartbeatWakeOnDemandEnabled,
      issueFound: issue !== null,
      issueStatus: issue?.status ?? null,
      issueAssigneeAgentId: issue?.assigneeAgentId ?? null,
      issueExecutionRunId: issue?.executionRunId ?? null,
      isNonAssigneeWorkspaceBusyRetry: isNonAssigneeWorkspaceBusyRetry(
        retryReason,
        input.contextSnapshot,
      ),
      reviewParticipant: issue
        ? buildReviewParticipantFacts({
            isInReview: issue.status === "in_review",
            executionState: parseIssueExecutionState(issue.executionState),
          })
        : NO_REVIEW_PARTICIPANT,
      activePauseHold: activePauseHold
        ? { holdId: activePauseHold.holdId, rootIssueId: activePauseHold.rootIssueId }
        : null,
      dependenciesBlocked,
      dispositionRepair,
    };

    return { agentFound: true, facts };
  }

  async function listDueRetries(input: ListDueRetriesInput): Promise<DueRetryRun[]> {
    const rows = await db
      .select()
      .from(heartbeatRuns)
      .where(
        and(
          eq(heartbeatRuns.status, "scheduled_retry"),
          lte(heartbeatRuns.scheduledRetryAt, input.now),
          input.cutoff ? gte(heartbeatRuns.createdAt, input.cutoff) : undefined,
        ),
      )
      .orderBy(
        asc(heartbeatRuns.scheduledRetryAt),
        asc(heartbeatRuns.createdAt),
        asc(heartbeatRuns.id),
      )
      .limit(input.limit);

    return rows.map((row) => ({
      runId: row.id,
      companyId: row.companyId,
      agentId: row.agentId,
      contextSnapshot: parseObject(row.contextSnapshot),
      scheduledRetryReason: row.scheduledRetryReason,
      wakeupRequestId: row.wakeupRequestId,
    }));
  }

  async function loadStalenessFacts(
    input: LoadStalenessFactsInput,
    _now: Date,
    tx?: unknown,
  ): Promise<QueuedRunFacts> {
    const dbOrTx = (tx as Db | undefined) ?? db;
    const issueId = input.issueId;
    const context = input.contextSnapshot;

    const issue = await dbOrTx
      .select({
        id: issues.id,
        status: issues.status,
        assigneeAgentId: issues.assigneeAgentId,
        executionRunId: issues.executionRunId,
        executionState: issues.executionState,
      })
      .from(issues)
      .where(and(eq(issues.id, issueId), eq(issues.companyId, input.companyId)))
      .then((rows) => rows[0] ?? null);

    const wakeCommentId = deriveCommentId(context);
    const isInteractionWake = allowsIssueInteractionWake(context);
    const resumeIntent = context.resumeIntent === true || context.followUpRequested === true;
    const wakeReason = readNonEmptyString(context.wakeReason);
    const retryReason =
      readNonEmptyString(context.retryReason) ?? input.scheduledRetryReason ?? null;
    const interactionResolvedAt = readNonEmptyString(context.interactionResolvedAt);
    const hasResolvedInteractionEvidence =
      interactionResolvedAt !== null && !Number.isNaN(Date.parse(interactionResolvedAt));
    const isResolvedInteractionContinuation = isResolvedInteractionContinuationWakeContext(context);

    const continuationParkApplies = Boolean(
      issue &&
        issue.status === "in_progress" &&
        !wakeCommentId &&
        !hasResolvedInteractionEvidence &&
        (wakeReason === "issue_continuation_needed" || retryReason === "issue_continuation_needed"),
    );
    let continuationSummaryBody: string | null = null;
    let continuationParksExecutor = false;
    if (continuationParkApplies) {
      const queuedWake = parseObject(context.paperclipWake);
      const queuedContinuationSummary =
        readNonEmptyString(parseObject(context.paperclipContinuationSummary).body) ??
        readNonEmptyString(parseObject(queuedWake.continuationSummary).body);
      const currentContinuationSummary = queuedContinuationSummary
        ? null
        : await getIssueContinuationSummaryDocument(dbOrTx, issueId);
      continuationSummaryBody = queuedContinuationSummary ?? currentContinuationSummary?.body ?? null;
      continuationParksExecutor = continuationSummaryParksExecutor(continuationSummaryBody);
    }

    const recoveryActionId = readNonEmptyString(context.recoveryActionId);
    const isAuthorizedSourceScopedRecovery =
      issue && wakeReason === "source_scoped_recovery_action" && recoveryActionId
        ? await dbOrTx
            .select({ id: issueRecoveryActions.id })
            .from(issueRecoveryActions)
            .where(
              and(
                eq(issueRecoveryActions.id, recoveryActionId),
                eq(issueRecoveryActions.companyId, input.companyId),
                eq(issueRecoveryActions.sourceIssueId, issue.id),
                eq(issueRecoveryActions.ownerAgentId, input.agentId),
                inArray(issueRecoveryActions.status, ["active", "escalated"]),
              ),
            )
            .limit(1)
            .then((rows) => Boolean(rows[0]))
        : false;

    return {
      runId: input.runId,
      runAgentId: input.agentId,
      issueId,
      retryReasonKind: classifyRetryReasonKind(retryReason),
      issueFound: issue !== null,
      issueStatus: issue?.status ?? null,
      issueAssigneeAgentId: issue?.assigneeAgentId ?? null,
      issueExecutionRunId: issue?.executionRunId ?? null,
      isResolvedInteractionContinuation,
      isInteractionWake,
      isAuthorizedSourceScopedRecovery,
      isNonAssigneeWorkspaceBusyRetry: isNonAssigneeWorkspaceBusyRetry(retryReason, context),
      resumeIntent,
      wakeCommentIdPresent: Boolean(wakeCommentId),
      continuationParkApplies,
      continuationParksExecutor,
      continuationSummaryBody,
      wakeReason,
      retryReason,
      reviewParticipant: issue
        ? buildReviewParticipantFacts({
            isInReview: issue.status === "in_review",
            executionState: issue.status === "in_review" ? parseIssueExecutionState(issue.executionState) : null,
          })
        : NO_REVIEW_PARTICIPANT,
    };
  }

  async function promoteDueRetry(input: PromoteDueRetryInput): Promise<PromoteDueRetryResult> {
    const promoted = await db.transaction(async (tx) => {
      const [row] = await tx
        .update(heartbeatRuns)
        .set({ status: "queued", updatedAt: input.now })
        .where(
          and(
            eq(heartbeatRuns.id, input.runId),
            eq(heartbeatRuns.companyId, input.companyId),
            eq(heartbeatRuns.status, "scheduled_retry"),
            lte(heartbeatRuns.scheduledRetryAt, input.now),
          ),
        )
        .returning();
      if (!row) return null;

      await appendHeartbeatRunEvent(tx as unknown as Db, {
        companyId: row.companyId,
        runId: row.id,
        agentId: row.agentId,
        eventType: "lifecycle",
        stream: "system",
        level: "info",
        message: "Scheduled retry became due and was promoted to the queued run pool",
        payload: {
          scheduledRetryAttempt: row.scheduledRetryAttempt,
          scheduledRetryAt: row.scheduledRetryAt ? new Date(row.scheduledRetryAt).toISOString() : null,
          scheduledRetryReason: row.scheduledRetryReason,
        },
      });

      return row;
    });

    if (!promoted) return { applied: false };
    const run = promoted as unknown as HeartbeatRunRecord;
    const postCommitEffects: PostCommitEffect[] = [{ kind: "run_queued", run }];
    return { applied: true, run, postCommitEffects };
  }

  async function cancelSuppressedRetry(
    input: CancelSuppressedRetryInput,
  ): Promise<CancelSuppressedRetryResult> {
    const cancelled = await db.transaction(async (tx) => {
      const [row] = await tx
        .update(heartbeatRuns)
        .set({
          status: "cancelled",
          finishedAt: input.now,
          error: input.reason,
          errorCode: input.errorCode,
          updatedAt: input.now,
        })
        .where(
          and(
            eq(heartbeatRuns.id, input.runId),
            eq(heartbeatRuns.companyId, input.companyId),
            eq(heartbeatRuns.status, "scheduled_retry"),
            lte(heartbeatRuns.scheduledRetryAt, input.now),
          ),
        )
        .returning();
      if (!row) return null;

      if (row.wakeupRequestId) {
        await tx
          .update(agentWakeupRequests)
          .set({ status: "cancelled", finishedAt: input.now, error: input.reason, updatedAt: input.now })
          .where(eq(agentWakeupRequests.id, row.wakeupRequestId));
      }

      if (input.issueId) {
        await tx
          .update(issues)
          .set({
            executionRunId: null,
            executionAgentNameKey: null,
            executionLockedAt: null,
            updatedAt: input.now,
          })
          .where(
            and(
              eq(issues.companyId, row.companyId),
              eq(issues.id, input.issueId),
              eq(issues.executionRunId, row.id),
            ),
          );
      }

      await appendHeartbeatRunEvent(tx as unknown as Db, {
        companyId: row.companyId,
        runId: row.id,
        agentId: row.agentId,
        eventType: "lifecycle",
        stream: "system",
        level: "warn",
        message: input.reason,
        payload: {
          ...input.details,
          scheduledRetryAttempt: row.scheduledRetryAttempt,
          scheduledRetryAt: row.scheduledRetryAt ? new Date(row.scheduledRetryAt).toISOString() : null,
          scheduledRetryReason: row.scheduledRetryReason,
        },
      });

      return row;
    });

    if (!cancelled) return { applied: false };

    // Telemetry is best-effort background work; fire it instead of awaiting
    // it, so a slow telemetry lookup never delays the caller's return.
    void emitAgentTaskRun(db, cancelled);

    return { applied: true, run: cancelled as unknown as HeartbeatRunRecord };
  }

  async function cancelStaleQueuedRun(
    input: CancelStaleQueuedRunInput,
  ): Promise<CancelStaleQueuedRunWriteResult> {
    const now = new Date();
    const { previousStatus, cancelled } = await db.transaction(async (tx) => {
      const previousStatus = await tx
        .select({ status: heartbeatRuns.status })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, input.runId))
        .then((rows) => rows[0]?.status ?? null);

      const [row] = await tx
        .update(heartbeatRuns)
        .set({
          status: "cancelled",
          finishedAt: now,
          error: input.reason,
          errorCode: input.errorCode,
          resultJson: {
            ...parseObject(input.resultJson),
            stopReason: input.errorCode,
            effectiveTimeoutSec: 0,
            timeoutConfigured: false,
            timeoutSource: "stale_queued_run_gate",
            timeoutFired: false,
          },
          updatedAt: now,
        })
        .where(and(eq(heartbeatRuns.id, input.runId), eq(heartbeatRuns.companyId, input.companyId)))
        .returning();
      if (!row) {
        throw new Error(`run-dispatch: run ${input.runId} disappeared during stale-queued-run cancellation`);
      }

      if (input.wakeupRequestId) {
        await tx
          .update(agentWakeupRequests)
          .set({ status: "skipped", finishedAt: now, error: input.reason, updatedAt: now })
          .where(eq(agentWakeupRequests.id, input.wakeupRequestId));
      }

      await tx
        .update(issues)
        .set({
          executionRunId: null,
          executionAgentNameKey: null,
          executionLockedAt: null,
          updatedAt: now,
        })
        .where(
          and(
            eq(issues.companyId, input.companyId),
            eq(issues.id, input.issueId),
            eq(issues.executionRunId, row.id),
          ),
        );

      await appendHeartbeatRunEvent(tx as unknown as Db, {
        companyId: row.companyId,
        runId: row.id,
        agentId: row.agentId,
        eventType: "lifecycle",
        stream: "system",
        level: "warn",
        message: input.reason,
        payload: input.details,
      });

      return { previousStatus, cancelled: row };
    });

    const run = cancelled as unknown as HeartbeatRunRecord;
    const postCommitEffects: PostCommitEffect[] = [
      { kind: "run_status_published", run, previousStatus },
    ];
    return { run, postCommitEffects };
  }

  return {
    loadGateFacts,
    listDueRetries,
    loadStalenessFacts,
    promoteDueRetry,
    cancelSuppressedRetry,
    cancelStaleQueuedRun,
  };
}
