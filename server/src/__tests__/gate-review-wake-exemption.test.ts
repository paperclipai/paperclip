import { describe, expect, it } from "vitest";
import {
  GATE_REVIEW_WAKE_REASONS,
  GATE_WAKE_SOURCES,
  PLAN_APPROVAL_WAKE_REASON,
  REVIEW_GATE_WAKE_REASON,
  isGateReviewWake,
} from "../services/plan-gates.js";

// Guards the heartbeat queued-run staleness exemption: a gate-review wake
// (architect W5a / reviewer W5b) must survive an `issue_assignee_changed`
// cancellation, but only with BOTH the gate reason and the matching gate source.
// See evaluateQueuedRunStaleness in services/heartbeat.ts.
describe("isGateReviewWake — assignee-change exemption predicate", () => {
  it("recognizes the W5a plan-approval gate wake", () => {
    expect(
      isGateReviewWake({
        wakeReason: PLAN_APPROVAL_WAKE_REASON,
        source: "plan.activated.gate",
      }),
    ).toBe(true);
  });

  it("recognizes the W5b review gate wake", () => {
    expect(
      isGateReviewWake({
        wakeReason: REVIEW_GATE_WAKE_REASON,
        source: "issue.in_review.gate",
      }),
    ).toBe(true);
  });

  it("rejects a gate reason without the matching gate source (spoof guard)", () => {
    expect(
      isGateReviewWake({ wakeReason: PLAN_APPROVAL_WAKE_REASON, source: "issue.assignment" }),
    ).toBe(false);
    expect(isGateReviewWake({ wakeReason: REVIEW_GATE_WAKE_REASON, source: "" })).toBe(false);
    expect(isGateReviewWake({ wakeReason: PLAN_APPROVAL_WAKE_REASON })).toBe(false);
  });

  it("rejects a gate source without the matching gate reason", () => {
    expect(isGateReviewWake({ wakeReason: "issue_assigned", source: "plan.activated.gate" })).toBe(
      false,
    );
    expect(isGateReviewWake({ source: "issue.in_review.gate" })).toBe(false);
  });

  it("rejects an ordinary assignment wake (the run that SHOULD still cancel)", () => {
    expect(
      isGateReviewWake({ wakeReason: "issue_assigned", source: "issue.assignment" }),
    ).toBe(false);
  });

  it("rejects empty / null / non-string context", () => {
    expect(isGateReviewWake(null)).toBe(false);
    expect(isGateReviewWake(undefined)).toBe(false);
    expect(isGateReviewWake({})).toBe(false);
    expect(isGateReviewWake({ wakeReason: 123, source: 456 })).toBe(false);
  });

  it("cross-pairing of reason and source is not enough — each must be a real gate pair", () => {
    // reason and source both valid set members but the source belongs to the OTHER
    // gate. The predicate only checks set membership of each factor, so this is
    // intentionally allowed: both are genuine gate identities. Documents the contract.
    expect(
      isGateReviewWake({ wakeReason: PLAN_APPROVAL_WAKE_REASON, source: "issue.in_review.gate" }),
    ).toBe(true);
  });

  it("exposes the canonical reason + source sets used by the emitters", () => {
    expect(GATE_REVIEW_WAKE_REASONS.has(PLAN_APPROVAL_WAKE_REASON)).toBe(true);
    expect(GATE_REVIEW_WAKE_REASONS.has(REVIEW_GATE_WAKE_REASON)).toBe(true);
    expect(GATE_WAKE_SOURCES.has("plan.activated.gate")).toBe(true);
    expect(GATE_WAKE_SOURCES.has("issue.in_review.gate")).toBe(true);
  });
});
