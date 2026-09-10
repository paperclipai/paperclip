import { describe, expect, it } from "vitest";
import {
  decideDeferredWake,
  decideReleaseRecovery,
  type DeferredWakeFacts,
  type ReleaseRecoveryFacts,
} from "./policy.js";

const baseDeferredWakeFacts: DeferredWakeFacts = {
  queuedComment: {
    hasQueuedCommentIds: false,
    liveNonSelfCommentIdsLength: 0,
    queuedCommentIdsLength: 0,
    liveCommentIdsChanged: false,
    containedSelfAuthoredComment: false,
    preservesIndependentContinuation: false,
  },
  agent: { agentFound: true, invokable: true },
  pauseHold: { activePauseHold: false, treeHoldInteractionWake: false },
};

describe("decideDeferredWake", () => {
  const cases: Array<{
    name: string;
    facts: DeferredWakeFacts;
    expected: ReturnType<typeof decideDeferredWake>;
  }> = [
    {
      name: "cancel_empty: all queued comments discarded and no independent continuation",
      facts: {
        ...baseDeferredWakeFacts,
        queuedComment: {
          hasQueuedCommentIds: true,
          liveNonSelfCommentIdsLength: 0,
          queuedCommentIdsLength: 2,
          liveCommentIdsChanged: true,
          containedSelfAuthoredComment: false,
          preservesIndependentContinuation: false,
        },
      },
      expected: { kind: "cancel_empty", selfAuthored: false },
    },
    {
      name: "cancel_empty: self-authored comments discarded, error text reflects self-authorship",
      facts: {
        ...baseDeferredWakeFacts,
        queuedComment: {
          hasQueuedCommentIds: true,
          liveNonSelfCommentIdsLength: 0,
          queuedCommentIdsLength: 1,
          liveCommentIdsChanged: true,
          containedSelfAuthoredComment: true,
          preservesIndependentContinuation: false,
        },
      },
      expected: { kind: "cancel_empty", selfAuthored: true },
    },
    {
      name: "normalize: no live comments, but an independent continuation reason still rewrites the queued id list",
      facts: {
        ...baseDeferredWakeFacts,
        queuedComment: {
          hasQueuedCommentIds: true,
          liveNonSelfCommentIdsLength: 0,
          queuedCommentIdsLength: 1,
          liveCommentIdsChanged: true,
          containedSelfAuthoredComment: false,
          preservesIndependentContinuation: true,
        },
      },
      expected: { kind: "normalize" },
    },
    {
      name: "promote: an independent continuation reason keeps the wake alive with the live id set already matching",
      facts: {
        ...baseDeferredWakeFacts,
        queuedComment: {
          hasQueuedCommentIds: true,
          liveNonSelfCommentIdsLength: 0,
          queuedCommentIdsLength: 0,
          liveCommentIdsChanged: false,
          containedSelfAuthoredComment: false,
          preservesIndependentContinuation: true,
        },
      },
      expected: { kind: "promote" },
    },
    {
      name: "normalize: the live comment id set differs from the queued set",
      facts: {
        ...baseDeferredWakeFacts,
        queuedComment: {
          hasQueuedCommentIds: true,
          liveNonSelfCommentIdsLength: 1,
          queuedCommentIdsLength: 2,
          liveCommentIdsChanged: true,
          containedSelfAuthoredComment: false,
          preservesIndependentContinuation: false,
        },
      },
      expected: { kind: "normalize" },
    },
    {
      name: "fail_not_invokable: the agent lookup returns not-found",
      facts: {
        ...baseDeferredWakeFacts,
        agent: { agentFound: false, invokable: false },
      },
      expected: { kind: "fail_not_invokable" },
    },
    {
      name: "fail_not_invokable: the agent is found but not invokable",
      facts: {
        ...baseDeferredWakeFacts,
        agent: { agentFound: true, invokable: false },
      },
      expected: { kind: "fail_not_invokable" },
    },
    {
      name: "cancel_pause_hold: an active pause hold with no verified tree-hold interaction",
      facts: {
        ...baseDeferredWakeFacts,
        pauseHold: { activePauseHold: true, treeHoldInteractionWake: false },
      },
      expected: { kind: "cancel_pause_hold" },
    },
    {
      name: "promote: an active pause hold but a verified tree-hold interaction wake survives it",
      facts: {
        ...baseDeferredWakeFacts,
        pauseHold: { activePauseHold: true, treeHoldInteractionWake: true },
      },
      expected: { kind: "promote" },
    },
    {
      name: "promote: no queued comments, an invokable agent, and no pause hold",
      facts: baseDeferredWakeFacts,
      expected: { kind: "promote" },
    },
  ];

  for (const testCase of cases) {
    it(testCase.name, () => {
      expect(decideDeferredWake(testCase.facts)).toEqual(testCase.expected);
    });
  }
});

const baseReleaseRecoveryFacts: ReleaseRecoveryFacts = {
  suppressImmediateRecovery: false,
  reviewParticipant: {
    applies: false,
    hasExistingExecutionPath: false,
    hasPersistedMonitor: false,
    suppressedByPauseHold: false,
    isStrandedRecoveryOrigin: false,
    recoveryAgentPresent: true,
    recoveryAgentInvokable: true,
    isExecutionReviewParticipantRecoveryRun: false,
  },
  immediate: {
    applies: false,
    isDispositionRepairRetry: false,
    hasExistingExecutionPath: false,
    hasPersistedMonitor: false,
    hasExplicitBlockerPath: false,
    suppressedByPauseHold: false,
    isStrandedRecoveryOrigin: false,
    recoveryAgentPresent: true,
    recoveryAgentInvokable: true,
    isWorkspaceValidationFailedRun: false,
    isConfigurationIncompleteFailedRun: false,
    automaticRecoveryAlreadyFailed: false,
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
        immediate: {
          ...baseReleaseRecoveryFacts.immediate,
          applies: true,
          hasExistingExecutionPath: true,
        },
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
        immediate: {
          ...baseReleaseRecoveryFacts.immediate,
          applies: true,
          isStrandedRecoveryOrigin: true,
        },
      },
      expected: { kind: "blocked_recovery_in_place" },
    },
    {
      name: "blocked: immediate recovery applies but the recovery agent is not invokable",
      facts: {
        ...baseReleaseRecoveryFacts,
        immediate: {
          ...baseReleaseRecoveryFacts.immediate,
          applies: true,
          recoveryAgentInvokable: false,
        },
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
        reviewParticipant: {
          ...baseReleaseRecoveryFacts.reviewParticipant,
          applies: true,
          hasPersistedMonitor: true,
        },
      },
      expected: { kind: "released" },
    },
    {
      name: "blocked_recovery_in_place: review-participant recovery applies on a stranded-issue-recovery origin",
      facts: {
        ...baseReleaseRecoveryFacts,
        reviewParticipant: {
          ...baseReleaseRecoveryFacts.reviewParticipant,
          applies: true,
          isStrandedRecoveryOrigin: true,
        },
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
        immediate: {
          ...baseReleaseRecoveryFacts.immediate,
          applies: true,
          isStrandedRecoveryOrigin: true,
        },
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
