import { describe, expect, it } from "vitest";
import { AGENT_ARC_TOTAL_STEPS, agentArcStepFor } from "./Stepper";

describe("agentArcStepFor", () => {
  it("numbers the arc from the agent step, not from the wizard's first step", () => {
    // The wizard's step 3 is the customer's step 1: company creation happened
    // in Cloud, and the mission step is skipped when it did.
    expect(agentArcStepFor(3)).toBe(1);
    expect(agentArcStepFor(4)).toBe(2);
    expect(agentArcStepFor(5)).toBe(3);
  });

  it("has no position for steps outside the arc", () => {
    // The front door and the company/mission steps are not part of the
    // sequence the strip counts, so they must not render one.
    for (const wizardStep of [0, 1, 2, 6]) {
      expect(agentArcStepFor(wizardStep)).toBeNull();
    }
  });

  it("never numbers a step past the total it advertises", () => {
    // "Step 4 of 3" is the failure an arithmetic mapping produces the first
    // time a step is added ahead of the arc.
    for (const wizardStep of [-1, 0, 1, 2, 3, 4, 5, 6, 7, 99]) {
      const position = agentArcStepFor(wizardStep);
      if (position !== null) {
        expect(position).toBeGreaterThanOrEqual(1);
        expect(position).toBeLessThanOrEqual(AGENT_ARC_TOTAL_STEPS);
      }
    }
  });
});
