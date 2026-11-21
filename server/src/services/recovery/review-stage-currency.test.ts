import { describe, expect, it } from "vitest";
import {
  evaluateReviewStageCurrency,
  readPolicyStageIds,
} from "./review-stage-currency.js";

const now = new Date("2026-03-19T00:00:00.000Z");

function evaluate(
  overrides: Partial<Parameters<typeof evaluateReviewStageCurrency>[0]> = {},
) {
  return evaluateReviewStageCurrency({
    state: { currentStageId: "stage-1", completedStageIds: [] },
    policyStageIds: ["stage-1"],
    latestDecisionOutcome: null,
    monitorNextCheckAt: null,
    now,
    ...overrides,
  });
}

describe("evaluateReviewStageCurrency", () => {
  it("keeps a pending, current, undecided stage reviewable", () => {
    expect(evaluate()).toBeNull();
    expect(evaluate({ latestDecisionOutcome: "changes_requested" })).toBeNull();
  });

  it("treats a completed stage as obsolete", () => {
    expect(
      evaluate({ state: { currentStageId: "stage-1", completedStageIds: ["stage-1"] } }),
    ).toBe("stage_completed");
  });

  it("treats an approved stage as obsolete", () => {
    expect(evaluate({ latestDecisionOutcome: "approved" })).toBe("stage_approved");
  });

  it("treats a stage missing from the policy as obsolete", () => {
    expect(evaluate({ policyStageIds: ["other"] })).toBe("stage_not_in_policy");
    expect(evaluate({ policyStageIds: null })).toBeNull();
  });

  it("treats a future issue monitor as a durable wait", () => {
    expect(
      evaluate({ monitorNextCheckAt: new Date(now.getTime() + 60_000) }),
    ).toBe("waiting_on_monitor");
    expect(
      evaluate({ monitorNextCheckAt: new Date(now.getTime() - 60_000) }),
    ).toBeNull();
  });
});

describe("readPolicyStageIds", () => {
  it("reads stage ids and tolerates malformed policies", () => {
    expect(readPolicyStageIds({ stages: [{ id: "a" }, { id: "b" }] })).toEqual(["a", "b"]);
    expect(readPolicyStageIds(null)).toBeNull();
    expect(readPolicyStageIds({})).toBeNull();
  });
});
