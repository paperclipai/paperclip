import { describe, expect, it } from "vitest";
import { parseOnboardingGoalInput } from "./onboarding-goal";

describe("parseOnboardingGoalInput", () => {
  it("uses a single-line goal as the title only", () => {
    expect(parseOnboardingGoalInput("Ship the MVP")).toEqual({
      title: "Ship the MVP",
      description: null,
    });
  });

  it("splits a multiline goal into title and description", () => {
    expect(
      parseOnboardingGoalInput(
        "Ship the MVP\nLaunch to 10 design partners\nMeasure retention",
      ),
    ).toEqual({
      title: "Ship the MVP",
      description: "Launch to 10 design partners\nMeasure retention",
    });
  });
});
