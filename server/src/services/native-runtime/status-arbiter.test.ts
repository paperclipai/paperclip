import { describe, expect, it } from "vitest";
import type { NativeEvidenceAssessment } from "./evidence-classifier.js";
import { arbitrateNativeStatus } from "./status-arbiter.js";

function assessment(overrides: Partial<NativeEvidenceAssessment> = {}): NativeEvidenceAssessment {
  return {
    objectiveSatisfied: true,
    allCriteriaSatisfied: true,
    verificationPassed: true,
    hasBlockingRemainingWork: false,
    reportedDisposition: "done",
    summary: "Complete",
    contractRevisionMatches: true,
    criterionAssessments: [],
    verificationAssessments: [],
    acceptedEvidenceRefs: ["event:2"],
    missingRequirements: [],
    rejectedEvidence: [],
    unverifiableEvidence: [],
    blocker: null,
    continuation: null,
    attentionRequests: [],
    ...overrides,
  };
}

function arbitrate(overrides: Partial<Parameters<typeof arbitrateNativeStatus>[0]> = {}) {
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
  it("marks done only from successful finalization and complete durable evidence", () => {
    expect(arbitrate()).toEqual(expect.objectContaining({
      statusAction: "done",
      toStatus: "done",
      reasonCode: "completion_contract_satisfied",
      effects: [{ kind: "release_checkout" }],
    }));
    expect(arbitrate({ completionClaimPolicyAccepted: true })).toEqual(expect.objectContaining({
      statusAction: "done",
      reasonCode: "completion_claim_policy_accepted",
    }));
    expect(arbitrate({
      assessment: assessment({ verificationPassed: false, missingRequirements: ["test"] }),
    })).toEqual(expect.objectContaining({
      statusAction: "in_progress",
      toStatus: "in_progress",
      reasonCode: "completion_evidence_incomplete",
      effects: [expect.objectContaining({ kind: "enqueue_continuation" })],
    }));
  });

  it("creates explicit liveness paths for review, continuation, cancellation, and governance", () => {
    expect(arbitrate({
      assessment: assessment({ reportedDisposition: "needs_review" }),
    })).toEqual(expect.objectContaining({
      toStatus: "in_review",
      effects: [
        expect.objectContaining({ kind: "bind_reviewer" }),
        expect.objectContaining({ kind: "notify_owner" }),
      ],
    }));
    expect(arbitrate({
      assessment: assessment({
        reportedDisposition: "yielded",
        continuation: { kind: "retry", summary: "Retry the task", idempotencyKey: "retry-task" },
      }),
    })).toEqual(expect.objectContaining({
      toStatus: "in_progress",
      effects: [expect.objectContaining({ kind: "enqueue_continuation", continuationKind: "retry" })],
    }));
    expect(arbitrate({ terminalState: "cancelled" })).toEqual(expect.objectContaining({
      toStatus: "in_progress",
      effects: [expect.objectContaining({ kind: "release_run_resources" })],
    }));
    expect(arbitrate({ governanceGate: { kind: "interaction", id: "interaction" } })).toEqual(expect.objectContaining({
      toStatus: "in_review",
      reasonCode: "governed_gate_pending",
      effects: [
        { kind: "create_interaction", gate: { kind: "interaction", id: "interaction" } },
        { kind: "notify_owner", agentId: "agent", reason: "governed_gate_pending" },
      ],
    }));
  });

  it("blocks only for a task-wide blocker with a named owner and action", () => {
    expect(arbitrate({
      assessment: assessment({
        reportedDisposition: "blocked",
        blocker: { boardOwned: true, scope: "task_wide", unblockAction: "Approve access" },
      }),
    })).toEqual(expect.objectContaining({
      toStatus: "blocked",
      unblockDescriptor: { owner: "board", action: "Approve access" },
      effects: [
        { kind: "bind_blocker", owner: "board", action: "Approve access" },
        { kind: "notify_owner", agentId: "agent", reason: "task_wide_blocker_bound" },
      ],
    }));
  });

  it("preserves authoritative terminal statuses", () => {
    expect(arbitrate({ priorIssueStatus: "done" })).toEqual(expect.objectContaining({
      toStatus: "done",
      reasonCode: "terminal_status_preserved",
      effects: [],
    }));
  });
});
