// Pure decision rules for two heartbeat run-dispatch gates:
//   - the scheduled-retry promotion gate (decideScheduledRetryGate)
//   - the queued-run staleness check (decideQueuedRunStaleness)
// The caller reads the database, the clock, and the agent's invokability,
// then packs the result into a facts object. This file only branches on
// that facts object; it never queries a database or reads the clock.

/** The retry reason a run carries, reduced to the three kinds a gate cares about. */
export type RetryReasonKind =
  | "max_turn_continuation"
  | "disposition_repair"
  | "other";

export type BudgetBlockFacts = {
  reason: string;
  scopeType: string;
  scopeId: string;
};

export type PauseHoldFacts = {
  holdId: string;
  rootIssueId: string;
};

export type DependencyBlockFacts = {
  unresolvedBlockerIssueIds: string[];
  unresolvedBlockerCount: number;
};

export type DispositionRepairFacts = {
  expectedFingerprintPresent: boolean;
  fingerprintMatches: boolean;
  hasActiveExecutionPath: boolean;
  hasDurableWaitingPath: boolean;
  expectedFingerprint: string | null;
  currentFingerprint: string | null;
  durablePathReason: string | null;
};

export type ReviewParticipantFacts = {
  isInReview: boolean;
  hasParticipant: boolean;
  participantIsAgent: boolean;
  participantAgentId: string | null;
  currentStageType: string | null;
  currentParticipant: Record<string, unknown> | null;
};

export type ScheduledRetryGateErrorCode =
  | "agent_not_invokable"
  | "heartbeat_wake_on_demand_disabled"
  | "budget_blocked"
  | "issue_not_found"
  | "issue_reassigned"
  | "issue_cancelled"
  | "issue_terminal_status"
  | "issue_not_in_progress"
  | "issue_execution_lock_changed"
  | "issue_review_participant_changed"
  | "issue_paused"
  | "issue_dependencies_blocked"
  | "issue_disposition_repair_superseded";

export type GateDecision =
  | { allowed: true }
  | {
      allowed: false;
      reason: string;
      errorCode: ScheduledRetryGateErrorCode;
      issueId: string | null;
      details: Record<string, unknown>;
    };

export type ScheduledRetryFacts = {
  runId: string;
  runAgentId: string;
  issueId: string | null;
  retryReasonKind: RetryReasonKind;
  enforceIssueExecutionLock: boolean;

  budgetBlock: BudgetBlockFacts | null;

  agentInvokable: boolean;
  agentInvokabilityDetails: Record<string, unknown>;
  agentInvokabilityInvalidOrgChain: boolean;

  heartbeatWakeOnDemandEnabled: boolean;

  issueFound: boolean;
  issueStatus: string | null;
  issueAssigneeAgentId: string | null;
  issueExecutionRunId: string | null;

  isNonAssigneeWorkspaceBusyRetry: boolean;
  reviewParticipant: ReviewParticipantFacts;
  activePauseHold: PauseHoldFacts | null;
  dependenciesBlocked: DependencyBlockFacts | null;

  /** Present only when retryReasonKind is "disposition_repair". */
  dispositionRepair: DispositionRepairFacts | null;
};

export type QueuedRunStalenessErrorCode =
  | "issue_not_found"
  | "issue_assignee_changed"
  | "issue_terminal_status"
  | "issue_not_in_progress"
  | "issue_execution_lock_changed"
  | "issue_review_participant_changed"
  | "issue_continuation_waiting_on_review";

export type StalenessDecision =
  | { stale: false }
  | {
      stale: true;
      reason: string;
      errorCode: QueuedRunStalenessErrorCode;
      details: Record<string, unknown>;
    };

export type QueuedRunFacts = {
  runId: string;
  runAgentId: string;
  issueId: string;
  retryReasonKind: RetryReasonKind;

  issueFound: boolean;
  issueStatus: string | null;
  issueAssigneeAgentId: string | null;
  issueExecutionRunId: string | null;

  isResolvedInteractionContinuation: boolean;
  isInteractionWake: boolean;
  isAuthorizedSourceScopedRecovery: boolean;
  isNonAssigneeWorkspaceBusyRetry: boolean;

  resumeIntent: boolean;
  wakeCommentIdPresent: boolean;

  /** True when the run's wake or retry reason asks for a continuation the parked-summary check must inspect. */
  continuationParkApplies: boolean;
  /** The pre-classified verdict on whatever continuation summary body applies; only meaningful when continuationParkApplies is true. */
  continuationParksExecutor: boolean;
  continuationSummaryBody: string | null;
  wakeReason: string | null;
  retryReason: string | null;

  reviewParticipant: ReviewParticipantFacts;
};

type OwnershipFacts = {
  runAgentId: string;
  issueAssigneeAgentId: string | null;
  isNonAssigneeWorkspaceBusyRetry: boolean;
  isInteractionWake?: boolean;
  isCurrentReviewParticipant?: boolean;
  isAuthorizedSourceScopedRecovery?: boolean;
};

type OwnershipOutcome = "current_owner" | "reassigned";

/**
 * Decides whether the run's agent still owns the issue. A caller passes
 * only the bypass signals it has; an omitted bypass is treated as absent,
 * not as granted.
 */
function decideIssueOwnership(facts: OwnershipFacts): OwnershipOutcome {
  if (facts.issueAssigneeAgentId === facts.runAgentId) return "current_owner";
  if (facts.isNonAssigneeWorkspaceBusyRetry) return "current_owner";
  if (facts.isInteractionWake) return "current_owner";
  if (facts.isCurrentReviewParticipant) return "current_owner";
  if (facts.isAuthorizedSourceScopedRecovery) return "current_owner";
  return "reassigned";
}

type IssueStatusFacts = {
  status: string | null;
  requiresInProgress: boolean;
  /** When true, a terminal status does not block the run (staleness only). */
  terminalBypass?: boolean;
};

type IssueStatusOutcome = "ok" | "terminal" | "not_in_progress";

/**
 * Decides whether the issue's current status still supports the run. A
 * terminal status is checked before the in-progress requirement, matching
 * the order the gates have always evaluated them in.
 */
function decideIssueStatus(facts: IssueStatusFacts): IssueStatusOutcome {
  const isTerminal = facts.status === "cancelled" || facts.status === "done";
  if (isTerminal && !facts.terminalBypass) return "terminal";
  if (facts.requiresInProgress && facts.status !== "in_progress") {
    return "not_in_progress";
  }
  return "ok";
}

type ExecutionLockFacts = {
  requiresExecutionLock: boolean;
  runId: string;
  issueExecutionRunId: string | null;
};

type ExecutionLockOutcome = "ok" | "lock_changed";

/** Decides whether the issue's execution lock still belongs to this run. */
function decideExecutionLock(facts: ExecutionLockFacts): ExecutionLockOutcome {
  if (facts.requiresExecutionLock && facts.issueExecutionRunId !== facts.runId) {
    return "lock_changed";
  }
  return "ok";
}

type ReviewParticipantCheckFacts = ReviewParticipantFacts & {
  runAgentId: string;
  /** True when a comment wake excuses a participant mismatch (staleness only). */
  bypass?: boolean;
};

type ReviewParticipantOutcome = "ok" | "participant_changed";

/**
 * Decides whether the current review participant still matches the run's
 * agent. An issue with no assigned participant, or one not in review, never
 * blocks here.
 */
function decideReviewParticipant(
  facts: ReviewParticipantCheckFacts,
): ReviewParticipantOutcome {
  if (!facts.isInReview || !facts.hasParticipant) return "ok";
  const participantMatches =
    facts.participantIsAgent && facts.participantAgentId === facts.runAgentId;
  if (participantMatches || facts.bypass) return "ok";
  return "participant_changed";
}

/**
 * Decides whether a due scheduled retry may promote to a queued run. The
 * caller passes now for signature symmetry with future clock-dependent
 * rules; today's rules need no clock read.
 */
export function decideScheduledRetryGate(
  facts: ScheduledRetryFacts,
  _now: Date,
): GateDecision {
  if (facts.budgetBlock) {
    return {
      allowed: false,
      reason: facts.budgetBlock.reason,
      errorCode: "budget_blocked",
      issueId: facts.issueId,
      details: {
        scopeType: facts.budgetBlock.scopeType,
        scopeId: facts.budgetBlock.scopeId,
      },
    };
  }

  if (!facts.agentInvokable) {
    return {
      allowed: false,
      reason: "Scheduled retry suppressed because the agent is not invokable",
      errorCode: "agent_not_invokable",
      issueId: facts.issueId,
      details: {
        ...facts.agentInvokabilityDetails,
        invalidOrgChain: facts.agentInvokabilityInvalidOrgChain,
      },
    };
  }

  if (!facts.heartbeatWakeOnDemandEnabled) {
    return {
      allowed: false,
      reason:
        "Scheduled retry suppressed because on-demand agent wakes are disabled",
      errorCode: "heartbeat_wake_on_demand_disabled",
      issueId: facts.issueId,
      details: { agentId: facts.runAgentId },
    };
  }

  if (!facts.issueId) return { allowed: true };

  if (!facts.issueFound) {
    return {
      allowed: false,
      reason:
        "Scheduled retry suppressed because the target issue no longer exists",
      errorCode: "issue_not_found",
      issueId: facts.issueId,
      details: { issueId: facts.issueId },
    };
  }

  if (facts.retryReasonKind === "disposition_repair" && facts.dispositionRepair) {
    const repair = facts.dispositionRepair;
    const superseded =
      !repair.expectedFingerprintPresent ||
      !repair.fingerprintMatches ||
      repair.hasActiveExecutionPath ||
      repair.hasDurableWaitingPath;
    if (superseded) {
      return {
        allowed: false,
        reason:
          "Scheduled disposition repair suppressed because the source state changed or gained a durable path",
        errorCode: "issue_disposition_repair_superseded",
        issueId: facts.issueId,
        details: {
          issueId: facts.issueId,
          expectedFingerprint: repair.expectedFingerprint,
          currentFingerprint: repair.currentFingerprint,
          hasActiveExecutionPath: repair.hasActiveExecutionPath,
          durablePathReason: repair.durablePathReason,
        },
      };
    }
  }

  const ownership = decideIssueOwnership({
    runAgentId: facts.runAgentId,
    issueAssigneeAgentId: facts.issueAssigneeAgentId,
    isNonAssigneeWorkspaceBusyRetry: facts.isNonAssigneeWorkspaceBusyRetry,
  });
  if (ownership === "reassigned") {
    return {
      allowed: false,
      reason: "Scheduled retry suppressed because issue ownership changed",
      errorCode: "issue_reassigned",
      issueId: facts.issueId,
      details: {
        issueId: facts.issueId,
        previousAssigneeAgentId: facts.runAgentId,
        currentAssigneeAgentId: facts.issueAssigneeAgentId,
      },
    };
  }

  const requiresInProgress = facts.retryReasonKind === "max_turn_continuation";
  const statusOutcome = decideIssueStatus({
    status: facts.issueStatus,
    requiresInProgress,
  });
  if (statusOutcome === "terminal") {
    return {
      allowed: false,
      reason: `Scheduled retry suppressed because issue reached terminal status (${facts.issueStatus})`,
      errorCode:
        facts.issueStatus === "cancelled"
          ? "issue_cancelled"
          : "issue_terminal_status",
      issueId: facts.issueId,
      details: { issueId: facts.issueId, currentStatus: facts.issueStatus },
    };
  }
  if (statusOutcome === "not_in_progress") {
    return {
      allowed: false,
      reason: `Scheduled max-turn continuation suppressed because issue is no longer in_progress (current status: ${facts.issueStatus})`,
      errorCode: "issue_not_in_progress",
      issueId: facts.issueId,
      details: {
        issueId: facts.issueId,
        currentStatus: facts.issueStatus,
        requiredStatus: "in_progress",
      },
    };
  }

  const lockOutcome = decideExecutionLock({
    requiresExecutionLock: requiresInProgress && facts.enforceIssueExecutionLock,
    runId: facts.runId,
    issueExecutionRunId: facts.issueExecutionRunId,
  });
  if (lockOutcome === "lock_changed") {
    return {
      allowed: false,
      reason:
        "Scheduled max-turn continuation suppressed because the issue execution lock belongs to a different run",
      errorCode: "issue_execution_lock_changed",
      issueId: facts.issueId,
      details: {
        issueId: facts.issueId,
        expectedExecutionRunId: facts.runId,
        currentExecutionRunId: facts.issueExecutionRunId,
      },
    };
  }

  const participantOutcome = decideReviewParticipant({
    ...facts.reviewParticipant,
    runAgentId: facts.runAgentId,
  });
  if (participantOutcome === "participant_changed") {
    return {
      allowed: false,
      reason:
        "Scheduled retry suppressed because the issue is waiting on another review participant",
      errorCode: "issue_review_participant_changed",
      issueId: facts.issueId,
      details: {
        issueId: facts.issueId,
        currentStageType: facts.reviewParticipant.currentStageType,
        currentParticipant: facts.reviewParticipant.currentParticipant,
      },
    };
  }

  if (facts.activePauseHold) {
    return {
      allowed: false,
      reason:
        "Scheduled retry suppressed because the issue is held by an active subtree pause hold",
      errorCode: "issue_paused",
      issueId: facts.issueId,
      details: {
        issueId: facts.issueId,
        holdId: facts.activePauseHold.holdId,
        rootIssueId: facts.activePauseHold.rootIssueId,
      },
    };
  }

  if (facts.dependenciesBlocked) {
    return {
      allowed: false,
      reason: "Scheduled retry suppressed because issue dependencies are still blocked",
      errorCode: "issue_dependencies_blocked",
      issueId: facts.issueId,
      details: {
        issueId: facts.issueId,
        unresolvedBlockerIssueIds: facts.dependenciesBlocked.unresolvedBlockerIssueIds,
        unresolvedBlockerCount: facts.dependenciesBlocked.unresolvedBlockerCount,
      },
    };
  }

  return { allowed: true };
}

/**
 * Decides whether a queued run has gone stale before it could start. The
 * caller passes now for signature symmetry with future clock-dependent
 * rules; today's rules need no clock read.
 */
export function decideQueuedRunStaleness(
  facts: QueuedRunFacts,
  _now: Date,
): StalenessDecision {
  if (!facts.issueFound) {
    return {
      stale: true,
      errorCode: "issue_not_found",
      reason: "Cancelled because the target issue no longer exists",
      details: { issueId: facts.issueId },
    };
  }

  if (facts.isResolvedInteractionContinuation) {
    const earlyStatus = decideIssueStatus({
      status: facts.issueStatus,
      requiresInProgress: true,
      terminalBypass: true,
    });
    if (earlyStatus === "not_in_progress") {
      return {
        stale: true,
        errorCode: "issue_not_in_progress",
        reason: `Cancelled because resolved-interaction continuation issue is no longer in_progress (current status: ${facts.issueStatus}) before the queued run could start`,
        details: {
          issueId: facts.issueId,
          currentStatus: facts.issueStatus,
          requiredStatus: "in_progress",
        },
      };
    }

    const earlyOwnership = decideIssueOwnership({
      runAgentId: facts.runAgentId,
      issueAssigneeAgentId: facts.issueAssigneeAgentId,
      isNonAssigneeWorkspaceBusyRetry: false,
    });
    if (earlyOwnership === "reassigned") {
      return {
        stale: true,
        errorCode: "issue_assignee_changed",
        reason:
          "Cancelled because resolved-interaction continuation issue changed assignee before the queued run could start",
        details: {
          issueId: facts.issueId,
          previousAssigneeAgentId: facts.runAgentId,
          currentAssigneeAgentId: facts.issueAssigneeAgentId,
        },
      };
    }
  }

  if (facts.continuationParkApplies && facts.continuationParksExecutor) {
    return {
      stale: true,
      errorCode: "issue_continuation_waiting_on_review",
      reason:
        "Cancelled because the continuation summary says the executor should wait for reviewer feedback or approval before more work starts",
      details: {
        issueId: facts.issueId,
        wakeReason: facts.wakeReason,
        retryReason: facts.retryReason,
        nextAction: facts.continuationSummaryBody,
      },
    };
  }

  const ownership = decideIssueOwnership({
    runAgentId: facts.runAgentId,
    issueAssigneeAgentId: facts.issueAssigneeAgentId,
    isNonAssigneeWorkspaceBusyRetry: facts.isNonAssigneeWorkspaceBusyRetry,
    isInteractionWake: facts.isInteractionWake,
    isCurrentReviewParticipant:
      facts.reviewParticipant.isInReview &&
      facts.reviewParticipant.participantIsAgent &&
      facts.reviewParticipant.participantAgentId === facts.runAgentId,
    isAuthorizedSourceScopedRecovery: facts.isAuthorizedSourceScopedRecovery,
  });
  if (ownership === "reassigned") {
    return {
      stale: true,
      errorCode: "issue_assignee_changed",
      reason:
        "Cancelled because issue assignee changed before the queued run could start; the new owner will be woken instead",
      details: {
        issueId: facts.issueId,
        previousAssigneeAgentId: facts.runAgentId,
        currentAssigneeAgentId: facts.issueAssigneeAgentId,
      },
    };
  }

  const requiresInProgress = facts.retryReasonKind === "max_turn_continuation";
  const statusOutcome = decideIssueStatus({
    status: facts.issueStatus,
    requiresInProgress,
    terminalBypass: facts.resumeIntent || facts.wakeCommentIdPresent,
  });
  if (statusOutcome === "terminal") {
    return {
      stale: true,
      errorCode: "issue_terminal_status",
      reason: `Cancelled because issue reached terminal status (${facts.issueStatus}) before the queued run could start`,
      details: { issueId: facts.issueId, currentStatus: facts.issueStatus },
    };
  }
  if (statusOutcome === "not_in_progress") {
    return {
      stale: true,
      errorCode: "issue_not_in_progress",
      reason: `Cancelled because max-turn continuation issue is no longer in_progress (current status: ${facts.issueStatus}) before the queued run could start`,
      details: {
        issueId: facts.issueId,
        currentStatus: facts.issueStatus,
        requiredStatus: "in_progress",
      },
    };
  }

  const lockOutcome = decideExecutionLock({
    requiresExecutionLock: requiresInProgress,
    runId: facts.runId,
    issueExecutionRunId: facts.issueExecutionRunId,
  });
  if (lockOutcome === "lock_changed") {
    return {
      stale: true,
      errorCode: "issue_execution_lock_changed",
      reason:
        "Cancelled because max-turn continuation no longer owns the issue execution lock before the queued run could start",
      details: {
        issueId: facts.issueId,
        expectedExecutionRunId: facts.runId,
        currentExecutionRunId: facts.issueExecutionRunId,
      },
    };
  }

  const participantOutcome = decideReviewParticipant({
    ...facts.reviewParticipant,
    runAgentId: facts.runAgentId,
    bypass: facts.wakeCommentIdPresent,
  });
  if (participantOutcome === "participant_changed") {
    return {
      stale: true,
      errorCode: "issue_review_participant_changed",
      reason:
        "Cancelled because the in-review participant changed before the queued run could start; the current participant will be woken instead",
      details: {
        issueId: facts.issueId,
        currentStageType: facts.reviewParticipant.currentStageType,
        currentParticipant: facts.reviewParticipant.currentParticipant,
      },
    };
  }

  return { stale: false };
}
