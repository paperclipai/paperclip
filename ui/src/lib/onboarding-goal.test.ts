import { describe, expect, it } from "vitest";
import {
  formatOnboardingGoalInput,
  parseOnboardingGoalInput,
} from "./onboarding-goal";

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

describe("formatOnboardingGoalInput", () => {
  it("renders a title-only goal as a single line", () => {
    expect(formatOnboardingGoalInput("Ship the MVP")).toBe("Ship the MVP");
  });

  it("renders a title and description as one editable block", () => {
    expect(
      formatOnboardingGoalInput("Ship the MVP", "Launch to 10 design partners"),
    ).toBe("Ship the MVP\n\nLaunch to 10 design partners");
  });

  it("treats a null or blank description as absent", () => {
    expect(formatOnboardingGoalInput("Ship the MVP", null)).toBe("Ship the MVP");
    expect(formatOnboardingGoalInput("Ship the MVP", "   ")).toBe("Ship the MVP");
  });

  it("round-trips a parsed goal back to the same parse", () => {
    const raw = "Ship the MVP\nLaunch to 10 design partners\nMeasure retention";
    const parsed = parseOnboardingGoalInput(raw);

    expect(
      parseOnboardingGoalInput(
        formatOnboardingGoalInput(parsed.title, parsed.description),
      ),
    ).toEqual(parsed);
  });
});
