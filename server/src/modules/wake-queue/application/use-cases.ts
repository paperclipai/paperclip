import { enrichPromotedWakeContext } from "../domain/context.js";
import {
  decideQueuedCommentAction,
  decideReleaseRecovery,
  decideWakeAdmission,
  decideWakeOutcome,
  deriveImmediateRecoveryContextLabels,
} from "../domain/policy.js";
import {
  EXECUTION_REVIEW_PARTICIPANT_RECOVERY_RETRY_REASON,
  isConfigurationIncompleteFailedRun,
  isWorkspaceValidationFailedRun,
  readNonEmptyString,
} from "../domain/values.js";
import type {
  AdmitWakeBehindIssueExecutionResult,
  DeferredWakeCandidate,
  DurableWakeAdmissionReceipt,
  InvokableAgentSnapshot,
  IssueLockWriter,
  IssueSnapshot,
  LockedIssueExecution,
  RecoveryEscalationPort,
  ReleaseTransactionResult,
  RunSnapshot,
  TransactionScope,
  WakeAdmissionActiveExecutionRun,
  WakeAdmissionHeartbeatHelpers,
  WakeAdmissionReader,
  WakeAdmissionWriter,
  WakeQueueHost,
  WakeQueueTransaction,
} from "./ports.js";
import type { PostCommitEffect, ReleaseOutcome } from "./types.js";
import { WakeQueueApplicationError } from "./types.js";

const DEFERRED_WAKE_CONTEXT_KEY = "_paperclipWakeContext";

const ISSUE_DISPOSITION_REPAIR_RETRY_REASON = "issue_disposition_repair";
const EXECUTION_REVIEW_PARTICIPANT_RECOVERY_WAKE_REASONS = new Set([
  "execution_review_requested",
  "execution_approval_requested",
]);
const HEARTBEAT_RUN_TERMINAL_STATUSES = new Set([
  "succeeded",
  "failed",
  "timed_out",
  "cancelled",
]);
const UNSUCCESSFUL_HEARTBEAT_RUN_TERMINAL_STATUSES = new Set([
  "failed",
  "timed_out",
  "cancelled",
]);
const STRANDED_ISSUE_RECOVERY_ORIGIN_KIND = "stranded_issue_recovery";

function isExecutionReviewParticipantRecoveryRun(run: Pick<RunSnapshot, "contextSnapshot">): boolean {
  return readNonEmptyString(run.contextSnapshot.retryReason) === EXECUTION_REVIEW_PARTICIPANT_RECOVERY_RETRY_REASON;
}

function isExecutionReviewParticipantRecoveryEligibleRun(run: Pick<RunSnapshot, "contextSnapshot">): boolean {
  const wakeReason = readNonEmptyString(run.contextSnapshot.wakeReason);
  return (wakeReason !== null && EXECUTION_REVIEW_PARTICIPANT_RECOVERY_WAKE_REASONS.has(wakeReason))
    || isExecutionReviewParticipantRecoveryRun(run);
}

function didAutomaticRecoveryFail(
  run: Pick<RunSnapshot, "status" | "contextSnapshot">,
  expectedRetryReason: "assignment_recovery" | "issue_continuation_needed",
): boolean {
  const latestRetryReason = readNonEmptyString(run.contextSnapshot.retryReason);
  return latestRetryReason === expectedRetryReason && UNSUCCESSFUL_HEARTBEAT_RUN_TERMINAL_STATUSES.has(run.status);
}

function currentAgentParticipant(issue: IssueSnapshot): { agentId: string } | null {
  const executionState = issue.executionState;
  if (!executionState || executionState.status !== "pending") return null;
  const participant = executionState.currentParticipant as Record<string, unknown> | null | undefined;
  if (!participant || participant.type !== "agent") return null;
  const agentId = readNonEmptyString(participant.agentId);
  return agentId ? { agentId } : null;
}

/**
 * Resolves the responsible user for a heartbeat run the module is about to
 * queue. The promote path and the immediate-recovery path both call this
 * one function; each still checks the result and throws its own error with
 * its own metadata when no responsible user resolves.
 */
async function resolveResponsibleUserForQueuedRun(
  host: WakeQueueHost,
  input: {
    companyId: string;
    contextSnapshot: Record<string, unknown>;
    issue: IssueSnapshot;
    requestedByActorType: "user" | "agent" | "system" | null;
    requestedByActorId: string | null;
    source: string;
    triggerDetail: string | null;
    existingRunResponsibleUserId: string | null;
  },
): Promise<string | null> {
  const routineEnvContext = await host.getRoutineEnv({ companyId: input.companyId, issue: input.issue });
  return host.resolveResponsibleUserId({
    companyId: input.companyId,
    contextSnapshot: input.contextSnapshot,
    issue: input.issue,
    routineEnvContext,
    requestedByActorType: input.requestedByActorType,
    requestedByActorId: input.requestedByActorId,
    source: input.source,
    triggerDetail: input.triggerDetail,
    existingRunResponsibleUserId: input.existingRunResponsibleUserId,
  });
}

export type ReleaseIssueExecutionInput = {
  companyId: string;
  runId: string;
  now: Date;
  suppressImmediateRecovery?: boolean;
};

type PauseHoldFacts = Awaited<ReturnType<WakeQueueTransaction["getPauseHoldFacts"]>>;

/**
 * Drains the deferred-wake queue for the issue a run just released, in
 * `requestedAt` order, promoting at most one wake. When the queue empties
 * without a promotion, decides the release-recovery outcome. Every read and
 * write happens through `ports`, already bound to the module's own
 * transaction by the caller.
 */
async function runReleaseDrain(
  locked: LockedIssueExecution,
  ports: { host: WakeQueueHost; transaction: WakeQueueTransaction },
  input: ReleaseIssueExecutionInput,
): Promise<ReleaseTransactionResult> {
  const { run } = locked;
  const issue = locked.primaryIssue;
  const postCommitEffects: PostCommitEffect[] = [];

  if (locked.recoveryOnly) {
    return runReleaseRecoveryTail(issue, run, ports.host, ports.transaction, input, postCommitEffects);
  }

  // Each `continue` path below leaves the wake row off the
  // `deferred_issue_execution` status, so the next queue read cannot
  // return that same row again. That invariant is what ends this loop.
  // The `processedWakeIds` guard below makes a break of the invariant
  // fail loudly, instead of holding this transaction open forever.
  const processedWakeIds = new Set<string>();

  while (true) {
    const candidate = await ports.transaction.findNextDeferredWake({ companyId: run.companyId, issueId: issue.id });
    if (!candidate) break;
    if (processedWakeIds.has(candidate.id)) {
      throw new WakeQueueApplicationError(
        "deferred_wake_not_advanced",
        "Deferred wake queue read the same wake id twice; the row did not leave the deferred status",
        { companyId: run.companyId, issueId: issue.id, wakeId: candidate.id },
      );
    }
    processedWakeIds.add(candidate.id);

    let liveness = { liveNonSelfCommentIds: candidate.queuedCommentIds, containedSelfAuthoredComment: false };
    if (
      !candidate.authorizedFailedChatRetry &&
      candidate.queuedCommentIds.length > 0
    ) {
      liveness = await ports.transaction.getQueuedCommentLiveness({
        companyId: run.companyId,
        issueId: issue.id,
        wakeAgentId: candidate.agentId,
        finishingRunId: run.id,
        finishingRunAgentId: run.agentId,
        queuedCommentIds: candidate.queuedCommentIds,
      });
    }
    // A length mismatch is the only way the lists can differ: the adapter derives `liveNonSelfCommentIds` with `.filter`, so it is always a subsequence of `queuedCommentIds`.
    const liveCommentIdsDiffer = liveness.liveNonSelfCommentIds.length !== candidate.queuedCommentIds.length;

    const deferredAgent = await ports.transaction.findInvokableAgent({ companyId: run.companyId, agentId: candidate.agentId });
    const pauseHold = await ports.transaction.getPauseHoldFacts({
      companyId: run.companyId,
      issueId: issue.id,
      wakeAgentId: candidate.agentId,
      deferredContextSeed: candidate.deferredContextSeed,
      requestedByActorType: candidate.requestedByActorType,
      requestedByActorId: candidate.requestedByActorId,
    });

    const commentAction = decideQueuedCommentAction({
      hasQueuedCommentIds: candidate.queuedCommentIds.length > 0,
      liveNonSelfCommentIdsLength: liveness.liveNonSelfCommentIds.length,
      liveCommentIdsDiffer,
      containedSelfAuthoredComment: liveness.containedSelfAuthoredComment,
      preservesIndependentContinuation: candidate.preservesIndependentContinuation,
    });

    if (commentAction.kind === "cancel_empty") {
      // A `false` result means another writer already moved this row off
      // the deferred status, so the next queue read cannot return it again.
      await ports.transaction.cancelDeferredWake({
        companyId: run.companyId,
        wakeId: candidate.id,
        reason: commentAction.selfAuthored
          ? "Deferred wake contained only comments authored by the finishing run"
          : "Queued messages were discarded before promotion",
        now: input.now,
      });
      continue;
    }

    let workingCandidate = candidate;
    if (commentAction.kind === "normalize") {
      const normalized = await ports.transaction.normalizeDeferredWakeCommentIds({
        companyId: run.companyId,
        wakeId: candidate.id,
        payload: candidate.payload,
        liveCommentIds: liveness.liveNonSelfCommentIds,
        now: input.now,
      });
      if (!normalized) continue;
      workingCandidate = normalized;
    }

    // A comment-id rewrite cannot change the agent or pause-hold facts already fetched above, so one decision covers both the rewritten and un-rewritten cases.
    const wakeOutcome = decideWakeOutcome({
      agent: { agentFound: deferredAgent !== null, invokable: deferredAgent?.invokable ?? false },
      pauseHold: { activePauseHold: pauseHold.activePauseHold, treeHoldInteractionWake: pauseHold.treeHoldInteractionWake },
    });

    if (wakeOutcome.kind === "fail_not_invokable") {
      await ports.transaction.failDeferredWake({ companyId: run.companyId, wakeId: workingCandidate.id, now: input.now });
      continue;
    }

    if (wakeOutcome.kind === "cancel_pause_hold") {
      await ports.transaction.cancelDeferredWake({
        companyId: run.companyId,
        wakeId: workingCandidate.id,
        reason: "Deferred wake suppressed by active subtree pause hold",
        now: input.now,
      });
      continue;
    }

    // Unreachable: decideWakeOutcome only returns "promote" when agentFound and invokable are both true.
    if (!deferredAgent) throw new Error("wake-queue: promoted a deferred wake with no invokable agent");

    const promoted = await promoteDeferredWake(ports, run, issue, workingCandidate, deferredAgent, pauseHold, postCommitEffects, input);
    if (!promoted) continue;
    return promoted;
  }

  return runReleaseRecoveryTail(issue, run, ports.host, ports.transaction, input, postCommitEffects);
}

/**
 * Finalizes one deferred wake that `decideWakeOutcome` chose to promote.
 * Returns `null` when the promotion claim loses a race, so the caller moves
 * on to the next queued wake instead of ending the drain.
 */
async function promoteDeferredWake(
  ports: { host: WakeQueueHost; transaction: WakeQueueTransaction },
  run: RunSnapshot,
  issue: IssueSnapshot,
  workingCandidate: DeferredWakeCandidate,
  invokableAgent: InvokableAgentSnapshot,
  pauseHold: PauseHoldFacts,
  postCommitEffects: PostCommitEffect[],
  input: ReleaseIssueExecutionInput,
): Promise<ReleaseTransactionResult | null> {
  let currentIssue = issue;
  let shouldReopen = false;
  if (
    !workingCandidate.authorizedFailedChatRetry &&
    workingCandidate.deferredCommentIds.length > 0 &&
    (currentIssue.status === "done" || currentIssue.status === "cancelled")
  ) {
    const selfAuthorship = await ports.transaction.getCommentSelfAuthorship({
      companyId: run.companyId,
      issueId: currentIssue.id,
      finishingRunId: run.id,
      commentIds: workingCandidate.deferredCommentIds,
    });
    shouldReopen =
      !selfAuthorship.allSelfAuthored &&
      (workingCandidate.requestedByActorType === "user" ||
        workingCandidate.wakeReason === "issue_reopened_via_comment");
  }

  // Agent continuations can outlive the work they addressed. Only a human
  // reopen can revive assignee execution; other agents may still receive
  // notifications about the closed task. Cancel before claiming promotion so
  // the compare-and-set still sees the deferred wake.
  if (
    !shouldReopen &&
    (currentIssue.status === "done" || currentIssue.status === "cancelled") &&
    workingCandidate.agentId === currentIssue.assigneeAgentId
  ) {
    await ports.transaction.cancelDeferredWake({
      companyId: run.companyId,
      wakeId: workingCandidate.id,
      reason: "Deferred execution wake no longer applies to a terminal task",
      now: input.now,
    });
    return null;
  }

  // Claim before reopening. A reopen write and its post-commit effect must
  // never survive a lost race on this compare-and-set.
  const claimedForPromotion = await ports.transaction.claimDeferredWakeForPromotion({
    companyId: run.companyId,
    wakeId: workingCandidate.id,
    now: input.now,
  });
  if (!claimedForPromotion) return null;

  if (shouldReopen) {
    const reopened = await ports.transaction.reopenIssue({
      companyId: run.companyId,
      issueId: currentIssue.id,
      runId: run.id,
    });
    if (reopened) {
      postCommitEffects.push({
        kind: "issue_reopened",
        companyId: reopened.companyId,
        agentId: invokableAgent.id,
        runId: run.id,
        issueId: reopened.id,
        identifier: reopened.identifier,
        reopenedFrom: currentIssue.status,
      });
      currentIssue = reopened;
    }
  }

  const promotedReason = workingCandidate.reason ?? "issue_execution_promoted";
  const promotedSource = workingCandidate.source ?? "automation";
  const promotedTriggerDetail = workingCandidate.triggerDetail ?? null;
  const promotedPayload = { ...workingCandidate.payload };
  delete promotedPayload["_paperclipWakeContext"];

  const promotedContextSeed: Record<string, unknown> = { ...workingCandidate.deferredContextSeed };
  if (pauseHold.activePauseHold) {
    promotedContextSeed.treeHoldInteraction = true;
    promotedContextSeed.activeTreeHold = {
      holdId: pauseHold.holdId,
      rootIssueId: pauseHold.rootIssueId,
      mode: pauseHold.mode,
      reason: pauseHold.reason,
      releasePolicy: pauseHold.releasePolicy,
      interaction: true,
    };
  }

  const { contextSnapshot: promotedContextSnapshot, taskKey: promotedTaskKey } = enrichPromotedWakeContext({
    contextSnapshot: promotedContextSeed,
    reason: promotedReason,
    source: promotedSource,
    triggerDetail: promotedTriggerDetail,
    payload: promotedPayload,
  });

  const sessionBefore =
    readNonEmptyString(promotedContextSnapshot.resumeSessionDisplayId) ??
    (await ports.host.resolveSessionBeforeForWakeup({
      companyId: run.companyId,
      agentId: invokableAgent.id,
      taskKey: promotedTaskKey,
    }));

  const responsibleUserId = await resolveResponsibleUserForQueuedRun(ports.host, {
    companyId: invokableAgent.companyId,
    contextSnapshot: promotedContextSnapshot,
    issue: currentIssue,
    requestedByActorType: workingCandidate.requestedByActorType,
    requestedByActorId: workingCandidate.requestedByActorId,
    source: promotedSource,
    triggerDetail: promotedTriggerDetail,
    existingRunResponsibleUserId: run.responsibleUserId,
  });
  if (!responsibleUserId) {
    throw new WakeQueueApplicationError(
      "responsible_user_unresolved",
      "Unable to resolve responsible user for promoted heartbeat run",
      {
        runId: run.id,
        agentId: invokableAgent.id,
        companyId: invokableAgent.companyId,
        issueId: currentIssue.id,
        wakeReason: readNonEmptyString(promotedContextSnapshot.wakeReason),
      },
    );
  }

  const promotedRun = await ports.transaction.finalizePromotedWake({
    companyId: run.companyId,
    wakeId: workingCandidate.id,
    deferredAgent: invokableAgent,
    issue: currentIssue,
    finishingRun: run,
    contextSnapshot: promotedContextSnapshot,
    reason: promotedReason,
    source: promotedSource,
    triggerDetail: promotedTriggerDetail,
    payload: promotedPayload,
    responsibleUserId,
    sessionBefore,
    authorizedFailedChatRetry: workingCandidate.authorizedFailedChatRetry,
    now: input.now,
  });

  postCommitEffects.push({ kind: "run_queued", run: promotedRun });
  return { outcome: { kind: "promoted", run: promotedRun }, postCommitEffects };
}

async function runReleaseRecoveryTail(
  issue: IssueSnapshot,
  run: RunSnapshot,
  host: WakeQueueHost,
  transaction: WakeQueueTransaction,
  input: ReleaseIssueExecutionInput,
  postCommitEffects: PostCommitEffect[],
): Promise<ReleaseTransactionResult> {
  const suppressImmediateRecovery = input.suppressImmediateRecovery === true || Boolean(
    issue.conversationAgentId && issue.conversationUserId &&
    issue.conversationState === "waiting" && issue.status === "in_review"
  );
  const isStrandedRecoveryOrigin =
    issue.originKind === STRANDED_ISSUE_RECOVERY_ORIGIN_KIND;
  const recoveryAgent = await transaction.findInvokableAgent({
    companyId: issue.companyId,
    agentId: run.agentId,
  });

  const currentParticipant = currentAgentParticipant(issue);
  const reviewParticipantApplies =
    issue.status === "in_review" &&
    !issue.assigneeUserId &&
    currentParticipant !== null &&
    currentParticipant.agentId === run.agentId &&
    isExecutionReviewParticipantRecoveryEligibleRun(run) &&
    HEARTBEAT_RUN_TERMINAL_STATUSES.has(run.status);

  const immediateApplies =
    (issue.status === "todo" || issue.status === "in_progress") &&
    !issue.assigneeUserId &&
    !issue.hiddenAt &&
    issue.assigneeAgentId === run.agentId &&
    (run.status === "failed" ||
      run.status === "timed_out" ||
      run.status === "cancelled");

  const suppressedByPauseHold =
    reviewParticipantApplies || immediateApplies
      ? await transaction.isAutomaticRecoverySuppressedByPauseHold({
          companyId: issue.companyId,
          issueId: issue.id,
        })
      : false;

  const hasExistingExecutionPath = reviewParticipantApplies
    ? await transaction.hasExistingExecutionPath({
        companyId: issue.companyId,
        issueId: issue.id,
        excludeRunId: run.id,
        agentId: currentParticipant?.agentId ?? null,
      })
    : immediateApplies
      ? await transaction.hasExistingExecutionPath({
          companyId: issue.companyId,
          issueId: issue.id,
          excludeRunId: run.id,
          agentId: null,
        })
      : false;

  const hasExplicitBlockerPath =
    immediateApplies && !reviewParticipantApplies
      ? await transaction.hasExplicitBlockerPath({
          companyId: issue.companyId,
          issueId: issue.id,
        })
      : false;

  const expectedRetryReason:
    "assignment_recovery" | "issue_continuation_needed" =
    issue.status === "todo"
      ? "assignment_recovery"
      : "issue_continuation_needed";

  // A separately admitted deferred wake has already had its chance to promote.
  // Only the generic immediate-recovery tail consumes this deny-only fact.
  const sourceRequiresExplicitRecovery =
    immediateApplies &&
    !reviewParticipantApplies &&
    !suppressImmediateRecovery &&
    readNonEmptyString(run.contextSnapshot.retryReason) !==
      ISSUE_DISPOSITION_REPAIR_RETRY_REASON &&
    !hasExistingExecutionPath &&
    !issue.monitorNextCheckAt &&
    !hasExplicitBlockerPath &&
    !suppressedByPauseHold &&
    !isStrandedRecoveryOrigin
      ? await transaction.isImmediateRecoverySourceBlocked({
          companyId: run.companyId,
          runId: run.id,
        })
      : false;

  const decision = decideReleaseRecovery({
    suppressImmediateRecovery,
    reviewParticipant: {
      applies: reviewParticipantApplies,
      isExecutionReviewParticipantRecoveryRun:
        isExecutionReviewParticipantRecoveryRun(run),
    },
    immediate: {
      applies: immediateApplies,
      isDispositionRepairRetry:
        readNonEmptyString(run.contextSnapshot.retryReason) ===
        ISSUE_DISPOSITION_REPAIR_RETRY_REASON,
      hasExplicitBlockerPath,
      isWorkspaceValidationFailedRun: isWorkspaceValidationFailedRun(run),
      isConfigurationIncompleteFailedRun:
        isConfigurationIncompleteFailedRun(run),
      automaticRecoveryAlreadyFailed: didAutomaticRecoveryFail(
        run,
        expectedRetryReason,
      ),
      sourceRequiresExplicitRecovery,
    },
    shared: {
      hasExistingExecutionPath,
      hasPersistedMonitor: Boolean(issue.monitorNextCheckAt),
      suppressedByPauseHold,
      isStrandedRecoveryOrigin,
      recoveryAgentPresent: recoveryAgent !== null,
      recoveryAgentInvokable: recoveryAgent?.invokable ?? false,
    },
  });

  if (decision.kind === "released") {
    return { outcome: { kind: "released" }, postCommitEffects };
  }

  if (decision.kind === "blocked_recovery_in_place") {
    return {
      outcome: {
        kind: "blocked_recovery_in_place",
        issue,
        previousStatus: statusForBlock(issue),
      },
      postCommitEffects,
    };
  }

  if (decision.kind === "blocked") {
    return {
      outcome: {
        kind: "blocked",
        issue,
        previousStatus: statusForBlock(issue),
        noticeKind: decision.notice,
      },
      postCommitEffects,
    };
  }

  // Unreachable: decideReleaseRecovery only reaches "queue_review_participant_recovery" or "queue_recovery" when the shared recovery-agent facts are both true.
  if (!recoveryAgent)
    throw new Error(
      "wake-queue: queued a recovery run with no invokable recovery agent",
    );

  if (run.conversationContinuation && ["failed", "timed_out", "interrupted"].includes(run.status)) {
    // Do not create an uncounted immediate successor inside the issue lock.
    // The host's idempotent scheduler claims it after commit with the same
    // retry counter used by restart and process-loss recovery.
    postCommitEffects.push({
      kind: "conversation_retry_requested",
      companyId: run.companyId,
      runId: run.id,
      reviewParticipant: decision.kind === "queue_review_participant_recovery",
    });
    return { outcome: { kind: "released" }, postCommitEffects };
  }

  const sessionBefore = await host.resolveSessionBeforeForWakeup({
    companyId: issue.companyId,
    agentId: recoveryAgent.id,
    taskKey:
      readNonEmptyString(run.contextSnapshot.taskKey) ??
      readNonEmptyString(run.contextSnapshot.issueId),
  });

  if (decision.kind === "queue_review_participant_recovery") {
    const queuedRun = await transaction.queueReviewParticipantRecoveryRun({
      companyId: issue.companyId,
      issue,
      finishingRun: run,
      recoveryAgent,
      sessionBefore,
      now: input.now,
    });
    postCommitEffects.push({ kind: "run_queued", run: queuedRun });
    return {
      outcome: { kind: "queued_review_participant_recovery", run: queuedRun },
      postCommitEffects,
    };
  }

  // decision.kind === "queue_recovery"; resolve the responsible user here,
  // in the application layer, before the transaction port queues the run.
  const { retryReason, recoveryReason, recoverySource } =
    deriveImmediateRecoveryContextLabels(issue.status);
  // This fresh normal-model seed carries no inherited recovery/model-profile fields.
  const recoveryContextSnapshot: Record<string, unknown> = {
    issueId: issue.id,
    taskId: issue.id,
    wakeReason: recoveryReason,
    retryReason,
    source: recoverySource,
    retryOfRunId: run.id,
  };

  const recoveryResponsibleUserId = await resolveResponsibleUserForQueuedRun(
    host,
    {
      companyId: issue.companyId,
      contextSnapshot: recoveryContextSnapshot,
      issue,
      requestedByActorType: "system",
      requestedByActorId: null,
      source: "automation",
      triggerDetail: "system",
      existingRunResponsibleUserId: run.responsibleUserId,
    },
  );
  if (!recoveryResponsibleUserId) {
    throw new WakeQueueApplicationError(
      "responsible_user_unresolved",
      "Unable to resolve responsible user for recovery heartbeat run",
      {
        runId: run.id,
        agentId: recoveryAgent.id,
        companyId: issue.companyId,
        issueId: issue.id,
        wakeReason: recoveryReason,
      },
    );
  }

  const queuedRun = await transaction.queueImmediateRecoveryRun({
    companyId: issue.companyId,
    issue,
    finishingRun: run,
    recoveryAgent,
    reason: recoveryReason,
    contextSnapshot: recoveryContextSnapshot,
    responsibleUserId: recoveryResponsibleUserId,
    sessionBefore,
    now: input.now,
  });
  postCommitEffects.push({ kind: "run_queued", run: queuedRun });
  return {
    outcome: { kind: "queued_recovery", run: queuedRun },
    postCommitEffects,
  };
}

function statusForBlock(issue: IssueSnapshot): "todo" | "in_progress" | "in_review" {
  return issue.status === "todo" || issue.status === "in_review" ? issue.status : "in_progress";
}

export type AdmitWakeBehindIssueExecutionInput = {
  companyId: string;
  issueId: string;
  agentId: string;
  agentNameKey: string | null;
  issueExecutionAgentNameKey: string | null;
  activeExecutionRun: WakeAdmissionActiveExecutionRun;
  allowRunCoalescing?: boolean;
  durableReceipt?: DurableWakeAdmissionReceipt;
  reason?: string | null;
  /** Tracks which runs are still live in this process, for the zombie-run filter. */
  liveRunExecutions: { has(id: string): boolean };
  wakeCommentId: string | null;
  forceFreshSession: boolean;
  contextSnapshot: Record<string, unknown>;
  source: string;
  triggerDetail: string | null;
  payload: Record<string, unknown> | null;
  requestedByActorType: string | null;
  requestedByActorId: string | null;
  idempotencyKey: string | null;
};

export type { AdmitWakeBehindIssueExecutionResult };

/**
 * Decides and applies the admission outcome for a wake that arrives while
 * an active execution run already holds the issue's execution lock: merge
 * it into that run (coalesce), hold it behind the run (defer), or leave it
 * for the caller to queue as an ordinary wake (proceed).
 */
export function createAdmitWakeBehindIssueExecution(deps: {
  reader: WakeAdmissionReader;
  writer: WakeAdmissionWriter;
  helpers: WakeAdmissionHeartbeatHelpers;
}) {
  return async function admitWakeBehindIssueExecution(
    scope: TransactionScope,
    input: AdmitWakeBehindIssueExecutionInput,
  ): Promise<AdmitWakeBehindIssueExecutionResult> {
    const isSameExecutionAgent = await deps.reader.isSameExecutionAgent(scope, {
      companyId: input.companyId,
      activeExecutionRunAgentId: input.activeExecutionRun.agentId,
      issueExecutionAgentNameKey: input.issueExecutionAgentNameKey,
      agentNameKey: input.agentNameKey,
    });

    const shouldDeferFollowupWake =
      deps.helpers.shouldDeferFollowupWakeForSameIssue({
        activeRunStatus: input.activeExecutionRun.status,
        isSameExecutionAgent,
        wakeCommentId: input.wakeCommentId,
        forceFreshSession: input.forceFreshSession,
      });
    const shouldQueueFollowupForRunningWake =
      deps.helpers.shouldQueueFollowupForRunningIssueWake({
        contextSnapshot: input.contextSnapshot,
        wakeCommentId: input.wakeCommentId,
      }) &&
      input.activeExecutionRun.status === "running" &&
      isSameExecutionAgent;
    const availableActiveExecutionRun = isSameExecutionAgent
      ? deps.helpers.filterZombieCoalesceTarget(
          input.activeExecutionRun,
          input.liveRunExecutions,
        )
      : input.activeExecutionRun;

    const sameDurableActor =
      !input.durableReceipt ||
      (await deps.reader.matchesActiveWakeActor(scope, {
        companyId: input.companyId,
        wakeupRequestId: availableActiveExecutionRun?.wakeupRequestId ?? null,
        requestedByActorType: input.requestedByActorType,
        requestedByActorId: input.requestedByActorId,
      }));
    const decision = decideWakeAdmission({
      allowRunCoalescing: input.allowRunCoalescing,
      sameDurableActor,
      isSameExecutionAgent,
      shouldDeferFollowupWake,
      shouldQueueFollowupForRunningWake,
      availableActiveExecutionRunPresent: availableActiveExecutionRun !== null,
    });

    if (decision.kind === "proceed") return { kind: "proceed" };

    if (decision.kind === "coalesce") {
      const target = availableActiveExecutionRun!;
      const mergedContextSnapshot = deps.helpers.mergeCoalescedContextSnapshot(
        target.contextSnapshot,
        input.contextSnapshot,
        {
          preserveExistingInteractionContinuation:
            target.status === "queued" || target.status === "scheduled_retry",
        },
      );
      const run = await deps.writer.coalesceIntoActiveExecutionRun(scope, {
        companyId: input.companyId,
        activeExecutionRunId: target.id,
        mergedContextSnapshot,
        ...(input.durableReceipt
          ? { durableReceipt: input.durableReceipt }
          : {}),
        agentId: input.agentId,
        source: input.source,
        triggerDetail: input.triggerDetail,
        payload: input.payload,
        requestedByActorType: input.requestedByActorType,
        requestedByActorId: input.requestedByActorId,
        idempotencyKey: input.idempotencyKey,
      });
      return { kind: "coalesced", run };
    }

    // decision.kind === "defer": only now does the module read for an
    // existing deferred wake, so the coalesce path (the common path) never
    // pays for this query.
    const existingDeferred =
      input.allowRunCoalescing === false
        ? null
        : await deps.reader.findExistingDeferredWake(scope, {
            companyId: input.companyId,
            agentId: input.agentId,
            issueId: input.issueId,
            ...(input.durableReceipt
              ? {
                  durableActor: {
                    type: input.requestedByActorType,
                    id: input.requestedByActorId,
                  },
                }
              : {}),
          });

    if (existingDeferred) {
      const mergedDeferredContext = deps.helpers.mergeCoalescedContextSnapshot(
        existingDeferred.deferredContext,
        input.contextSnapshot,
        {
          preserveExistingInteractionContinuation: true,
        },
      );
      const mergedPayload = {
        ...existingDeferred.payload,
        ...(input.payload ?? {}),
        issueId: input.issueId,
        [DEFERRED_WAKE_CONTEXT_KEY]: mergedDeferredContext,
      };
      await deps.writer.mergeIntoExistingDeferredWake(scope, {
        companyId: input.companyId,
        existingDeferredWakeId: existingDeferred.id,
        mergedPayload,
        nextCoalescedCount: (existingDeferred.coalescedCount ?? 0) + 1,
        ...(input.durableReceipt
          ? {
              coalescedReceipt: {
                ...input.durableReceipt,
                agentId: input.agentId,
                source: input.source,
                triggerDetail: input.triggerDetail,
                reason: input.reason ?? null,
                payload: {
                  ...(input.payload ?? {}),
                  coalescedIntoWakeupRequestId: existingDeferred.id,
                },
                requestedByActorType: input.requestedByActorType,
                requestedByActorId: input.requestedByActorId,
                idempotencyKey: input.idempotencyKey,
                runId: existingDeferred.runId ?? null,
              },
            }
          : {}),
      });
      return { kind: "deferred" };
    }

    const deferredPayload = {
      ...(input.payload ?? {}),
      issueId: input.issueId,
      [DEFERRED_WAKE_CONTEXT_KEY]: input.contextSnapshot,
    };
    await deps.writer.insertNewDeferredWake(scope, {
      companyId: input.companyId,
      agentId: input.agentId,
      source: input.source,
      triggerDetail: input.triggerDetail,
      payload: deferredPayload,
      ...(input.durableReceipt ? { durableReceipt: input.durableReceipt } : {}),
      requestedByActorType: input.requestedByActorType,
      requestedByActorId: input.requestedByActorId,
      idempotencyKey: input.idempotencyKey,
    });
    return { kind: "deferred" };
  };
}

export function createReleaseIssueExecution(deps: {
  issueLock: IssueLockWriter;
  recovery: RecoveryEscalationPort;
}) {
  return async function releaseIssueExecution(
    input: ReleaseIssueExecutionInput,
  ): Promise<{ outcome: ReleaseOutcome; postCommitEffects: PostCommitEffect[] }> {
    const result = await deps.issueLock.withIssueExecutionLock(
      { companyId: input.companyId, runId: input.runId, now: input.now },
      (locked, ports) => runReleaseDrain(locked, ports, input),
    );

    if (result.outcome.kind === "blocked") {
      await deps.recovery.escalateStrandedAssignedIssue({
        issue: result.outcome.issue,
        previousStatus: result.outcome.previousStatus,
        latestRun: result.run,
        noticeKind: result.outcome.noticeKind,
      });
    } else if (result.outcome.kind === "blocked_recovery_in_place") {
      await deps.recovery.escalateStrandedRecoveryIssueInPlace({
        issue: result.outcome.issue,
        previousStatus: result.outcome.previousStatus,
        latestRun: result.run,
      });
    }

    return { outcome: result.outcome, postCommitEffects: result.postCommitEffects };
  };
}
