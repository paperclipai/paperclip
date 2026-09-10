// Pure decision rules for the release half of the deferred issue-execution
// wake state machine:
//   - the pre-drain decision (decidePreDrain), applied once per lock
//     acquisition, before the caller touches the deferred-wake queue at all
//   - the per-wake decision, split into decideQueuedCommentAction and
//     decideWakeOutcome, applied to the earliest deferred wake queued
//     against the issue a run just released
//   - the release-recovery decision (decideReleaseRecovery), applied once
//     the deferred-wake queue is empty and no wake was promoted
// The caller reads the database and packs the result into a facts object.
// This file only branches on that facts object; it never queries a
// database, reads the clock, or reads the wake context payload directly.

export type PreDrainFacts = {
  /** True when the transaction found the issue row the lock is for. */
  issueRowPresent: boolean;
  /** True when the issue carries no `executionRunId`, or carries the finishing run's own id. False when a different run already holds it. */
  executionRunIdMatchesRun: boolean;
  isWorkspaceValidationFailedRun: boolean;
  isConfigurationIncompleteFailedRun: boolean;
  /** The issue's current status. Only "todo" and "in_progress" can lead to the blocked-notice outcome. */
  issueStatus: string;
  hasAssigneeUser: boolean;
  assigneeAgentMatchesRunAgent: boolean;
  legacyExecutionNeedsReconciliation: boolean;
  /** True when the finishing run is cancelled and its stored result carries an acknowledged execution cancellation. */
  executionCancellationAcknowledged: boolean;
};

export type PreDrainDecision =
  | { kind: "released" }
  | { kind: "blocked"; noticeKind: ReleaseRecoveryBlockedNoticeKind }
  | { kind: "proceed" };

/**
 * Decides the pre-drain release outcome for one lock acquisition, before the
 * caller runs its own lock function. Check order is fixed: the issue-row
 * check runs first, then the blocked-notice check, then legacy-execution
 * reconciliation, then acknowledged execution cancellation. Each check
 * returns as soon as it applies, so an earlier true condition can hide a
 * later one when both hold at the same time. "proceed" means none of the
 * four checks applied; the caller then runs its own write-carrying check
 * and, if that also clears, calls its lock function.
 */
export function decidePreDrain(facts: PreDrainFacts): PreDrainDecision {
  if (!facts.issueRowPresent || !facts.executionRunIdMatchesRun) {
    return { kind: "released" };
  }

  if (
    (facts.isWorkspaceValidationFailedRun || facts.isConfigurationIncompleteFailedRun) &&
    (facts.issueStatus === "todo" || facts.issueStatus === "in_progress") &&
    !facts.hasAssigneeUser &&
    facts.assigneeAgentMatchesRunAgent
  ) {
    return {
      kind: "blocked",
      noticeKind: facts.isConfigurationIncompleteFailedRun ? "configuration_incomplete" : "workspace_validation",
    };
  }

  if (facts.legacyExecutionNeedsReconciliation) {
    return { kind: "released" };
  }

  if (facts.executionCancellationAcknowledged) {
    return { kind: "released" };
  }

  return { kind: "proceed" };
}

export type DeferredWakeQueuedCommentFacts = {
  /** True when the wake carries one or more queued comment ids to check. */
  hasQueuedCommentIds: boolean;
  /** Count of queued comment ids that are still live and not self-authored by the finishing run. */
  liveNonSelfCommentIdsLength: number;
  /** True when the live, non-self comment id list differs from the queued list. */
  liveCommentIdsDiffer: boolean;
  /** True when every discarded comment id was authored by the finishing run. */
  containedSelfAuthoredComment: boolean;
  /** True when the wake carries an independent reason to continue even with no live comments. */
  preservesIndependentContinuation: boolean;
};

export type DeferredWakeQueuedCommentDecision =
  | { kind: "cancel_empty"; selfAuthored: boolean }
  | { kind: "normalize" }
  | { kind: "proceed" };

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

export type DeferredWakeOutcomeFacts = {
  agent: DeferredWakeAgentFacts;
  pauseHold: DeferredWakePauseHoldFacts;
};

export type DeferredWakeOutcomeDecision =
  | { kind: "fail_not_invokable" }
  | { kind: "cancel_pause_hold" }
  | { kind: "promote" };

/** Decides what to do with a deferred wake's queued comment ids. On "normalize", the caller rewrites the ids and then calls `decideWakeOutcome` directly; the rewrite cannot change the agent or pause-hold facts. */
export function decideQueuedCommentAction(
  facts: DeferredWakeQueuedCommentFacts,
): DeferredWakeQueuedCommentDecision {
  if (
    facts.hasQueuedCommentIds &&
    facts.liveNonSelfCommentIdsLength === 0 &&
    !facts.preservesIndependentContinuation
  ) {
    return { kind: "cancel_empty", selfAuthored: facts.containedSelfAuthoredComment };
  }

  if (facts.hasQueuedCommentIds && facts.liveCommentIdsDiffer) {
    return { kind: "normalize" };
  }

  return { kind: "proceed" };
}

/** Decides the outcome for a deferred wake whose queued-comment action resolved to "proceed" (or finished its rewrite): fail, cancel, or promote. */
export function decideWakeOutcome(facts: DeferredWakeOutcomeFacts): DeferredWakeOutcomeDecision {
  const { agent, pauseHold } = facts;

  if (!agent.agentFound || !agent.invokable) {
    return { kind: "fail_not_invokable" };
  }

  if (pauseHold.activePauseHold && !pauseHold.treeHoldInteractionWake) {
    return { kind: "cancel_pause_hold" };
  }

  return { kind: "promote" };
}

/** Shared between the review-participant and immediate branches; the caller derives every field from the same expression regardless of which branch applies. */
export type ReleaseRecoverySharedFacts = {
  hasExistingExecutionPath: boolean;
  hasPersistedMonitor: boolean;
  suppressedByPauseHold: boolean;
  isStrandedRecoveryOrigin: boolean;
  recoveryAgentPresent: boolean;
  recoveryAgentInvokable: boolean;
};

export type ReleaseRecoveryReviewParticipantFacts = {
  /** True when the issue is in_review, unassigned to a user, and waiting on the finishing run as the current agent participant. */
  applies: boolean;
  /** True when the finishing run was itself a review-participant-recovery retry. */
  isExecutionReviewParticipantRecoveryRun: boolean;
};

export type ReleaseRecoveryImmediateFacts = {
  /** True when the issue is todo/in_progress, unassigned to a user, not hidden, still assigned to the finishing run's agent, and the run ended failed/timed_out/cancelled. */
  applies: boolean;
  /** True when the finishing run itself carried the disposition-repair retry reason. */
  isDispositionRepairRetry: boolean;
  hasExplicitBlockerPath: boolean;
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
  shared: ReleaseRecoverySharedFacts;
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

export type ImmediateRecoveryContextLabels = {
  retryReason: "assignment_recovery" | "issue_continuation_needed";
  recoveryReason: "issue_assignment_recovery" | "issue_continuation_needed";
  recoverySource: "issue.assignment_recovery" | "issue.continuation_recovery";
};

/**
 * Derives the three labels an immediate-recovery heartbeat run's context
 * snapshot carries, from the issue's status. A `todo` issue lost its
 * assignment; every other status this decision reaches is a stalled
 * continuation.
 */
export function deriveImmediateRecoveryContextLabels(issueStatus: string): ImmediateRecoveryContextLabels {
  return issueStatus === "todo"
    ? {
        retryReason: "assignment_recovery",
        recoveryReason: "issue_assignment_recovery",
        recoverySource: "issue.assignment_recovery",
      }
    : {
        retryReason: "issue_continuation_needed",
        recoveryReason: "issue_continuation_needed",
        recoverySource: "issue.continuation_recovery",
      };
}

/**
 * Decides the release-recovery outcome once the deferred-wake queue is
 * empty and no wake was promoted. The review-participant branch and the
 * assignment-and-continuation branch are the two ways a released issue can
 * still need automatic recovery; this function evaluates both as one
 * decision, review-participant first, matching the original evaluation
 * order.
 */
export function decideReleaseRecovery(facts: ReleaseRecoveryFacts): ReleaseRecoveryDecision {
  const { reviewParticipant, immediate, shared } = facts;

  if (reviewParticipant.applies) {
    if (
      facts.suppressImmediateRecovery ||
      shared.hasExistingExecutionPath ||
      shared.hasPersistedMonitor ||
      shared.suppressedByPauseHold
    ) {
      return { kind: "released" };
    }
    if (shared.isStrandedRecoveryOrigin) {
      return { kind: "blocked_recovery_in_place" };
    }
    const shouldBlock =
      !shared.recoveryAgentInvokable ||
      !shared.recoveryAgentPresent ||
      reviewParticipant.isExecutionReviewParticipantRecoveryRun;
    if (shouldBlock) {
      return { kind: "blocked", notice: "execution_review_participant" };
    }
    return { kind: "queue_review_participant_recovery" };
  }

  if (immediate.isDispositionRepairRetry) return { kind: "released" };
  if (!immediate.applies) return { kind: "released" };
  if (facts.suppressImmediateRecovery) return { kind: "released" };
  if (shared.hasExistingExecutionPath || shared.hasPersistedMonitor || immediate.hasExplicitBlockerPath) {
    return { kind: "released" };
  }
  if (shared.suppressedByPauseHold) return { kind: "released" };
  if (shared.isStrandedRecoveryOrigin) return { kind: "blocked_recovery_in_place" };

  const shouldBlockImmediately =
    !shared.recoveryAgentInvokable ||
    !shared.recoveryAgentPresent ||
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
