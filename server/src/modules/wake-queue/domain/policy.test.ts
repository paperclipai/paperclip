import { describe, expect, it } from "vitest";
import {
  decidePreDrain,
  decideQueuedCommentAction,
  decideReleaseRecovery,
  decideWakeAdmission,
  decideWakeOutcome,
  deriveImmediateRecoveryContextLabels,
  type DeferredWakeOutcomeFacts,
  type DeferredWakeQueuedCommentFacts,
  type ImmediateRecoveryContextLabels,
  type PreDrainFacts,
  type ReleaseRecoveryFacts,
  type WakeAdmissionFacts,
} from "./policy.js";

const basePreDrainFacts: PreDrainFacts = {
  issueRowPresent: true,
  executionRunIdMatchesRun: true,
  isWorkspaceValidationFailedRun: false,
  isConfigurationIncompleteFailedRun: false,
  issueStatus: "in_progress",
  hasAssigneeUser: false,
  assigneeAgentMatchesRunAgent: true,
  legacyExecutionNeedsReconciliation: false,
  executionCancellationAcknowledged: false,
};

describe("decidePreDrain", () => {
  const cases: Array<{
    name: string;
    facts: PreDrainFacts;
    expected: ReturnType<typeof decidePreDrain>;
  }> = [
    {
      name: "released: the issue row is missing",
      facts: { ...basePreDrainFacts, issueRowPresent: false },
      expected: { kind: "released" },
    },
    {
      name: "released: another run already holds executionRunId",
      facts: { ...basePreDrainFacts, executionRunIdMatchesRun: false },
      expected: { kind: "released" },
    },
    {
      name: "blocked: a workspace-validation failure on an eligible todo issue",
      facts: { ...basePreDrainFacts, isWorkspaceValidationFailedRun: true, issueStatus: "todo" },
      expected: { kind: "blocked", noticeKind: "workspace_validation" },
    },
    {
      name: "blocked: a configuration-incomplete failure on an eligible in_progress issue",
      facts: { ...basePreDrainFacts, isConfigurationIncompleteFailedRun: true, issueStatus: "in_progress" },
      expected: { kind: "blocked", noticeKind: "configuration_incomplete" },
    },
    {
      name: "proceed: a workspace-validation failure on an issue that is not todo or in_progress",
      facts: { ...basePreDrainFacts, isWorkspaceValidationFailedRun: true, issueStatus: "in_review" },
      expected: { kind: "proceed" },
    },
    {
      name: "proceed: a workspace-validation failure but the issue already has an assigned user",
      facts: {
        ...basePreDrainFacts,
        isWorkspaceValidationFailedRun: true,
        issueStatus: "todo",
        hasAssigneeUser: true,
      },
      expected: { kind: "proceed" },
    },
    {
      name: "proceed: a workspace-validation failure but the assigned agent does not match the finishing run's agent",
      facts: {
        ...basePreDrainFacts,
        isWorkspaceValidationFailedRun: true,
        issueStatus: "todo",
        assigneeAgentMatchesRunAgent: false,
      },
      expected: { kind: "proceed" },
    },
    {
      name: "released: legacy execution needs reconciliation",
      facts: { ...basePreDrainFacts, legacyExecutionNeedsReconciliation: true },
      expected: { kind: "released" },
    },
    {
      name: "released: an acknowledged execution cancellation",
      facts: { ...basePreDrainFacts, executionCancellationAcknowledged: true },
      expected: { kind: "released" },
    },
    {
      name: "proceed: none of the pre-drain conditions apply",
      facts: basePreDrainFacts,
      expected: { kind: "proceed" },
    },
    {
      name: "the blocked-notice check is evaluated before legacy-execution reconciliation",
      facts: {
        ...basePreDrainFacts,
        isWorkspaceValidationFailedRun: true,
        issueStatus: "todo",
        // If reconciliation were checked first, this would force a "released"
        // outcome; the expected "blocked" here proves the blocked-notice
        // check, evaluated first, decides the outcome.
        legacyExecutionNeedsReconciliation: true,
      },
      expected: { kind: "blocked", noticeKind: "workspace_validation" },
    },
    {
      name: "the blocked-notice check is evaluated before an acknowledged execution cancellation",
      facts: {
        ...basePreDrainFacts,
        isConfigurationIncompleteFailedRun: true,
        issueStatus: "todo",
        // If the cancellation check were checked first, this would force a
        // "released" outcome; the expected "blocked" here proves the
        // blocked-notice check, evaluated first, decides the outcome.
        executionCancellationAcknowledged: true,
      },
      expected: { kind: "blocked", noticeKind: "configuration_incomplete" },
    },
  ];

  for (const testCase of cases) {
    it(testCase.name, () => {
      expect(decidePreDrain(testCase.facts)).toEqual(testCase.expected);
    });
  }
});

const baseQueuedCommentFacts: DeferredWakeQueuedCommentFacts = {
  hasQueuedCommentIds: false,
  liveNonSelfCommentIdsLength: 0,
  liveCommentIdsDiffer: false,
  containedSelfAuthoredComment: false,
  preservesIndependentContinuation: false,
};

describe("decideQueuedCommentAction", () => {
  const cases: Array<{
    name: string;
    facts: DeferredWakeQueuedCommentFacts;
    expected: ReturnType<typeof decideQueuedCommentAction>;
  }> = [
    {
      name: "cancel_empty: all queued comments discarded and no independent continuation",
      facts: {
        ...baseQueuedCommentFacts,
        hasQueuedCommentIds: true,
        liveNonSelfCommentIdsLength: 0,
        liveCommentIdsDiffer: true,
        containedSelfAuthoredComment: false,
        preservesIndependentContinuation: false,
      },
      expected: { kind: "cancel_empty", selfAuthored: false },
    },
    {
      name: "cancel_empty: self-authored comments discarded, error text reflects self-authorship",
      facts: {
        ...baseQueuedCommentFacts,
        hasQueuedCommentIds: true,
        liveNonSelfCommentIdsLength: 0,
        liveCommentIdsDiffer: true,
        containedSelfAuthoredComment: true,
        preservesIndependentContinuation: false,
      },
      expected: { kind: "cancel_empty", selfAuthored: true },
    },
    {
      name: "normalize: no live comments, but an independent continuation reason still rewrites the queued id list",
      facts: {
        ...baseQueuedCommentFacts,
        hasQueuedCommentIds: true,
        liveNonSelfCommentIdsLength: 0,
        liveCommentIdsDiffer: true,
        containedSelfAuthoredComment: false,
        preservesIndependentContinuation: true,
      },
      expected: { kind: "normalize" },
    },
    {
      name: "proceed: an independent continuation reason keeps the wake alive with the live id set already matching",
      facts: {
        ...baseQueuedCommentFacts,
        hasQueuedCommentIds: true,
        liveNonSelfCommentIdsLength: 0,
        liveCommentIdsDiffer: false,
        containedSelfAuthoredComment: false,
        preservesIndependentContinuation: true,
      },
      expected: { kind: "proceed" },
    },
    {
      name: "normalize: the live comment id set differs from the queued set",
      facts: {
        ...baseQueuedCommentFacts,
        hasQueuedCommentIds: true,
        liveNonSelfCommentIdsLength: 1,
        liveCommentIdsDiffer: true,
        containedSelfAuthoredComment: false,
        preservesIndependentContinuation: false,
      },
      expected: { kind: "normalize" },
    },
    {
      name: "proceed: no queued comments",
      facts: baseQueuedCommentFacts,
      expected: { kind: "proceed" },
    },
    {
      name: "proceed: queued comments are all still live, matching the queued set",
      facts: {
        ...baseQueuedCommentFacts,
        hasQueuedCommentIds: true,
        liveNonSelfCommentIdsLength: 1,
        liveCommentIdsDiffer: false,
      },
      expected: { kind: "proceed" },
    },
  ];

  for (const testCase of cases) {
    it(testCase.name, () => {
      expect(decideQueuedCommentAction(testCase.facts)).toEqual(testCase.expected);
    });
  }
});

const baseWakeOutcomeFacts: DeferredWakeOutcomeFacts = {
  agent: { agentFound: true, invokable: true },
  pauseHold: { activePauseHold: false, treeHoldInteractionWake: false },
};

describe("decideWakeOutcome", () => {
  const cases: Array<{
    name: string;
    facts: DeferredWakeOutcomeFacts;
    expected: ReturnType<typeof decideWakeOutcome>;
  }> = [
    {
      name: "fail_not_invokable: the agent lookup returns not-found",
      facts: { ...baseWakeOutcomeFacts, agent: { agentFound: false, invokable: false } },
      expected: { kind: "fail_not_invokable" },
    },
    {
      name: "fail_not_invokable: the agent is found but not invokable",
      facts: { ...baseWakeOutcomeFacts, agent: { agentFound: true, invokable: false } },
      expected: { kind: "fail_not_invokable" },
    },
    {
      name: "cancel_pause_hold: an active pause hold with no verified tree-hold interaction",
      facts: { ...baseWakeOutcomeFacts, pauseHold: { activePauseHold: true, treeHoldInteractionWake: false } },
      expected: { kind: "cancel_pause_hold" },
    },
    {
      name: "promote: an active pause hold but a verified tree-hold interaction wake survives it",
      facts: { ...baseWakeOutcomeFacts, pauseHold: { activePauseHold: true, treeHoldInteractionWake: true } },
      expected: { kind: "promote" },
    },
    {
      name: "promote: an invokable agent and no pause hold",
      facts: baseWakeOutcomeFacts,
      expected: { kind: "promote" },
    },
  ];

  for (const testCase of cases) {
    it(testCase.name, () => {
      expect(decideWakeOutcome(testCase.facts)).toEqual(testCase.expected);
    });
  }
});

const baseReleaseRecoveryFacts: ReleaseRecoveryFacts = {
  suppressImmediateRecovery: false,
  reviewParticipant: {
    applies: false,
    isExecutionReviewParticipantRecoveryRun: false,
  },
  immediate: {
    applies: false,
    isDispositionRepairRetry: false,
    hasExplicitBlockerPath: false,
    isWorkspaceValidationFailedRun: false,
    isConfigurationIncompleteFailedRun: false,
    automaticRecoveryAlreadyFailed: false,
  },
  shared: {
    hasExistingExecutionPath: false,
    hasPersistedMonitor: false,
    suppressedByPauseHold: false,
    isStrandedRecoveryOrigin: false,
    recoveryAgentPresent: true,
    recoveryAgentInvokable: true,
  },
};

describe("decideReleaseRecovery", () => {
  const cases: Array<{
    name: string;
    facts: ReleaseRecoveryFacts;
    expected: ReturnType<typeof decideReleaseRecovery>;
  }> = [
    {
      name: "released: neither the review-participant nor the immediate-recovery branch applies",
      facts: baseReleaseRecoveryFacts,
      expected: { kind: "released" },
    },
    {
      name: "released: immediate recovery applies but the caller asked to suppress it",
      facts: {
        ...baseReleaseRecoveryFacts,
        suppressImmediateRecovery: true,
        immediate: { ...baseReleaseRecoveryFacts.immediate, applies: true },
      },
      expected: { kind: "released" },
    },
    {
      name: "released: immediate recovery applies but an existing execution path already covers it",
      facts: {
        ...baseReleaseRecoveryFacts,
        immediate: { ...baseReleaseRecoveryFacts.immediate, applies: true },
        shared: { ...baseReleaseRecoveryFacts.shared, hasExistingExecutionPath: true },
      },
      expected: { kind: "released" },
    },
    {
      name: "released: immediate recovery applies but the finishing run carried the disposition-repair retry reason",
      facts: {
        ...baseReleaseRecoveryFacts,
        immediate: {
          ...baseReleaseRecoveryFacts.immediate,
          applies: true,
          isDispositionRepairRetry: true,
        },
      },
      expected: { kind: "released" },
    },
    {
      name: "released: immediate recovery applies but an explicit blocker path exists",
      facts: {
        ...baseReleaseRecoveryFacts,
        immediate: {
          ...baseReleaseRecoveryFacts.immediate,
          applies: true,
          hasExplicitBlockerPath: true,
        },
      },
      expected: { kind: "released" },
    },
    {
      name: "blocked_recovery_in_place: immediate recovery applies on a stranded-issue-recovery origin",
      facts: {
        ...baseReleaseRecoveryFacts,
        immediate: { ...baseReleaseRecoveryFacts.immediate, applies: true },
        shared: { ...baseReleaseRecoveryFacts.shared, isStrandedRecoveryOrigin: true },
      },
      expected: { kind: "blocked_recovery_in_place" },
    },
    {
      name: "blocked: immediate recovery applies but the recovery agent is not invokable",
      facts: {
        ...baseReleaseRecoveryFacts,
        immediate: { ...baseReleaseRecoveryFacts.immediate, applies: true },
        shared: { ...baseReleaseRecoveryFacts.shared, recoveryAgentInvokable: false },
      },
      expected: { kind: "blocked", notice: "immediate_execution_path" },
    },
    {
      name: "blocked: immediate recovery applies and the run failed workspace validation",
      facts: {
        ...baseReleaseRecoveryFacts,
        immediate: {
          ...baseReleaseRecoveryFacts.immediate,
          applies: true,
          isWorkspaceValidationFailedRun: true,
        },
      },
      expected: { kind: "blocked", notice: "workspace_validation" },
    },
    {
      name: "blocked: immediate recovery applies and the run failed on incomplete configuration",
      facts: {
        ...baseReleaseRecoveryFacts,
        immediate: {
          ...baseReleaseRecoveryFacts.immediate,
          applies: true,
          isConfigurationIncompleteFailedRun: true,
        },
      },
      expected: { kind: "blocked", notice: "configuration_incomplete" },
    },
    {
      name: "queue_recovery: immediate recovery applies and no suppression or block condition fires",
      facts: {
        ...baseReleaseRecoveryFacts,
        immediate: { ...baseReleaseRecoveryFacts.immediate, applies: true },
      },
      expected: { kind: "queue_recovery" },
    },
    {
      name: "released: review-participant recovery applies but a persisted monitor already covers it",
      facts: {
        ...baseReleaseRecoveryFacts,
        reviewParticipant: { ...baseReleaseRecoveryFacts.reviewParticipant, applies: true },
        shared: { ...baseReleaseRecoveryFacts.shared, hasPersistedMonitor: true },
      },
      expected: { kind: "released" },
    },
    {
      name: "blocked_recovery_in_place: review-participant recovery applies on a stranded-issue-recovery origin",
      facts: {
        ...baseReleaseRecoveryFacts,
        reviewParticipant: { ...baseReleaseRecoveryFacts.reviewParticipant, applies: true },
        shared: { ...baseReleaseRecoveryFacts.shared, isStrandedRecoveryOrigin: true },
      },
      expected: { kind: "blocked_recovery_in_place" },
    },
    {
      name: "blocked: review-participant recovery applies but the finishing run was itself that recovery retry",
      facts: {
        ...baseReleaseRecoveryFacts,
        reviewParticipant: {
          ...baseReleaseRecoveryFacts.reviewParticipant,
          applies: true,
          isExecutionReviewParticipantRecoveryRun: true,
        },
      },
      expected: { kind: "blocked", notice: "execution_review_participant" },
    },
    {
      name: "queue_review_participant_recovery: review-participant recovery applies and no suppression or block condition fires",
      facts: {
        ...baseReleaseRecoveryFacts,
        reviewParticipant: { ...baseReleaseRecoveryFacts.reviewParticipant, applies: true },
      },
      expected: { kind: "queue_review_participant_recovery" },
    },
    {
      name: "review-participant recovery is evaluated before immediate recovery when both apply",
      facts: {
        ...baseReleaseRecoveryFacts,
        reviewParticipant: { ...baseReleaseRecoveryFacts.reviewParticipant, applies: true },
        // If the immediate branch were evaluated instead, this flag would force a
        // "blocked" outcome; the expected "queue_review_participant_recovery" here
        // proves the review-participant branch, checked first, decides the outcome.
        immediate: { ...baseReleaseRecoveryFacts.immediate, applies: true, isWorkspaceValidationFailedRun: true },
      },
      expected: { kind: "queue_review_participant_recovery" },
    },
  ];

  for (const testCase of cases) {
    it(testCase.name, () => {
      expect(decideReleaseRecovery(testCase.facts)).toEqual(testCase.expected);
    });
  }
});

describe("deriveImmediateRecoveryContextLabels", () => {
  const cases: Array<{
    name: string;
    issueStatus: string;
    expected: ImmediateRecoveryContextLabels;
  }> = [
    {
      name: "todo: the issue lost its assignment",
      issueStatus: "todo",
      expected: {
        retryReason: "assignment_recovery",
        recoveryReason: "issue_assignment_recovery",
        recoverySource: "issue.assignment_recovery",
      },
    },
    {
      name: "not todo: an in_progress issue is a stalled continuation",
      issueStatus: "in_progress",
      expected: {
        retryReason: "issue_continuation_needed",
        recoveryReason: "issue_continuation_needed",
        recoverySource: "issue.continuation_recovery",
      },
    },
    {
      name: "not todo: any other status also derives the stalled-continuation labels",
      issueStatus: "in_review",
      expected: {
        retryReason: "issue_continuation_needed",
        recoveryReason: "issue_continuation_needed",
        recoverySource: "issue.continuation_recovery",
      },
    },
  ];

  for (const testCase of cases) {
    it(testCase.name, () => {
      expect(deriveImmediateRecoveryContextLabels(testCase.issueStatus)).toEqual(testCase.expected);
    });
  }
});

const baseWakeAdmissionFacts: WakeAdmissionFacts = {
  isSameExecutionAgent: true,
  shouldDeferFollowupWake: false,
  shouldQueueFollowupForRunningWake: false,
  availableActiveExecutionRunPresent: true,
};

describe("decideWakeAdmission", () => {
  const cases: Array<{
    name: string;
    facts: WakeAdmissionFacts;
    expected: ReturnType<typeof decideWakeAdmission>;
  }> = [
    {
      name: "coalesce: same execution agent, no defer condition, and a live coalesce target",
      facts: baseWakeAdmissionFacts,
      expected: { kind: "coalesce" },
    },
    {
      name: "defer: same execution agent, but the running agent needs a fresh session",
      facts: { ...baseWakeAdmissionFacts, shouldDeferFollowupWake: true },
      expected: { kind: "defer" },
    },
    {
      name: "defer: same execution agent, but the running turn must finish first",
      facts: { ...baseWakeAdmissionFacts, shouldQueueFollowupForRunningWake: true },
      expected: { kind: "defer" },
    },
    {
      name: "defer: a different agent already holds the execution lock",
      facts: { ...baseWakeAdmissionFacts, isSameExecutionAgent: false },
      expected: { kind: "defer" },
    },
    {
      name: "proceed: the zombie-run filter leaves no live coalesce target",
      facts: { ...baseWakeAdmissionFacts, availableActiveExecutionRunPresent: false },
      expected: { kind: "proceed" },
    },
  ];

  for (const testCase of cases) {
    it(testCase.name, () => {
      expect(decideWakeAdmission(testCase.facts)).toEqual(testCase.expected);
    });
  }
});
