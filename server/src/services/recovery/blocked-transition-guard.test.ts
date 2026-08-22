import { describe, expect, it } from "vitest";
import { shouldSuppressSpuriousBlockedTransition } from "./blocked-transition-guard.js";

describe("shouldSuppressSpuriousBlockedTransition (BUD-717)", () => {
  it("suppresses the in_progress -> blocked transition when blockers are empty and the latest run succeeded", () => {
    expect(
      shouldSuppressSpuriousBlockedTransition({
        blockerIds: [],
        status: "in_progress",
        latestRunStatus: "succeeded",
      }),
    ).toBe(true);
  });

  it("does not suppress when there are first-class blockers (AC2: real blocked issues still escalate)", () => {
    expect(
      shouldSuppressSpuriousBlockedTransition({
        blockerIds: ["blocker-1"],
        status: "in_progress",
        latestRunStatus: "succeeded",
      }),
    ).toBe(false);
  });

  it("does not suppress when the issue is in_review (an in_review consumer owns the next action)", () => {
    expect(
      shouldSuppressSpuriousBlockedTransition({
        blockerIds: [],
        status: "in_review",
        latestRunStatus: "succeeded",
      }),
    ).toBe(false);
  });

  it("does not suppress when the latest run is still running (recovery must keep observing)", () => {
    expect(
      shouldSuppressSpuriousBlockedTransition({
        blockerIds: [],
        status: "in_progress",
        latestRunStatus: "running",
      }),
    ).toBe(false);
  });

  it("does not suppress when the latest run failed in a retryable way (existing escalation path stays in charge)", () => {
    expect(
      shouldSuppressSpuriousBlockedTransition({
        blockerIds: [],
        status: "in_progress",
        latestRunStatus: "failed",
      }),
    ).toBe(false);
  });

  it("does not suppress when there is no latest run (cold-start path is unaffected)", () => {
    expect(
      shouldSuppressSpuriousBlockedTransition({
        blockerIds: [],
        status: "in_progress",
        latestRunStatus: null,
      }),
    ).toBe(false);
  });

  it("treats multiple blockers the same as a single blocker", () => {
    expect(
      shouldSuppressSpuriousBlockedTransition({
        blockerIds: ["a", "b", "c"],
        status: "in_progress",
        latestRunStatus: "succeeded",
      }),
    ).toBe(false);
  });
});
