import { describe, expect, it } from "vitest";
import type { NativeEvidenceAssessment } from "./evidence-classifier.js";
import { arbitrateNativeStatus } from "./status-arbiter.js";
import { PLAN_NOT_PRODUCED_REASON } from "./plan-mode-status.js";

const yieldedWait: NativeEvidenceAssessment = {
  objectiveClaimSatisfied: false, objectiveSatisfied: false, allCriteriaSatisfied: false, verificationPassed: false,
  hasFailedVerification: false, hasBlockingRemainingWork: false, reportedDisposition: "yielded",
  summary: "Waiting for plan review", contractRevisionMatches: true, criterionAssessments: [],
  verificationAssessments: [], verificationCaveats: [], acceptedEvidenceRefs: [], missingRequirements: [],
  rejectedEvidence: [], unverifiableEvidence: [], blocker: null,
  continuation: { kind: "response_wake", summary: "Waiting for plan review", idempotencyKey: "plan-review-wake-v1" },
  attentionRequests: [], ignoredAttentionRequests: [],
} as NativeEvidenceAssessment;

const arbitrate = (overrides: Partial<Parameters<typeof arbitrateNativeStatus>[0]>) => arbitrateNativeStatus({
  assessment: yieldedWait, terminalState: "succeeded", workspaceFinalizeStatus: "succeeded",
  agentId: "agent", priorIssueStatus: "in_progress", ...overrides,
});

// Every way a Plan-mode response wait can settle leaves the user one current
// action (the review card is the gate) or schedules the agent to produce one.
describe("Plan-mode response wait settlement", () => {
  it.each([
    { name: "assigned run, plan card open", input: { governanceGate: { kind: "interaction" as const, id: "card" } },
      reasonCode: "governed_response_waiting", next: "card" },
    { name: "comment-started run, plan card open", input: { governanceGate: { kind: "interaction" as const, id: "card" }, boardResponseWaitAuthorized: true, boardResponseWaitOrigin: true },
      reasonCode: "governed_response_waiting", next: "card" },
    { name: "assigned run, no plan", input: { planNotProduced: true },
      reasonCode: PLAN_NOT_PRODUCED_REASON, next: "continuation" },
    { name: "comment-started run, no plan", input: { planNotProduced: true, boardResponseWaitAuthorized: true, boardResponseWaitOrigin: true },
      reasonCode: PLAN_NOT_PRODUCED_REASON, next: "continuation" },
    { name: "comment-started run whose comment was superseded, no plan", input: { planNotProduced: true, boardResponseWaitOrigin: true },
      reasonCode: PLAN_NOT_PRODUCED_REASON, next: "continuation" },
    { name: "second miss after the continuation", input: { planNotProduced: true, allowIncompleteContinuation: false },
      reasonCode: PLAN_NOT_PRODUCED_REASON, next: "recovery" },
  ])("$name", ({ input, reasonCode, next }) => {
    const decision = arbitrate(input);
    expect(decision.reasonCode).toBe(reasonCode);
    const kinds = decision.effects.map(effect => effect.kind);
    if (next === "card") expect(kinds).toContain("create_interaction");
    if (next === "continuation") expect(kinds).toContain("enqueue_continuation");
    if (next === "recovery") expect(kinds).toContain("record_finalization_error");
  });

  it("leaves Standard-mode and conversation waits unchanged", () => {
    expect(arbitrate({}).reasonCode).toBe("response_wake_waiting_for_input");
    expect(arbitrate({ boardResponseWaitAuthorized: true }).reasonCode).toBe("board_response_waiting");
    expect(arbitrate({ planNotProduced: true, isConversation: true }).reasonCode).not.toBe(PLAN_NOT_PRODUCED_REASON);
  });
});
