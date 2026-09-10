import { describe, expect, it } from "vitest";
import type { NativeEvidenceAssessment } from "./evidence-classifier.js";
import { arbitrateNativeStatus } from "./status-arbiter.js";

function assessment(
  overrides: Partial<NativeEvidenceAssessment> = {},
): NativeEvidenceAssessment {
  return {
    objectiveClaimSatisfied: true,
    objectiveSatisfied: true,
    allCriteriaSatisfied: true,
    verificationPassed: true,
    hasFailedVerification: false,
    hasBlockingRemainingWork: false,
    reportedDisposition: "done",
    summary: "Complete",
    contractRevisionMatches: true,
    criterionAssessments: [],
    verificationAssessments: [],
    verificationCaveats: [],
    acceptedEvidenceRefs: ["event:2"],
    missingRequirements: [],
    rejectedEvidence: [],
    unverifiableEvidence: [],
    blocker: null,
    continuation: null,
    attentionRequests: [],
    ignoredAttentionRequests: [],
    ...overrides,
  };
}

function arbitrate(
  overrides: Partial<Parameters<typeof arbitrateNativeStatus>[0]> = {},
) {
  return arbitrateNativeStatus({
    assessment: assessment(),
    terminalState: "succeeded",
    workspaceFinalizeStatus: "succeeded",
    agentId: "agent",
    priorIssueStatus: "in_progress",
    ...overrides,
  });
}

describe("native status authority", () => {
  it("treats only the authorized Board response_wake as passive and preserves governance", () => {
    const passive = assessment({
      reportedDisposition: "yielded",
      continuation: {
        kind: "response_wake",
        summary: "Wait for the next request",
        idempotencyKey: "board-wait",
      },
    });
    expect(
      arbitrate({ assessment: passive, boardResponseWaitAuthorized: true }),
    ).toMatchObject({
      reasonCode: "board_response_waiting",
      toStatus: "in_progress",
      effects: [],
    });
    expect(arbitrate({ assessment: passive })).toMatchObject({
      reasonCode: "live_continuation_registered",
      effects: [expect.objectContaining({ kind: "enqueue_continuation" })],
    });
    expect(
      arbitrate({ assessment: passive, boardResponseWaitOrigin: true }),
    ).toMatchObject({
      reasonCode: "board_response_wait_superseded",
      statusAction: "preserve",
      effects: [],
    });
    expect(
      arbitrate({
        assessment: passive,
        boardResponseWaitAuthorized: true,
        governanceGate: { kind: "approval", id: "approval" },
      }),
    ).toMatchObject({
      reasonCode: "governed_response_waiting",
      toStatus: "in_review",
      effects: [expect.objectContaining({ kind: "create_interaction" })],
    });
    for (const kind of ["same_agent", "retry", "monitor"] as const) {
      expect(
        arbitrate({
          assessment: {
            ...passive,
            continuation: { ...passive.continuation!, kind },
          },
          boardResponseWaitAuthorized: true,
        }),
      ).toMatchObject({
        reasonCode: "live_continuation_registered",
        effects: [expect.objectContaining({ continuationKind: kind })],
      });
    }
  });
  it("marks done only from successful finalization and complete durable evidence", () => {
    expect(arbitrate()).toEqual(
      expect.objectContaining({
        statusAction: "done",
        toStatus: "done",
        reasonCode: "completion_contract_satisfied",
        effects: [{ kind: "release_checkout" }],
      }),
    );
    expect(arbitrate({ completionClaimPolicyAccepted: true })).toEqual(
      expect.objectContaining({
        statusAction: "done",
        reasonCode: "completion_claim_policy_accepted",
      }),
    );
    expect(
      arbitrate({
        assessment: assessment({
          verificationPassed: false,
          missingRequirements: ["test"],
        }),
      }),
    ).toEqual(
      expect.objectContaining({
        statusAction: "in_review",
        toStatus: "in_review",
        reasonCode: "external_verification_required",
        effects: [expect.objectContaining({ kind: "bind_reviewer" })],
      }),
    );
    const claimOnly = assessment({
      objectiveSatisfied: false,
      allCriteriaSatisfied: false,
      verificationPassed: false,
      criterionAssessments: [
        {
          criterionId: "objective",
          claimStatus: "satisfied",
          outcome: "missing",
          evidenceRefs: [],
          reasonCode: "criterion_evidence_missing",
        },
      ],
      verificationAssessments: [
        {
          commandOrCheck: "Answered the question",
          claimStatus: "passed",
          outcome: "unverifiable",
          evidenceRef: null,
          reasonCode: "verification_has_no_durable_reference",
          reportedReasonCode: null,
          detail: null,
        },
      ],
      acceptedEvidenceRefs: [],
      missingRequirements: ["objective"],
    });
    expect(arbitrate({ assessment: claimOnly })).toEqual(
      expect.objectContaining({
        toStatus: "in_review",
        reasonCode: "external_verification_required",
      }),
    );
    expect(
      arbitrate({ assessment: claimOnly, completionClaimPolicyAccepted: true }),
    ).toEqual(
      expect.objectContaining({
        toStatus: "done",
        reasonCode: "completion_claim_policy_accepted",
      }),
    );
  });

  it("creates explicit liveness paths for review, continuation, cancellation, and governance", () => {
    expect(
      arbitrate({
        assessment: assessment({ reportedDisposition: "needs_review" }),
      }),
    ).toEqual(
      expect.objectContaining({
        toStatus: "in_review",
        effects: [expect.objectContaining({ kind: "bind_reviewer" })],
      }),
    );
    expect(
      arbitrate({
        assessment: assessment({
          reportedDisposition: "yielded",
          continuation: {
            kind: "retry",
            summary: "Retry the task",
            idempotencyKey: "retry-task",
          },
        }),
      }),
    ).toEqual(
      expect.objectContaining({
        toStatus: "in_progress",
        effects: [
          expect.objectContaining({
            kind: "enqueue_continuation",
            continuationKind: "retry",
          }),
        ],
      }),
    );
    const externalChatWait = assessment({
      reportedDisposition: "yielded",
      continuation: {
        kind: "response_wake",
        summary: "Wait for the next authorized provider message",
        idempotencyKey: "external-chat-wait",
      },
    });
    expect(
      arbitrate({
        assessment: externalChatWait,
        externalChatResponseWaitAuthorization: "authorized",
      }),
    ).toEqual(
      expect.objectContaining({
        statusAction: "in_progress",
        toStatus: "in_progress",
        reasonCode: "external_chat_response_waiting",
        effects: [],
      }),
    );
    expect(
      arbitrate({
        assessment: externalChatWait,
        externalChatResponseWaitAuthorization: "revoked",
      }),
    ).toEqual(
      expect.objectContaining({
        statusAction: "preserve",
        toStatus: "in_progress",
        reasonCode: "external_chat_response_wait_authorization_lost",
        effects: [],
      }),
    );
    expect(
      arbitrate({
        assessment: externalChatWait,
        externalChatResponseWaitAuthorization: "not_applicable",
      }),
    ).toEqual(
      expect.objectContaining({
        reasonCode: "live_continuation_registered",
        effects: [
          expect.objectContaining({
            kind: "enqueue_continuation",
            continuationKind: "response_wake",
          }),
        ],
      }),
    );
    expect(arbitrate({ terminalState: "cancelled" })).toEqual(
      expect.objectContaining({
        toStatus: "in_progress",
        effects: [expect.objectContaining({ kind: "release_run_resources" })],
      }),
    );
    expect(
      arbitrate({ governanceGate: { kind: "interaction", id: "interaction" } }),
    ).toEqual(
      expect.objectContaining({
        toStatus: "in_review",
        reasonCode: "governed_gate_pending",
        effects: [
          {
            kind: "create_interaction",
            gate: { kind: "interaction", id: "interaction" },
          },
          {
            kind: "notify_owner",
            agentId: "agent",
            reason: "governed_gate_pending",
          },
        ],
      }),
    );
    expect(
      arbitrate({
        governanceGate: { kind: "interaction", id: "interaction" },
        assessment: assessment({
          reportedDisposition: "yielded",
          continuation: {
            kind: "response_wake",
            summary: "Resume from the response",
            idempotencyKey: "interaction-response:interaction",
          },
        }),
      }),
    ).toEqual(
      expect.objectContaining({
        toStatus: "in_review",
        reasonCode: "governed_response_waiting",
        effects: [
          {
            kind: "create_interaction",
            gate: { kind: "interaction", id: "interaction" },
          },
        ],
      }),
    );
  });

  it("accepts low-risk completion claims with unrun verification caveats", () => {
    const withCaveat = assessment({
      verificationPassed: false,
      criterionAssessments: [
        {
          criterionId: "objective",
          claimStatus: "satisfied",
          outcome: "missing",
          evidenceRefs: [],
          reasonCode: "criterion_evidence_missing",
        },
      ],
      verificationAssessments: [
        {
          commandOrCheck: "Run npm test",
          claimStatus: "not_run",
          outcome: "missing",
          evidenceRef: null,
          reasonCode: "verification_not_run",
          reportedReasonCode: "tool_unavailable",
          detail: "Node and npm are unavailable in this environment.",
        },
      ],
      verificationCaveats: [
        {
          commandOrCheck: "Run npm test",
          reasonCode: "tool_unavailable",
          detail: "Node and npm are unavailable in this environment.",
        },
      ],
    });

    expect(
      arbitrate({
        assessment: withCaveat,
        completionClaimPolicyAccepted: true,
      }),
    ).toEqual(
      expect.objectContaining({
        toStatus: "done",
        reasonCode: "completion_claim_policy_accepted",
      }),
    );
  });

  it("sends failed verification and actionable attention to owned review without retrying", () => {
    const failed = assessment({
      verificationPassed: false,
      hasFailedVerification: true,
      verificationAssessments: [
        {
          commandOrCheck: "Run npm test",
          claimStatus: "failed",
          outcome: "rejected",
          evidenceRef: null,
          reasonCode: "verification_reported_failed",
          reportedReasonCode: null,
          detail: "One test failed.",
        },
      ],
    });
    expect(
      arbitrate({
        assessment: failed,
        completionClaimPolicyAccepted: true,
        reviewOwnerUserId: "user-1",
      }),
    ).toEqual(
      expect.objectContaining({
        toStatus: "in_review",
        reasonCode: "completion_claim_conflict",
        effects: [
          expect.objectContaining({
            kind: "bind_reviewer",
            ownerUserId: "user-1",
          }),
        ],
      }),
    );

    const withAttention = assessment({
      attentionRequests: [
        {
          kind: "approval",
          summary: "Approve publication",
          ownerClass: "human",
          targetAgentId: null,
          sourceIndex: 0,
          sourceKind: "approval",
          legacy: false,
        },
      ],
    });
    expect(
      arbitrate({
        assessment: withAttention,
        completionClaimPolicyAccepted: true,
      }),
    ).toEqual(
      expect.objectContaining({
        toStatus: "in_review",
        reasonCode: "actionable_attention_pending",
      }),
    );
  });

  it("blocks only for a task-wide blocker with a named owner and action", () => {
    expect(
      arbitrate({
        assessment: assessment({
          reportedDisposition: "blocked",
          blocker: {
            boardOwned: true,
            scope: "task_wide",
            unblockAction: "Approve access",
          },
        }),
      }),
    ).toEqual(
      expect.objectContaining({
        toStatus: "blocked",
        unblockDescriptor: { owner: "board", action: "Approve access" },
        effects: [
          { kind: "bind_blocker", owner: "board", action: "Approve access" },
          {
            kind: "notify_owner",
            agentId: "agent",
            reason: "task_wide_blocker_bound",
          },
        ],
      }),
    );
  });

  it("waits for an explicit unblock instead of inventing another productive track", () => {
    expect(
      arbitrate({
        assessment: assessment({
          reportedDisposition: "blocked",
          objectiveClaimSatisfied: false,
          objectiveSatisfied: false,
          allCriteriaSatisfied: false,
          verificationPassed: false,
          hasBlockingRemainingWork: true,
          blocker: {
            boardOwned: false,
            scope: "current_track",
            unblockAction:
              "Grant access to the current Board comment attachment, then explicitly retry.",
          },
        }),
      }),
    ).toEqual(
      expect.objectContaining({
        statusAction: "blocked",
        toStatus: "blocked",
        policyVersion: "phase6-v4",
        reasonCode: "current_track_blocker_waiting",
        unblockDescriptor: {
          owner: "board",
          action:
            "Grant access to the current Board comment attachment, then explicitly retry.",
        },
        effects: [
          {
            kind: "bind_blocker",
            owner: "board",
            action:
              "Grant access to the current Board comment attachment, then explicitly retry.",
          },
        ],
      }),
    );
  });

  it("blocks a current-track result when a durable dependency already gates the issue", () => {
    expect(
      arbitrate({
        assessment: assessment({
          reportedDisposition: "blocked",
          blocker: {
            boardOwned: false,
            scope: "current_track",
            unblockAction: "Wait for child task DOT-52",
          },
        }),
        hasUnresolvedIssueBlockers: true,
      }),
    ).toEqual(
      expect.objectContaining({
        statusAction: "blocked",
        toStatus: "blocked",
        reasonCode: "durable_dependency_blocker_bound",
        unblockDescriptor: {
          owner: { agentId: "agent" },
          action: "Wait for child task DOT-52",
        },
        effects: [],
      }),
    );
  });

  it("lets a durable dependency override an optimistic done result", () => {
    expect(
      arbitrate({
        assessment: assessment({ reportedDisposition: "done", blocker: null }),
        completionClaimPolicyAccepted: true,
        hasUnresolvedIssueBlockers: true,
      }),
    ).toEqual(
      expect.objectContaining({
        statusAction: "blocked",
        toStatus: "blocked",
        reasonCode: "durable_dependency_blocker_bound",
        effects: [],
      }),
    );
  });

  it("does not create a duplicate review after this run's review was already accepted", () => {
    expect(
      arbitrate({
        assessment: assessment({
          reportedDisposition: "needs_review",
          attentionRequests: [
            {
              kind: "review",
              summary: "Accept the plan",
              ownerClass: "human",
              targetAgentId: null,
              sourceIndex: 0,
              sourceKind: "review",
              legacy: false,
            },
          ],
        }),
        governanceResolvedForRun: true,
      }),
    ).toEqual(
      expect.objectContaining({
        statusAction: "in_review",
        reasonCode: "governance_response_continuation_queued",
        effects: [],
      }),
    );
  });

  it("does not create a duplicate review after this run's planning confirmation was already accepted", () => {
    expect(
      arbitrate({
        assessment: assessment({
          reportedDisposition: "blocked",
          attentionRequests: [
            {
              kind: "approval",
              summary: "Accept the pinned plan revision.",
              ownerClass: "human",
              targetAgentId: null,
              sourceIndex: 0,
              sourceKind: "approval",
              legacy: false,
            },
          ],
        }),
        governanceResolvedForRun: true,
      }),
    ).toEqual(
      expect.objectContaining({
        statusAction: "in_review",
        reasonCode: "governance_response_continuation_queued",
        effects: [],
      }),
    );
  });

  it("preserves authoritative terminal statuses", () => {
    expect(arbitrate({ priorIssueStatus: "done" })).toEqual(
      expect.objectContaining({
        toStatus: "done",
        reasonCode: "terminal_status_preserved",
        effects: [],
      }),
    );
  });
});
