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
import { decideQueuedRunStaleness, decideScheduledRetryGate } from "../domain/policy.js";
import type {
  QueuedRunFacts,
  ReviewParticipantFacts,
  RetryReasonKind,
  ScheduledRetryFacts,
} from "../domain/policy.js";
import {
  MAX_TURN_CONTINUATION_RETRY_REASON,
  allowsIssueInteractionWake,
  deriveCommentId,
  isNonAssigneeWorkspaceBusyRetry,
  isResolvedInteractionContinuationWakeContext,
} from "../domain/wake-context.js";
import type {
  CancelStaleQueuedRunInput,
  DispatchResolvedInteractionInput,
  DispatchResolvedInteractionOutcome,
  DueRetryRun,
  EvaluateScheduledRetryGateInput,
  ListDueRetriesInput,
  PromoteOrCancelDueRetryInput,
  RunDispatchWriter,
  ScheduledRetryReader,
} from "../application/ports.js";
import type {
  CancelStaleQueuedRunOutcome,
  PostCommitEffect,
  PromoteScheduledRetryOutcome,
} from "../application/types.js";
import { RunDispatchApplicationError } from "../application/types.js";

type HeartbeatRun = typeof heartbeatRuns.$inferSelect;
type LoadGateFactsInput = {
  runId: string;
  companyId: string;
  agentId: string;
  contextSnapshot: Record<string, unknown>;
  scheduledRetryReason: string | null;
  retryReasonOverride?: string | null;
  wakeupRequestId: string | null;
};
type LoadGateFactsResult =
  | { agentFound: true; facts: ScheduledRetryFacts }
  | { agentFound: false; issueId: string | null };
type LoadStalenessFactsInput = {
  runId: string;
  companyId: string;
  agentId: string;
  issueId: string;
  contextSnapshot: Record<string, unknown>;
  scheduledRetryReason: string | null;
};
type CancelSuppressedRetryInput = {
  runId: string;
  companyId: string;
  now: Date;
  reason: string;
  errorCode: string;
  issueId: string | null;
  details: Record<string, unknown>;
};
type CancelSuppressedRetryResult = { applied: true; run: HeartbeatRun } | { applied: false };

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

function queuedEffect(run: HeartbeatRun): PostCommitEffect {
  return {
    kind: "run_queued",
    companyId: run.companyId,
    runId: run.id,
    agentId: run.agentId,
    invocationSource: run.invocationSource,
    triggerDetail: run.triggerDetail,
    wakeupRequestId: run.wakeupRequestId,
  };
}

function statusEffect(run: HeartbeatRun, previousStatus: string | null): PostCommitEffect {
  return {
    kind: "run_status_published",
    companyId: run.companyId,
    runId: run.id,
    agentId: run.agentId,
    status: run.status,
    invocationSource: run.invocationSource,
    triggerDetail: run.triggerDetail,
    error: run.error,
    errorCode: run.errorCode,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    result: parseObject(run.resultJson),
    issueId: readNonEmptyString(parseObject(run.contextSnapshot).issueId),
    previousStatus,
  };
}

export function createPostgresRunDispatchAdapter(
  db: Db,
): ScheduledRetryReader & RunDispatchWriter {
  const budgets = budgetService(db);
  const treeControlSvc = issueTreeControlService(db);
  const issuesSvc = issueService(db);

  async function withIssueThenRunLocks<T>(
    input: { runId: string; companyId: string },
    onMissing: () => T,
    operation: (tx: Db, run: HeartbeatRun) => Promise<T>,
  ): Promise<T> {
    // Queue editing and claiming already use issue -> wake -> run. Read the
    // immutable issue reference without a lock first, then acquire issue ->
    // run here as well. Locking the run first can deadlock with a claimant
    // that owns the issue lock and is waiting for the run.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const hint = await db
        .select({ contextSnapshot: heartbeatRuns.contextSnapshot })
        .from(heartbeatRuns)
        .where(and(eq(heartbeatRuns.id, input.runId), eq(heartbeatRuns.companyId, input.companyId)))
        .then((rows) => rows[0] ?? null);
      if (!hint) return onMissing();
      const hintedIssueId = readNonEmptyString(parseObject(hint.contextSnapshot).issueId);

      const result: { kind: "missing" | "retry" } | { kind: "value"; value: T } =
        await db.transaction(async (tx) => {
          const typedTx = tx as unknown as Db;
          if (hintedIssueId) {
            await typedTx
              .select({ id: issues.id })
              .from(issues)
              .where(and(eq(issues.id, hintedIssueId), eq(issues.companyId, input.companyId)))
              .for("update");
          }

          const run = await typedTx
            .select()
            .from(heartbeatRuns)
            .where(
              and(eq(heartbeatRuns.id, input.runId), eq(heartbeatRuns.companyId, input.companyId)),
            )
            .for("update")
            .then((rows) => rows[0] ?? null);
          if (!run) return { kind: "missing" as const };

          const lockedIssueId = readNonEmptyString(parseObject(run.contextSnapshot).issueId);
          if (lockedIssueId !== hintedIssueId) return { kind: "retry" as const };
          return { kind: "value" as const, value: await operation(typedTx, run) };
        });

      if (result.kind === "missing") return onMissing();
      if (result.kind === "value") return result.value;
    }

    throw new Error(
      `run-dispatch: run ${input.runId} changed issue context repeatedly while acquiring locks`,
    );
  }

  async function loadGateFacts(
    input: LoadGateFactsInput,
    now: Date,
    tx?: unknown,
  ): Promise<LoadGateFactsResult> {
    // Semantic adapter operations pass their transaction here so the fact
    // read and the state transition share one unit of work. This helper is
    // deliberately not exposed through the module's public API.
    const dbOrTx = (tx as Db | undefined) ?? db;
    const budgetsForRead = tx ? budgetService(dbOrTx) : budgets;
    const treeControlForRead = tx ? issueTreeControlService(dbOrTx) : treeControlSvc;
    const issuesSvcForRead = tx ? issueService(dbOrTx) : issuesSvc;

    const agent = await dbOrTx
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

    // Facts fill in through the same rule order `decideScheduledRetryGate`
    // evaluates. A field still awaiting its own read keeps a value that
    // rule never blocks on, EXCEPT `issueFound`, which starts unresolved
    // and gets an explicit early check once the issue read lands — a
    // false default there would look exactly like "the issue is gone" the
    // moment `issueId` is set, before the read that would prove it. Once a
    // group of fields is real, this calls the gate on the facts gathered
    // so far, so a rule an earlier read already decided stops the run
    // before it pays for a later, unrelated read — a sweep of many due
    // retries must not query pause holds or dependencies for a retry a
    // budget block or a stale assignment already suppresses.
    const facts: ScheduledRetryFacts = {
      runId: input.runId,
      runAgentId: input.agentId,
      issueId,
      retryReasonKind,
      enforceIssueExecutionLock: retryReasonKind === "max_turn_continuation",
      isNonAssigneeWorkspaceBusyRetry: isNonAssigneeWorkspaceBusyRetry(retryReason, input.contextSnapshot),
      budgetBlock: null,
      agentInvokable: true,
      agentInvokabilityDetails: {},
      agentInvokabilityInvalidOrgChain: false,
      heartbeatWakeOnDemandEnabled: true,
      issueFound: false,
      issueStatus: null,
      issueAssigneeAgentId: null,
      issueExecutionRunId: null,
      reviewParticipant: NO_REVIEW_PARTICIPANT,
      activePauseHold: null,
      dependenciesBlocked: null,
      dispositionRepair: null,
    };
    const isBlocked = () => !decideScheduledRetryGate(facts, now).allowed;

    const budgetBlock = await budgetsForRead.getInvocationBlock(input.companyId, input.agentId, {
      issueId,
      projectId: readNonEmptyString(input.contextSnapshot.projectId),
    });
    facts.budgetBlock = budgetBlock
      ? { reason: budgetBlock.reason, scopeType: budgetBlock.scopeType, scopeId: budgetBlock.scopeId }
      : null;
    if (facts.budgetBlock) return { agentFound: true, facts };

    const agentInvokability = await evaluateAgentInvokabilityFromDb(dbOrTx, agent);
    facts.agentInvokable = agentInvokability.invokable;
    facts.agentInvokabilityDetails = agentInvokability.invokable ? {} : agentInvokability.details;
    facts.agentInvokabilityInvalidOrgChain = agentInvokability.invokable
      ? false
      : agentInvokability.invalidOrgChain;
    if (!facts.agentInvokable) return { agentFound: true, facts };

    facts.heartbeatWakeOnDemandEnabled = isHeartbeatWakeOnDemandEnabled(agent);
    if (!facts.heartbeatWakeOnDemandEnabled) return { agentFound: true, facts };

    if (!issueId) return { agentFound: true, facts };

    const issueQuery = dbOrTx
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
      .where(and(eq(issues.id, issueId), eq(issues.companyId, input.companyId)));
    // Locking the row here, only when a caller opened a transaction for the
    // promote-or-cancel write, is what makes that write's decision hold: a
    // concurrent reassignment, pause, or status change blocks on this lock
    // instead of landing between this read and that write.
    const issue = await (tx ? issueQuery.for("update") : issueQuery).then(
      (rows) => rows[0] ?? null,
    );

    facts.issueFound = issue !== null;
    if (!facts.issueFound) return { agentFound: true, facts };

    facts.issueStatus = issue.status;
    facts.issueAssigneeAgentId = issue.assigneeAgentId;
    facts.issueExecutionRunId = issue.executionRunId;
    facts.reviewParticipant = buildReviewParticipantFacts({
      isInReview: issue.status === "in_review",
      executionState: parseIssueExecutionState(issue.executionState),
    });

    // The gate checks a disposition repair's own supersession before it
    // checks ownership or status, so this read must land before the next
    // isBlocked() call — checking isBlocked() first would report the wrong
    // suppression reason for a superseded repair.
    if (retryReasonKind === "disposition_repair") {
      const expectedFingerprint = readNonEmptyString(input.contextSnapshot.dispositionRepairFingerprint);
      const sourceState = await collectDispositionRepairSourceState(dbOrTx, {
        issue,
        excludeRunId: input.runId,
        excludeWakeupRequestId: input.wakeupRequestId,
      });
      facts.dispositionRepair = {
        expectedFingerprintPresent: expectedFingerprint !== null,
        fingerprintMatches: sourceState.fingerprint === expectedFingerprint,
        hasActiveExecutionPath: sourceState.hasActiveExecutionPath,
        hasDurableWaitingPath: sourceState.hasDurableWaitingPath,
        expectedFingerprint,
        currentFingerprint: sourceState.fingerprint,
        durablePathReason: sourceState.durablePathReason,
      };
    }
    if (isBlocked()) return { agentFound: true, facts };

    const activePauseHold = await treeControlForRead.getActivePauseHoldGate(input.companyId, issueId);
    facts.activePauseHold = activePauseHold
      ? { holdId: activePauseHold.holdId, rootIssueId: activePauseHold.rootIssueId }
      : null;
    if (isBlocked()) return { agentFound: true, facts };

    const dependencyReadiness = await issuesSvcForRead.listDependencyReadiness(input.companyId, [issueId]);
    const readiness = dependencyReadiness.get(issueId);
    facts.dependenciesBlocked =
      readiness && !readiness.isDependencyReady
        ? {
            unresolvedBlockerIssueIds: readiness.unresolvedBlockerIssueIds,
            unresolvedBlockerCount: readiness.unresolvedBlockerCount,
          }
        : null;

    return { agentFound: true, facts };
  }

  async function evaluateScheduledRetryGate(input: EvaluateScheduledRetryGateInput) {
    const run = await db
      .select()
      .from(heartbeatRuns)
      .where(and(eq(heartbeatRuns.id, input.runId), eq(heartbeatRuns.companyId, input.companyId)))
      .then((rows) => rows[0] ?? null);
    if (!run) {
      throw new RunDispatchApplicationError(
        "run_not_found",
        `run-dispatch: run ${input.runId} was not found while evaluating retry eligibility`,
      );
    }
    const factsResult = await loadGateFacts(
      {
        runId: run.id,
        companyId: run.companyId,
        agentId: run.agentId,
        contextSnapshot: parseObject(run.contextSnapshot),
        scheduledRetryReason: run.scheduledRetryReason,
        retryReasonOverride: input.retryReasonOverride,
        wakeupRequestId: run.wakeupRequestId,
      },
      input.now,
    );
    if (!factsResult.agentFound) {
      return {
        allowed: false as const,
        reason: "Scheduled retry suppressed because the agent no longer exists",
        errorCode: "agent_not_invokable" as const,
        issueId: factsResult.issueId,
        details: { agentId: run.agentId },
      };
    }
    return decideScheduledRetryGate(factsResult.facts, input.now);
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

    const issueQuery = dbOrTx
      .select({
        id: issues.id,
        status: issues.status,
        assigneeAgentId: issues.assigneeAgentId,
        executionRunId: issues.executionRunId,
        executionState: issues.executionState,
      })
      .from(issues)
      .where(and(eq(issues.id, issueId), eq(issues.companyId, input.companyId)));
    const issue = await (tx ? issueQuery.for("update") : issueQuery).then(
      (rows) => rows[0] ?? null,
    );

    const wakeCommentId = deriveCommentId(context);
    const isInteractionWake = allowsIssueInteractionWake(
      context,
      ISSUE_TREE_CONTROL_INTERACTION_WAKE_REASONS,
    );
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

  async function promoteDueRetryInTx(
    tx: Db,
    input: PromoteOrCancelDueRetryInput,
  ): Promise<
    | { applied: true; run: HeartbeatRun; postCommitEffects: PostCommitEffect[] }
    | { applied: false }
  > {
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
    if (!row) return { applied: false };

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

    return { applied: true as const, run: row, postCommitEffects: [queuedEffect(row)] };
  }

  async function cancelSuppressedRetryInTx(
    tx: Db,
    input: CancelSuppressedRetryInput,
  ): Promise<CancelSuppressedRetryResult> {
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
    if (!row) return { applied: false };

    if (row.wakeupRequestId) {
      await tx
        .update(agentWakeupRequests)
        .set({ status: "cancelled", finishedAt: input.now, error: input.reason, updatedAt: input.now })
        .where(
          and(
            eq(agentWakeupRequests.id, row.wakeupRequestId),
            eq(agentWakeupRequests.companyId, row.companyId),
          ),
        );
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

    return { applied: true, run: row };
  }

  async function promoteOrCancelDueRetry(
    input: PromoteOrCancelDueRetryInput,
  ): Promise<PromoteScheduledRetryOutcome> {
    const now = input.now;

    const promoteLockedRun = async (tx: Db, run: HeartbeatRun) => {
      if (
        run.status !== "scheduled_retry" ||
        !run.scheduledRetryAt ||
        new Date(run.scheduledRetryAt).getTime() > now.getTime()
      ) {
        return { outcome: { outcome: "not_promoted" as const }, telemetryRun: null };
      }
      const factsResult = await loadGateFacts(
        {
          runId: run.id,
          companyId: run.companyId,
          agentId: run.agentId,
          contextSnapshot: parseObject(run.contextSnapshot),
          scheduledRetryReason: run.scheduledRetryReason,
          retryReasonOverride: run.scheduledRetryReason,
          wakeupRequestId: run.wakeupRequestId,
        },
        now,
        tx,
      );

      if (!factsResult.agentFound) {
        const cancelled = await cancelSuppressedRetryInTx(tx as unknown as Db, {
          runId: input.runId,
          companyId: input.companyId,
          now,
          reason: "Scheduled retry suppressed because the agent no longer exists",
          errorCode: "agent_not_invokable",
          issueId: factsResult.issueId,
          details: { agentId: run.agentId },
        });
        return cancelled.applied
          ? {
              outcome: {
                outcome: "gate_suppressed" as const,
                reason: "Scheduled retry suppressed because the agent no longer exists",
                errorCode: "agent_not_invokable" as const,
              },
              telemetryRun: cancelled.run,
            }
          : { outcome: { outcome: "not_promoted" as const }, telemetryRun: null };
      }

      const gate = decideScheduledRetryGate(factsResult.facts, now);

      // Preserve legacy transient retry behavior for runs that only carry a
      // loose task context rather than a persisted issue row: a missing
      // issue suppresses a max-turn continuation, but every other retry
      // reason proceeds to promotion anyway.
      const isLegacyMissingIssueException =
        !gate.allowed &&
        gate.errorCode === "issue_not_found" &&
        factsResult.facts.retryReasonKind !== "max_turn_continuation";

      if (!gate.allowed && !isLegacyMissingIssueException) {
        const cancelled = await cancelSuppressedRetryInTx(tx as unknown as Db, {
          runId: input.runId,
          companyId: input.companyId,
          now,
          reason: gate.reason,
          errorCode: gate.errorCode,
          issueId: gate.issueId,
          details: gate.details,
        });
        return cancelled.applied
          ? {
              outcome: {
                outcome: "gate_suppressed" as const,
                reason: gate.reason,
                errorCode: gate.errorCode,
              },
              telemetryRun: cancelled.run,
            }
          : { outcome: { outcome: "not_promoted" as const }, telemetryRun: null };
      }

      const promoted = await promoteDueRetryInTx(tx as unknown as Db, {
        runId: input.runId,
        companyId: input.companyId,
        now,
      });
      return promoted.applied
        ? {
            outcome: {
              outcome: "promoted" as const,
              postCommitEffects: promoted.postCommitEffects,
            },
            telemetryRun: null,
          }
        : { outcome: { outcome: "not_promoted" as const }, telemetryRun: null };
    };
    const transactionResult = await withIssueThenRunLocks(
      input,
      () => ({ outcome: { outcome: "not_promoted" as const }, telemetryRun: null }),
      promoteLockedRun,
    );

    // Telemetry is best-effort background work; fire it only after the
    // transaction above has committed, so a suppressed retry is never
    // published before its cancellation is durable, and never published at
    // all if the transaction rolled back.
    if (transactionResult.telemetryRun) {
      void emitAgentTaskRun(db, transactionResult.telemetryRun);
    }

    return transactionResult.outcome;
  }

  async function cancelStaleRunInTx(
    tx: Db,
    run: HeartbeatRun,
    issueId: string,
    decision: Extract<ReturnType<typeof decideQueuedRunStaleness>, { stale: true }>,
    expectedStatus: "queued" | "running",
    now: Date,
  ): Promise<CancelStaleQueuedRunOutcome> {
      const [row] = await tx
        .update(heartbeatRuns)
        .set({
          status: "cancelled",
          finishedAt: now,
          error: decision.reason,
          errorCode: decision.errorCode,
          resultJson: {
            ...parseObject(run.resultJson),
            stopReason: decision.errorCode,
            effectiveTimeoutSec: 0,
            timeoutConfigured: false,
            timeoutSource: "stale_queued_run_gate",
            timeoutFired: false,
          },
          updatedAt: now,
        })
        .where(
          and(
            eq(heartbeatRuns.id, run.id),
            eq(heartbeatRuns.companyId, run.companyId),
            eq(heartbeatRuns.status, expectedStatus),
          ),
        )
        .returning();
      // A concurrent claimant or canceller already moved the run off
      // `expectedStatus`: the caller's staleness decision lost the race, so
      // this write must not overwrite whatever status won it.
      if (!row) return { outcome: "lost_race" };

      if (row.wakeupRequestId) {
        await tx
          .update(agentWakeupRequests)
          .set({ status: "skipped", finishedAt: now, error: decision.reason, updatedAt: now })
          .where(
            and(
              eq(agentWakeupRequests.id, row.wakeupRequestId),
              eq(agentWakeupRequests.companyId, row.companyId),
            ),
          );
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
            eq(issues.companyId, row.companyId),
            eq(issues.id, issueId),
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
        message: decision.reason,
        payload: decision.details,
      });

      return {
        outcome: "cancelled",
        reason: decision.reason,
        errorCode: decision.errorCode,
        postCommitEffects: [statusEffect(row, expectedStatus)],
      };
  }

  async function decideCurrentRunStaleness(tx: Db, run: HeartbeatRun, now: Date) {
    const contextSnapshot = parseObject(run.contextSnapshot);
    const issueId = readNonEmptyString(contextSnapshot.issueId);
    if (!issueId) return { issueId: null, decision: { stale: false as const } };
    const facts = await loadStalenessFacts(
      {
        runId: run.id,
        companyId: run.companyId,
        agentId: run.agentId,
        issueId,
        contextSnapshot,
        scheduledRetryReason: run.scheduledRetryReason,
      },
      now,
      tx,
    );
    return { issueId, decision: decideQueuedRunStaleness(facts, now) };
  }

  async function cancelStaleQueuedRun(
    input: CancelStaleQueuedRunInput,
  ): Promise<CancelStaleQueuedRunOutcome> {
    const cancelLockedRun = async (tx: Db, run: HeartbeatRun) => {
      if (run.status !== input.expectedStatus) return { outcome: "lost_race" as const };
      const { issueId, decision } = await decideCurrentRunStaleness(tx, run, input.now);
      if (!decision.stale || !issueId) return { outcome: "not_stale" as const };
      return cancelStaleRunInTx(tx, run, issueId, decision, input.expectedStatus, input.now);
    };

    return withIssueThenRunLocks(
      input,
      () => {
        throw new RunDispatchApplicationError(
          "run_not_found",
          `run-dispatch: run ${input.runId} disappeared during stale-run validation`,
        );
      },
      cancelLockedRun,
    );
  }

  async function dispatchResolvedInteractionIfCurrent<T>(
    input: DispatchResolvedInteractionInput<T>,
  ): Promise<DispatchResolvedInteractionOutcome<T>> {
    const dispatchLockedRun = async (tx: Db, run: HeartbeatRun) => {
      if (run.status !== input.expectedStatus) {
        return { dispatched: false as const, cancellation: { outcome: "lost_race" as const } };
      }
      const { issueId, decision: initialDecision } = await decideCurrentRunStaleness(
        tx,
        run,
        input.now,
      );
      const decision =
        !initialDecision.stale && issueId
          ? await tx
              .select({ executionRunId: issues.executionRunId })
              .from(issues)
              .where(and(eq(issues.id, issueId), eq(issues.companyId, run.companyId)))
              .then((rows) => rows[0] ?? null)
              .then((issue) =>
                issue?.executionRunId === run.id
                  ? initialDecision
                  : {
                      stale: true as const,
                      errorCode: "issue_execution_lock_changed" as const,
                      reason:
                        "Cancelled because resolved-interaction continuation no longer owns the issue execution lock before adapter dispatch",
                      details: {
                        issueId,
                        expectedExecutionRunId: run.id,
                        currentExecutionRunId: issue?.executionRunId ?? null,
                      },
                    },
              )
          : initialDecision;

      if (decision.stale && issueId) {
        const cancellation = await cancelStaleRunInTx(
          tx,
          run,
          issueId,
          decision,
          input.expectedStatus,
          input.now,
        );
        return { dispatched: false as const, cancellation };
      }

      let dispatchStarted = false;
      let resolveDispatchStarted!: () => void;
      const dispatchStartedPromise = new Promise<void>((resolve) => {
        resolveDispatchStarted = resolve;
      });
      const markDispatchStarted = () => {
        if (dispatchStarted) return;
        dispatchStarted = true;
        resolveDispatchStarted();
      };
      const resultPromise = input.dispatch(markDispatchStarted);
      void resultPromise.then(markDispatchStarted, markDispatchStarted);
      await dispatchStartedPromise;
      return { dispatched: true as const, resultPromise };
    };

    return withIssueThenRunLocks(
      input,
      () => {
        throw new RunDispatchApplicationError(
          "run_not_found",
          `run-dispatch: run ${input.runId} disappeared before resolved-interaction dispatch`,
        );
      },
      dispatchLockedRun,
    );
  }

  return {
    evaluateScheduledRetryGate,
    listDueRetries,
    cancelStaleQueuedRun,
    dispatchResolvedInteractionIfCurrent,
    promoteOrCancelDueRetry,
  };
}
