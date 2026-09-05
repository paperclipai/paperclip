import { describe, expect, it } from "vitest";
import {
  decideQueuedRunStaleness,
  decideScheduledRetryGate,
  type QueuedRunFacts,
  type ReviewParticipantFacts,
  type ScheduledRetryFacts,
} from "./policy.js";

const NOW = new Date("2026-01-01T00:00:00.000Z");

const NO_PARTICIPANT: ReviewParticipantFacts = {
  isInReview: false,
  hasParticipant: false,
  participantIsAgent: false,
  participantAgentId: null,
  currentStageType: null,
  currentParticipant: null,
};

function baseGateFacts(): ScheduledRetryFacts {
  return {
    runId: "run-1",
    runAgentId: "agent-1",
    issueId: "issue-1",
    retryReasonKind: "other",
    enforceIssueExecutionLock: false,
    budgetBlock: null,
    agentInvokable: true,
    agentInvokabilityDetails: {},
    agentInvokabilityInvalidOrgChain: false,
    heartbeatWakeOnDemandEnabled: true,
    issueFound: true,
    issueStatus: "in_progress",
    issueAssigneeAgentId: "agent-1",
    issueExecutionRunId: "run-1",
    isNonAssigneeWorkspaceBusyRetry: false,
    reviewParticipant: NO_PARTICIPANT,
    activePauseHold: null,
    dependenciesBlocked: null,
    dispositionRepair: null,
  };
}

function baseStalenessFacts(): QueuedRunFacts {
  return {
    runId: "run-1",
    runAgentId: "agent-1",
    issueId: "issue-1",
    retryReasonKind: "other",
    issueFound: true,
    issueStatus: "in_progress",
    issueAssigneeAgentId: "agent-1",
    issueExecutionRunId: "run-1",
    isResolvedInteractionContinuation: false,
    isInteractionWake: false,
    isAuthorizedSourceScopedRecovery: false,
    isNonAssigneeWorkspaceBusyRetry: false,
    resumeIntent: false,
    wakeCommentIdPresent: false,
    continuationParkApplies: false,
    continuationParksExecutor: false,
    continuationSummaryBody: null,
    wakeReason: null,
    retryReason: null,
    reviewParticipant: NO_PARTICIPANT,
  };
}

describe("decideScheduledRetryGate", () => {
  it("allows a run with no issueId before any issue check runs", () => {
    const facts = { ...baseGateFacts(), issueId: null, issueFound: false };
    expect(decideScheduledRetryGate(facts, NOW)).toEqual({ allowed: true });
  });

  it("allows a run when every rule passes", () => {
    expect(decideScheduledRetryGate(baseGateFacts(), NOW)).toEqual({
      allowed: true,
    });
  });

  it.each([
    {
      name: "budget_blocked",
      overrides: {
        budgetBlock: { reason: "over budget", scopeType: "company", scopeId: "co-1" },
      } satisfies Partial<ScheduledRetryFacts>,
      errorCode: "budget_blocked",
    },
    {
      name: "agent_not_invokable",
      overrides: { agentInvokable: false } satisfies Partial<ScheduledRetryFacts>,
      errorCode: "agent_not_invokable",
    },
    {
      name: "heartbeat_wake_on_demand_disabled",
      overrides: {
        heartbeatWakeOnDemandEnabled: false,
      } satisfies Partial<ScheduledRetryFacts>,
      errorCode: "heartbeat_wake_on_demand_disabled",
    },
    {
      name: "issue_not_found",
      overrides: { issueFound: false } satisfies Partial<ScheduledRetryFacts>,
      errorCode: "issue_not_found",
    },
    {
      name: "issue_reassigned",
      overrides: {
        issueAssigneeAgentId: "agent-2",
      } satisfies Partial<ScheduledRetryFacts>,
      errorCode: "issue_reassigned",
    },
    {
      name: "issue_cancelled",
      overrides: { issueStatus: "cancelled" } satisfies Partial<ScheduledRetryFacts>,
      errorCode: "issue_cancelled",
    },
    {
      name: "issue_terminal_status (done)",
      overrides: { issueStatus: "done" } satisfies Partial<ScheduledRetryFacts>,
      errorCode: "issue_terminal_status",
    },
    {
      name: "issue_not_in_progress",
      overrides: {
        retryReasonKind: "max_turn_continuation",
        issueStatus: "todo",
      } satisfies Partial<ScheduledRetryFacts>,
      errorCode: "issue_not_in_progress",
    },
    {
      name: "issue_execution_lock_changed",
      overrides: {
        retryReasonKind: "max_turn_continuation",
        enforceIssueExecutionLock: true,
        issueExecutionRunId: "run-2",
      } satisfies Partial<ScheduledRetryFacts>,
      errorCode: "issue_execution_lock_changed",
    },
    {
      name: "issue_review_participant_changed",
      overrides: {
        issueStatus: "in_review",
        reviewParticipant: {
          isInReview: true,
          hasParticipant: true,
          participantIsAgent: true,
          participantAgentId: "agent-2",
          currentStageType: "review",
          currentParticipant: { type: "agent", agentId: "agent-2" },
        },
      } satisfies Partial<ScheduledRetryFacts>,
      errorCode: "issue_review_participant_changed",
    },
    {
      name: "issue_paused",
      overrides: {
        activePauseHold: { holdId: "hold-1", rootIssueId: "issue-root" },
      } satisfies Partial<ScheduledRetryFacts>,
      errorCode: "issue_paused",
    },
    {
      name: "issue_dependencies_blocked",
      overrides: {
        dependenciesBlocked: {
          unresolvedBlockerIssueIds: ["issue-2"],
          unresolvedBlockerCount: 1,
        },
      } satisfies Partial<ScheduledRetryFacts>,
      errorCode: "issue_dependencies_blocked",
    },
    {
      name: "issue_disposition_repair_superseded (fingerprint mismatch)",
      overrides: {
        retryReasonKind: "disposition_repair",
        dispositionRepair: {
          expectedFingerprintPresent: true,
          fingerprintMatches: false,
          hasActiveExecutionPath: false,
          hasDurableWaitingPath: false,
          expectedFingerprint: "fp-old",
          currentFingerprint: "fp-new",
          durablePathReason: null,
        },
      } satisfies Partial<ScheduledRetryFacts>,
      errorCode: "issue_disposition_repair_superseded",
    },
    {
      name: "issue_disposition_repair_superseded (active execution path)",
      overrides: {
        retryReasonKind: "disposition_repair",
        dispositionRepair: {
          expectedFingerprintPresent: true,
          fingerprintMatches: true,
          hasActiveExecutionPath: true,
          hasDurableWaitingPath: false,
          expectedFingerprint: "fp-1",
          currentFingerprint: "fp-1",
          durablePathReason: null,
        },
      } satisfies Partial<ScheduledRetryFacts>,
      errorCode: "issue_disposition_repair_superseded",
    },
  ])("blocks with $errorCode", ({ overrides, errorCode }) => {
    const facts = { ...baseGateFacts(), ...overrides };
    const decision = decideScheduledRetryGate(facts, NOW);
    expect(decision.allowed).toBe(false);
    expect(decision).toMatchObject({ errorCode });
  });

  it("allows a disposition repair retry when the fingerprint matches and no other path is active", () => {
    const facts: ScheduledRetryFacts = {
      ...baseGateFacts(),
      retryReasonKind: "disposition_repair",
      dispositionRepair: {
        expectedFingerprintPresent: true,
        fingerprintMatches: true,
        hasActiveExecutionPath: false,
        hasDurableWaitingPath: false,
        expectedFingerprint: "fp-1",
        currentFingerprint: "fp-1",
        durablePathReason: null,
      },
    };
    expect(decideScheduledRetryGate(facts, NOW)).toEqual({ allowed: true });
  });

  it("allows a reassigned issue when the retry is a non-assignee workspace-busy retry", () => {
    const facts: ScheduledRetryFacts = {
      ...baseGateFacts(),
      issueAssigneeAgentId: "agent-2",
      isNonAssigneeWorkspaceBusyRetry: true,
    };
    expect(decideScheduledRetryGate(facts, NOW)).toEqual({ allowed: true });
  });

  it("keeps the legacy missing-issue exception's precondition: issue_not_found is reported the same way for a non-max-turn retry as for a max-turn retry", () => {
    const nonMaxTurn = decideScheduledRetryGate(
      { ...baseGateFacts(), retryReasonKind: "other", issueFound: false },
      NOW,
    );
    const maxTurn = decideScheduledRetryGate(
      {
        ...baseGateFacts(),
        retryReasonKind: "max_turn_continuation",
        issueFound: false,
      },
      NOW,
    );
    expect(nonMaxTurn).toMatchObject({ allowed: false, errorCode: "issue_not_found" });
    expect(maxTurn).toMatchObject({ allowed: false, errorCode: "issue_not_found" });
  });
});

describe("decideQueuedRunStaleness", () => {
  it("is not stale when every rule passes", () => {
    expect(decideQueuedRunStaleness(baseStalenessFacts(), NOW)).toEqual({
      stale: false,
    });
  });

  it.each([
    {
      name: "issue_not_found",
      overrides: { issueFound: false } satisfies Partial<QueuedRunFacts>,
      errorCode: "issue_not_found",
    },
    {
      name: "issue_assignee_changed (general ownership)",
      overrides: {
        issueAssigneeAgentId: "agent-2",
      } satisfies Partial<QueuedRunFacts>,
      errorCode: "issue_assignee_changed",
    },
    {
      name: "issue_assignee_changed (resolved-interaction continuation)",
      overrides: {
        isResolvedInteractionContinuation: true,
        issueAssigneeAgentId: "agent-2",
      } satisfies Partial<QueuedRunFacts>,
      errorCode: "issue_assignee_changed",
    },
    {
      name: "issue_not_in_progress (resolved-interaction continuation)",
      overrides: {
        isResolvedInteractionContinuation: true,
        issueStatus: "todo",
      } satisfies Partial<QueuedRunFacts>,
      errorCode: "issue_not_in_progress",
    },
    {
      name: "issue_not_in_progress (max-turn continuation)",
      overrides: {
        retryReasonKind: "max_turn_continuation",
        issueStatus: "todo",
      } satisfies Partial<QueuedRunFacts>,
      errorCode: "issue_not_in_progress",
    },
    {
      name: "issue_terminal_status",
      overrides: { issueStatus: "done" } satisfies Partial<QueuedRunFacts>,
      errorCode: "issue_terminal_status",
    },
    {
      name: "issue_execution_lock_changed",
      overrides: {
        retryReasonKind: "max_turn_continuation",
        issueExecutionRunId: "run-2",
      } satisfies Partial<QueuedRunFacts>,
      errorCode: "issue_execution_lock_changed",
    },
    {
      name: "issue_review_participant_changed",
      overrides: {
        issueStatus: "in_review",
        reviewParticipant: {
          isInReview: true,
          hasParticipant: true,
          participantIsAgent: true,
          participantAgentId: "agent-2",
          currentStageType: "review",
          currentParticipant: { type: "agent", agentId: "agent-2" },
        },
      } satisfies Partial<QueuedRunFacts>,
      errorCode: "issue_review_participant_changed",
    },
    {
      name: "issue_continuation_waiting_on_review (parked-summary case)",
      overrides: {
        continuationParkApplies: true,
        continuationParksExecutor: true,
        continuationSummaryBody: "Waiting for reviewer approval before continuing.",
        wakeReason: "issue_continuation_needed",
      } satisfies Partial<QueuedRunFacts>,
      errorCode: "issue_continuation_waiting_on_review",
    },
  ])("cancels with $errorCode", ({ overrides, errorCode }) => {
    const facts = { ...baseStalenessFacts(), ...overrides };
    const decision = decideQueuedRunStaleness(facts, NOW);
    expect(decision.stale).toBe(true);
    expect(decision).toMatchObject({ errorCode });
  });

  it("does not cancel a parked continuation summary when the classifier says it does not park the executor", () => {
    const facts: QueuedRunFacts = {
      ...baseStalenessFacts(),
      continuationParkApplies: true,
      continuationParksExecutor: false,
    };
    expect(decideQueuedRunStaleness(facts, NOW)).toEqual({ stale: false });
  });

  it("allows a comment wake to bypass the ownership, terminal-status, and review-participant checks", () => {
    const facts: QueuedRunFacts = {
      ...baseStalenessFacts(),
      issueAssigneeAgentId: "agent-1",
      isInteractionWake: true,
      wakeCommentIdPresent: true,
      issueStatus: "in_review",
      reviewParticipant: {
        isInReview: true,
        hasParticipant: true,
        participantIsAgent: true,
        participantAgentId: "agent-2",
        currentStageType: "review",
        currentParticipant: { type: "agent", agentId: "agent-2" },
      },
    };
    expect(decideQueuedRunStaleness(facts, NOW)).toEqual({ stale: false });
  });

  it("allows resume intent to bypass a terminal status", () => {
    const facts: QueuedRunFacts = {
      ...baseStalenessFacts(),
      issueStatus: "done",
      resumeIntent: true,
    };
    expect(decideQueuedRunStaleness(facts, NOW)).toEqual({ stale: false });
  });

  it("allows a non-assignee workspace-busy retry to bypass the ownership check", () => {
    const facts: QueuedRunFacts = {
      ...baseStalenessFacts(),
      issueAssigneeAgentId: "agent-2",
      isNonAssigneeWorkspaceBusyRetry: true,
    };
    expect(decideQueuedRunStaleness(facts, NOW)).toEqual({ stale: false });
  });

  it("allows an authorized source-scoped recovery to bypass the ownership check", () => {
    const facts: QueuedRunFacts = {
      ...baseStalenessFacts(),
      issueAssigneeAgentId: "agent-2",
      isAuthorizedSourceScopedRecovery: true,
    };
    expect(decideQueuedRunStaleness(facts, NOW)).toEqual({ stale: false });
  });
});
