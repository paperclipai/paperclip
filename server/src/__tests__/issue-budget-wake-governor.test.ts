import { describe, expect, it } from "vitest";
import {
  ISSUE_BUDGET_SOFT_RUN_SPACING_MS,
  ISSUE_BUDGET_WAKE_HARD_FRACTION,
  ISSUE_BUDGET_WAKE_SOFT_FRACTION,
  evaluateIssueBudgetWakeGovernor,
} from "../services/issue-rewake-throttle.ts";

const CEILING = 1_000_000;
const NOW = new Date("2026-08-25T12:00:00.000Z");

function decide(overrides: Partial<Parameters<typeof evaluateIssueBudgetWakeGovernor>[0]> = {}) {
  return evaluateIssueBudgetWakeGovernor({
    now: NOW,
    weightedAggregateInputTokens: 0,
    ceilingTokens: CEILING,
    lastRunFinishedAt: null,
    hasHumanInputSinceLastRun: false,
    ...overrides,
  });
}

describe("evaluateIssueBudgetWakeGovernor", () => {
  it("never holds below the soft fraction", () => {
    const d = decide({
      weightedAggregateInputTokens: CEILING * ISSUE_BUDGET_WAKE_SOFT_FRACTION - 1,
      lastRunFinishedAt: new Date(NOW.getTime() - 1_000),
    });
    expect(d).toEqual({ hold: false, zone: "clear", fraction: expect.closeTo(0.6, 2) });
  });

  it("paces the soft zone: holds inside the spacing window with a nextAllowedAt", () => {
    const lastRunFinishedAt = new Date(NOW.getTime() - 60_000);
    const d = decide({
      weightedAggregateInputTokens: CEILING * 0.7,
      lastRunFinishedAt,
    });
    expect(d.hold).toBe(true);
    expect(d.zone).toBe("soft");
    if (d.hold && d.zone === "soft") {
      expect(d.nextAllowedAt.getTime()).toBe(lastRunFinishedAt.getTime() + ISSUE_BUDGET_SOFT_RUN_SPACING_MS);
    }
  });

  it("admits a soft-zone run once the spacing window has elapsed", () => {
    const d = decide({
      weightedAggregateInputTokens: CEILING * 0.7,
      lastRunFinishedAt: new Date(NOW.getTime() - ISSUE_BUDGET_SOFT_RUN_SPACING_MS - 1),
    });
    expect(d).toMatchObject({ hold: false, zone: "soft" });
  });

  it("admits a soft-zone run when the issue has never run", () => {
    const d = decide({ weightedAggregateInputTokens: CEILING * 0.7 });
    expect(d).toMatchObject({ hold: false, zone: "soft" });
  });

  it("holds the hard zone regardless of spacing", () => {
    const d = decide({
      weightedAggregateInputTokens: CEILING * ISSUE_BUDGET_WAKE_HARD_FRACTION,
      lastRunFinishedAt: new Date(NOW.getTime() - 24 * 60 * 60_000),
    });
    expect(d).toMatchObject({ hold: true, zone: "hard" });
  });

  it("human input since the last run admits exactly one run in both zones", () => {
    expect(decide({
      weightedAggregateInputTokens: CEILING * 0.7,
      lastRunFinishedAt: new Date(NOW.getTime() - 1_000),
      hasHumanInputSinceLastRun: true,
    })).toMatchObject({ hold: false, zone: "soft" });
    expect(decide({
      weightedAggregateInputTokens: CEILING * 0.95,
      lastRunFinishedAt: new Date(NOW.getTime() - 1_000),
      hasHumanInputSinceLastRun: true,
    })).toMatchObject({ hold: false, zone: "hard" });
  });

  it("a granted exception cap moves both thresholds up with the ceiling", () => {
    // 900K weighted would be hard-zone at the 1M default, but is clear against
    // a 2M exception cap.
    const d = decide({
      weightedAggregateInputTokens: 900_000,
      ceilingTokens: 2_000_000,
      lastRunFinishedAt: new Date(NOW.getTime() - 1_000),
    });
    expect(d).toMatchObject({ hold: false, zone: "clear" });
  });

  it("fails open on a non-positive or non-finite ceiling", () => {
    expect(decide({ weightedAggregateInputTokens: 999_999, ceilingTokens: 0 }))
      .toEqual({ hold: false, zone: "clear", fraction: 0 });
    expect(decide({ weightedAggregateInputTokens: 999_999, ceilingTokens: Number.NaN }))
      .toEqual({ hold: false, zone: "clear", fraction: 0 });
  });
});
