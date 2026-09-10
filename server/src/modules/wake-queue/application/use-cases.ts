import { enrichPromotedWakeContext } from "../domain/context.js";
import { decideDeferredWake, decideReleaseRecovery } from "../domain/policy.js";
import type {
  IssueLockWriter,
  IssueSnapshot,
  LockedIssueExecution,
  RecoveryEscalationPort,
  ReleaseTransactionResult,
  RunSnapshot,
  WakeQueueReader,
  WakeQueueWriter,
} from "./ports.js";
import type { PostCommitEffect, ReleaseOutcome } from "./types.js";
import { WakeQueueApplicationError } from "./types.js";

const ISSUE_DISPOSITION_REPAIR_RETRY_REASON = "issue_disposition_repair";
const EXECUTION_REVIEW_PARTICIPANT_RECOVERY_RETRY_REASON = "execution_review_participant_recovery";
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
const WORKSPACE_VALIDATION_FAILURE_CODE = "workspace_validation_failed";
const CONFIGURATION_INCOMPLETE_FAILURE_CODE = "configuration_incomplete";

function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function isWorkspaceValidationFailedRun(run: Pick<RunSnapshot, "errorCode">): boolean {
  return run.errorCode === WORKSPACE_VALIDATION_FAILURE_CODE;
}

function isConfigurationIncompleteFailedRun(run: Pick<RunSnapshot, "errorCode">): boolean {
  return run.errorCode === CONFIGURATION_INCOMPLETE_FAILURE_CODE || run.errorCode === "model_not_found";
}

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

export type ReleaseIssueExecutionInput = {
  companyId: string;
  runId: string;
  now: Date;
  suppressImmediateRecovery?: boolean;
};

/**
 * Drains the deferred-wake queue for the issue a run just released, in
 * `requestedAt` order, promoting at most one wake. When the queue empties
 * without a promotion, decides the release-recovery outcome. Every read and
 * write happens through `ports`, already bound to the module's own
 * transaction by the caller.
 */
async function runReleaseDrain(
  locked: LockedIssueExecution,
  ports: { reader: WakeQueueReader; writer: WakeQueueWriter },
  input: ReleaseIssueExecutionInput,
): Promise<ReleaseTransactionResult> {
  const { run } = locked;
  let issue = locked.primaryIssue;
  const postCommitEffects: PostCommitEffect[] = [];

  while (true) {
    const candidate = await ports.writer.claimNextDeferredWake({ companyId: run.companyId, issueId: issue.id });
    if (!candidate) break;

    let liveness = { liveNonSelfCommentIds: candidate.queuedCommentIds, containedSelfAuthoredComment: false };
    if (candidate.queuedCommentIds.length > 0) {
      liveness = await ports.writer.getQueuedCommentLiveness({
        companyId: run.companyId,
        issueId: issue.id,
        wakeAgentId: candidate.agentId,
        finishingRunId: run.id,
        finishingRunAgentId: run.agentId,
        queuedCommentIds: candidate.queuedCommentIds,
      });
    }
    const liveCommentIdsChanged =
      liveness.liveNonSelfCommentIds.length !== candidate.queuedCommentIds.length ||
      liveness.liveNonSelfCommentIds.some((id, index) => id !== candidate.queuedCommentIds[index]);

    const deferredAgent = await ports.reader.findInvokableAgent({ companyId: run.companyId, agentId: candidate.agentId });
    const pauseHold = await ports.writer.getPauseHoldFacts({
      companyId: run.companyId,
      issueId: issue.id,
      wakeAgentId: candidate.agentId,
      deferredContextSeed: candidate.deferredContextSeed,
      requestedByActorType: candidate.requestedByActorType,
      requestedByActorId: candidate.requestedByActorId,
    });

    let decision = decideDeferredWake({
      queuedComment: {
        hasQueuedCommentIds: candidate.queuedCommentIds.length > 0,
        liveNonSelfCommentIdsLength: liveness.liveNonSelfCommentIds.length,
        queuedCommentIdsLength: candidate.queuedCommentIds.length,
        liveCommentIdsChanged,
        containedSelfAuthoredComment: liveness.containedSelfAuthoredComment,
        preservesIndependentContinuation: candidate.preservesIndependentContinuation,
      },
      agent: { agentFound: deferredAgent !== null, invokable: deferredAgent?.invokable ?? false },
      pauseHold: { activePauseHold: pauseHold.activePauseHold, treeHoldInteractionWake: pauseHold.treeHoldInteractionWake },
    });

    if (decision.kind === "cancel_empty") {
      await ports.writer.cancelDeferredWake({
        companyId: run.companyId,
        wakeId: candidate.id,
        reason: decision.selfAuthored
          ? "Deferred wake contained only comments authored by the finishing run"
          : "Queued messages were discarded before promotion",
        now: input.now,
      });
      continue;
    }

    let workingCandidate = candidate;
    if (decision.kind === "normalize") {
      const normalized = await ports.writer.normalizeDeferredWakeCommentIds({
        companyId: run.companyId,
        wakeId: candidate.id,
        payload: candidate.payload,
        liveCommentIds: liveness.liveNonSelfCommentIds,
        now: input.now,
      });
      if (!normalized) continue;
      workingCandidate = normalized;
      // Re-decide with the same agent/pause-hold facts already fetched above; the
      // comment-id set now matches, so only fail/cancel-pause-hold/promote can result.
      decision = decideDeferredWake({
        queuedComment: {
          hasQueuedCommentIds: workingCandidate.queuedCommentIds.length > 0,
          liveNonSelfCommentIdsLength: liveness.liveNonSelfCommentIds.length,
          queuedCommentIdsLength: liveness.liveNonSelfCommentIds.length,
          liveCommentIdsChanged: false,
          containedSelfAuthoredComment: liveness.containedSelfAuthoredComment,
          preservesIndependentContinuation: workingCandidate.preservesIndependentContinuation,
        },
        agent: { agentFound: deferredAgent !== null, invokable: deferredAgent?.invokable ?? false },
        pauseHold: { activePauseHold: pauseHold.activePauseHold, treeHoldInteractionWake: pauseHold.treeHoldInteractionWake },
      });
    }

    if (decision.kind === "fail_not_invokable") {
      await ports.writer.failDeferredWake({ companyId: run.companyId, wakeId: workingCandidate.id, now: input.now });
      continue;
    }

    if (decision.kind === "cancel_pause_hold") {
      await ports.writer.cancelDeferredWake({
        companyId: run.companyId,
        wakeId: workingCandidate.id,
        reason: "Deferred wake suppressed by active subtree pause hold",
        now: input.now,
      });
      continue;
    }

    // decision.kind === "promote"
    const invokableAgent = deferredAgent!;

    // Claim the wake for promotion before any other write in this branch
    // (design choice: claim first, then reopen). A reopen write, or its
    // `issue_reopened` post-commit effect, must never survive a lost race on
    // this compare-and-set. When the claim fails, a concurrent writer already
    // changed the wake's status, so this candidate is gone; move on to the
    // next one instead of ending the drain.
    const claimedForPromotion = await ports.writer.claimDeferredWakeForPromotion({
      companyId: run.companyId,
      wakeId: workingCandidate.id,
      now: input.now,
    });
    if (!claimedForPromotion) continue;

    let currentIssue = issue;

    if (workingCandidate.deferredCommentIds.length > 0 && (currentIssue.status === "done" || currentIssue.status === "cancelled")) {
      const selfAuthorship = await ports.writer.getCommentSelfAuthorship({
        companyId: run.companyId,
        issueId: currentIssue.id,
        finishingRunId: run.id,
        commentIds: workingCandidate.deferredCommentIds,
      });
      const shouldReopen =
        !selfAuthorship.allSelfAuthored &&
        (workingCandidate.requestedByActorType === "user" || workingCandidate.wakeReason === "issue_reopened_via_comment");
      if (shouldReopen) {
        const reopened = await ports.writer.reopenIssue({ companyId: run.companyId, issueId: currentIssue.id, runId: run.id });
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
          issue = reopened;
        }
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
      (await ports.reader.resolveSessionBeforeForWakeup({
        companyId: run.companyId,
        agentId: invokableAgent.id,
        taskKey: promotedTaskKey,
      }));

    const promotedRoutineEnvContext = await ports.reader.getRoutineEnv({
      companyId: invokableAgent.companyId,
      issue: currentIssue,
    });
    const responsibleUserId = await ports.reader.resolveResponsibleUserId({
      companyId: invokableAgent.companyId,
      contextSnapshot: promotedContextSnapshot,
      issue: currentIssue,
      routineEnvContext: promotedRoutineEnvContext,
      requestedByActorType: workingCandidate.requestedByActorType as "user" | "agent" | "system" | null,
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

    const promotedRun = await ports.writer.finalizePromotedWake({
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
      now: input.now,
    });

    postCommitEffects.push({ kind: "run_queued", run: promotedRun });
    return { outcome: { kind: "promoted", run: promotedRun }, postCommitEffects };
  }

  return runReleaseRecoveryTail(issue, run, ports.reader, ports.writer, input, postCommitEffects);
}

async function runReleaseRecoveryTail(
  issue: IssueSnapshot,
  run: RunSnapshot,
  reader: WakeQueueReader,
  writer: WakeQueueWriter,
  input: ReleaseIssueExecutionInput,
  postCommitEffects: PostCommitEffect[],
): Promise<ReleaseTransactionResult> {
  const suppressImmediateRecovery = input.suppressImmediateRecovery ?? false;
  const isStrandedRecoveryOrigin = issue.originKind === STRANDED_ISSUE_RECOVERY_ORIGIN_KIND;
  const recoveryAgent = await reader.findInvokableAgent({ companyId: issue.companyId, agentId: run.agentId });

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
    (run.status === "failed" || run.status === "timed_out" || run.status === "cancelled");

  const suppressedByPauseHold = (reviewParticipantApplies || immediateApplies)
    ? await writer.isAutomaticRecoverySuppressedByPauseHold({ companyId: issue.companyId, issueId: issue.id })
    : false;

  const hasExistingExecutionPath = reviewParticipantApplies
    ? await writer.hasExistingExecutionPath({
        companyId: issue.companyId,
        issueId: issue.id,
        excludeRunId: run.id,
        agentId: currentParticipant?.agentId ?? null,
      })
    : immediateApplies
      ? await writer.hasExistingExecutionPath({ companyId: issue.companyId, issueId: issue.id, excludeRunId: run.id, agentId: null })
      : false;

  const hasExplicitBlockerPath = immediateApplies && !reviewParticipantApplies
    ? await writer.hasExplicitBlockerPath({ companyId: issue.companyId, issueId: issue.id })
    : false;

  const expectedRetryReason: "assignment_recovery" | "issue_continuation_needed" =
    issue.status === "todo" ? "assignment_recovery" : "issue_continuation_needed";

  const decision = decideReleaseRecovery({
    suppressImmediateRecovery,
    reviewParticipant: {
      applies: reviewParticipantApplies,
      hasExistingExecutionPath,
      hasPersistedMonitor: Boolean(issue.monitorNextCheckAt),
      suppressedByPauseHold,
      isStrandedRecoveryOrigin,
      recoveryAgentPresent: recoveryAgent !== null,
      recoveryAgentInvokable: recoveryAgent?.invokable ?? false,
      isExecutionReviewParticipantRecoveryRun: isExecutionReviewParticipantRecoveryRun(run),
    },
    immediate: {
      applies: immediateApplies,
      isDispositionRepairRetry: readNonEmptyString(run.contextSnapshot.retryReason) === ISSUE_DISPOSITION_REPAIR_RETRY_REASON,
      hasExistingExecutionPath,
      hasPersistedMonitor: Boolean(issue.monitorNextCheckAt),
      hasExplicitBlockerPath,
      suppressedByPauseHold,
      isStrandedRecoveryOrigin,
      recoveryAgentPresent: recoveryAgent !== null,
      recoveryAgentInvokable: recoveryAgent?.invokable ?? false,
      isWorkspaceValidationFailedRun: isWorkspaceValidationFailedRun(run),
      isConfigurationIncompleteFailedRun: isConfigurationIncompleteFailedRun(run),
      automaticRecoveryAlreadyFailed: didAutomaticRecoveryFail(run, expectedRetryReason),
    },
  });

  if (decision.kind === "released") {
    return { outcome: { kind: "released" }, postCommitEffects };
  }

  if (decision.kind === "blocked_recovery_in_place") {
    return {
      outcome: { kind: "blocked_recovery_in_place", issue, previousStatus: statusForBlock(issue) },
      postCommitEffects,
    };
  }

  if (decision.kind === "blocked") {
    const { notice, recoveryCause } = await writer.buildBlockedRecoveryNotice({
      noticeKind: decision.notice,
      issueStatus: issue.status === "todo" ? "todo" : "in_progress",
      finishingRun: run,
    });
    return {
      outcome: {
        kind: "blocked",
        issue,
        previousStatus: statusForBlock(issue),
        notice,
        recoveryCause,
      },
      postCommitEffects,
    };
  }

  const sessionBefore = await reader.resolveSessionBeforeForWakeup({
    companyId: issue.companyId,
    agentId: recoveryAgent!.id,
    taskKey: readNonEmptyString(run.contextSnapshot.taskKey) ?? readNonEmptyString(run.contextSnapshot.issueId),
  });

  if (decision.kind === "queue_review_participant_recovery") {
    const queuedRun = await writer.queueReviewParticipantRecoveryRun({
      companyId: issue.companyId,
      issue,
      finishingRun: run,
      recoveryAgent: recoveryAgent!,
      sessionBefore,
      now: input.now,
    });
    postCommitEffects.push({ kind: "run_queued", run: queuedRun });
    return { outcome: { kind: "queued_review_participant_recovery", run: queuedRun }, postCommitEffects };
  }

  // decision.kind === "queue_recovery"; the adapter builds the recovery
  // context snapshot and resolves the responsible user from it, throwing
  // WakeQueueApplicationError when no responsible user resolves.
  const queuedRun = await writer.queueImmediateRecoveryRun({
    companyId: issue.companyId,
    issue,
    finishingRun: run,
    recoveryAgent: recoveryAgent!,
    sessionBefore,
    now: input.now,
  });
  postCommitEffects.push({ kind: "run_queued", run: queuedRun });
  return { outcome: { kind: "queued_recovery", run: queuedRun }, postCommitEffects };
}

function statusForBlock(issue: IssueSnapshot): "todo" | "in_progress" | "in_review" {
  return issue.status === "todo" || issue.status === "in_review" ? issue.status : "in_progress";
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
        notice: result.outcome.notice,
        recoveryCause: result.outcome.recoveryCause,
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
