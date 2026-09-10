// Pure decision rules for the release half of the deferred issue-execution
// wake state machine:
//   - the per-wake decision (decideDeferredWake), applied to the earliest
//     deferred wake queued against the issue a run just released
//   - the release-recovery decision (decideReleaseRecovery), applied once
//     the deferred-wake queue is empty and no wake was promoted
// The caller reads the database and packs the result into a facts object.
// This file only branches on that facts object; it never queries a
// database, reads the clock, or reads the wake context payload directly.

export type DeferredWakeQueuedCommentFacts = {
  /** True when the wake carries one or more queued comment ids to check. */
  hasQueuedCommentIds: boolean;
  /** Count of queued comment ids that are still live and not self-authored by the finishing run. */
  liveNonSelfCommentIdsLength: number;
  /** Count of queued comment ids the wake originally carried. */
  queuedCommentIdsLength: number;
  /** True when the live, non-self comment id list differs from the queued list. */
  liveCommentIdsChanged: boolean;
  /** True when every discarded comment id was authored by the finishing run. */
  containedSelfAuthoredComment: boolean;
  /** True when the wake carries an independent reason to continue even with no live comments. */
  preservesIndependentContinuation: boolean;
};

export type DeferredWakeAgentFacts = {
  /** True when the wake's agent exists in the issue's own company. */
  agentFound: boolean;
  /** True when the agent is invokable (status, org chain). Meaningless when agentFound is false. */
  invokable: boolean;
};

export type DeferredWakePauseHoldFacts = {
  /** True when an active subtree pause hold covers the issue. */
  activePauseHold: boolean;
  /** True when the wake is a verified issue-tree-control interaction wake that survives a pause hold. */
  treeHoldInteractionWake: boolean;
};

export type DeferredWakeFacts = {
  queuedComment: DeferredWakeQueuedCommentFacts;
  agent: DeferredWakeAgentFacts;
  pauseHold: DeferredWakePauseHoldFacts;
};

export type DeferredWakeDecision =
  | { kind: "cancel_empty"; selfAuthored: boolean }
  | { kind: "normalize" }
  | { kind: "fail_not_invokable" }
  | { kind: "cancel_pause_hold" }
  | { kind: "promote" };

/**
 * Decides what to do with the earliest deferred wake queued against the
 * issue a run just released. The caller applies a "normalize" decision (a
 * queued-comment-id rewrite) and calls this function again with facts that
 * reflect the rewrite, so a single wake can normalize and then also fail,
 * cancel, or promote in the same drain step — matching the order the
 * original state machine always evaluated them in.
 */
export function decideDeferredWake(facts: DeferredWakeFacts): DeferredWakeDecision {
  const { queuedComment, agent, pauseHold } = facts;

  if (
    queuedComment.hasQueuedCommentIds &&
    queuedComment.liveNonSelfCommentIdsLength === 0 &&
    !queuedComment.preservesIndependentContinuation
  ) {
    return { kind: "cancel_empty", selfAuthored: queuedComment.containedSelfAuthoredComment };
  }

  if (queuedComment.hasQueuedCommentIds && queuedComment.liveCommentIdsChanged) {
    return { kind: "normalize" };
  }

  if (!agent.agentFound || !agent.invokable) {
    return { kind: "fail_not_invokable" };
  }

  if (pauseHold.activePauseHold && !pauseHold.treeHoldInteractionWake) {
    return { kind: "cancel_pause_hold" };
  }

  return { kind: "promote" };
}

export type ReleaseRecoveryReviewParticipantFacts = {
  /** True when the issue is in_review, unassigned to a user, and waiting on the finishing run as the current agent participant. */
  applies: boolean;
  hasExistingExecutionPath: boolean;
  hasPersistedMonitor: boolean;
  suppressedByPauseHold: boolean;
  isStrandedRecoveryOrigin: boolean;
  recoveryAgentPresent: boolean;
  recoveryAgentInvokable: boolean;
  /** True when the finishing run was itself a review-participant-recovery retry. */
  isExecutionReviewParticipantRecoveryRun: boolean;
};

export type ReleaseRecoveryImmediateFacts = {
  /** True when the issue is todo/in_progress, unassigned to a user, not hidden, still assigned to the finishing run's agent, and the run ended failed/timed_out/cancelled. */
  applies: boolean;
  /** True when the finishing run itself carried the disposition-repair retry reason. */
  isDispositionRepairRetry: boolean;
  hasExistingExecutionPath: boolean;
  hasPersistedMonitor: boolean;
  hasExplicitBlockerPath: boolean;
  suppressedByPauseHold: boolean;
  isStrandedRecoveryOrigin: boolean;
  recoveryAgentPresent: boolean;
  recoveryAgentInvokable: boolean;
  isWorkspaceValidationFailedRun: boolean;
  isConfigurationIncompleteFailedRun: boolean;
  /** didAutomaticRecoveryFail(run, expectedRetryReason) for the issue's own status branch. */
  automaticRecoveryAlreadyFailed: boolean;
};

export type ReleaseRecoveryFacts = {
  /** options.suppressImmediateRecovery on the caller's release request. */
  suppressImmediateRecovery: boolean;
  reviewParticipant: ReleaseRecoveryReviewParticipantFacts;
  immediate: ReleaseRecoveryImmediateFacts;
};

export type ReleaseRecoveryBlockedNoticeKind =
  | "workspace_validation"
  | "configuration_incomplete"
  | "execution_review_participant"
  | "immediate_execution_path";

export type ReleaseRecoveryDecision =
  | { kind: "released" }
  | { kind: "blocked_recovery_in_place" }
  | { kind: "blocked"; notice: ReleaseRecoveryBlockedNoticeKind }
  | { kind: "queue_review_participant_recovery" }
  | { kind: "queue_recovery" };

/**
 * Decides the release-recovery outcome once the deferred-wake queue is
 * empty and no wake was promoted. The review-participant branch and the
 * assignment-and-continuation branch are the two ways a released issue can
 * still need automatic recovery; this function evaluates both as one
 * decision, review-participant first, matching the original evaluation
 * order.
 */
export function decideReleaseRecovery(facts: ReleaseRecoveryFacts): ReleaseRecoveryDecision {
  const { reviewParticipant, immediate } = facts;

  if (reviewParticipant.applies) {
    if (
      facts.suppressImmediateRecovery ||
      reviewParticipant.hasExistingExecutionPath ||
      reviewParticipant.hasPersistedMonitor ||
      reviewParticipant.suppressedByPauseHold
    ) {
      return { kind: "released" };
    }
    if (reviewParticipant.isStrandedRecoveryOrigin) {
      return { kind: "blocked_recovery_in_place" };
    }
    const shouldBlock =
      !reviewParticipant.recoveryAgentInvokable ||
      !reviewParticipant.recoveryAgentPresent ||
      reviewParticipant.isExecutionReviewParticipantRecoveryRun;
    if (shouldBlock) {
      return { kind: "blocked", notice: "execution_review_participant" };
    }
    return { kind: "queue_review_participant_recovery" };
  }

  if (immediate.isDispositionRepairRetry) return { kind: "released" };
  if (!immediate.applies) return { kind: "released" };
  if (facts.suppressImmediateRecovery) return { kind: "released" };
  if (
    immediate.hasExistingExecutionPath ||
    immediate.hasPersistedMonitor ||
    immediate.hasExplicitBlockerPath
  ) {
    return { kind: "released" };
  }
  if (immediate.suppressedByPauseHold) return { kind: "released" };
  if (immediate.isStrandedRecoveryOrigin) return { kind: "blocked_recovery_in_place" };

  const shouldBlockImmediately =
    !immediate.recoveryAgentInvokable ||
    !immediate.recoveryAgentPresent ||
    immediate.isWorkspaceValidationFailedRun ||
    immediate.isConfigurationIncompleteFailedRun ||
    immediate.automaticRecoveryAlreadyFailed;
  if (shouldBlockImmediately) {
    const notice: ReleaseRecoveryBlockedNoticeKind = immediate.isWorkspaceValidationFailedRun
      ? "workspace_validation"
      : immediate.isConfigurationIncompleteFailedRun
        ? "configuration_incomplete"
        : "immediate_execution_path";
    return { kind: "blocked", notice };
  }

  return { kind: "queue_recovery" };
}
