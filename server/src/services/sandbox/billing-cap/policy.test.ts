import { describe, expect, it } from "vitest";
import {
  E2B_PILOT_THRESHOLDS,
  evaluateCaps,
  evaluateWindow,
} from "./policy.js";

describe("billing-cap policy", () => {
  it("classifies day spend under soft cap as within", () => {
    const result = evaluateWindow("day", 14_99, E2B_PILOT_THRESHOLDS);
    expect(result.tier).toBe("within");
    expect(result.thresholdCents).toBeNull();
  });
  it("classifies day spend at soft cap exactly as soft", () => {
    const result = evaluateWindow("day", 15_00, E2B_PILOT_THRESHOLDS);
    expect(result.tier).toBe("soft");
    expect(result.thresholdCents).toBe(15_00);
  });
  it("classifies day spend at hard cap exactly as hard", () => {
    const result = evaluateWindow("day", 20_00, E2B_PILOT_THRESHOLDS);
    expect(result.tier).toBe("hard");
    expect(result.thresholdCents).toBe(20_00);
  });
  it("treats month soft cap symmetrically", () => {
    expect(evaluateWindow("month", 149_99, E2B_PILOT_THRESHOLDS).tier).toBe("within");
    expect(evaluateWindow("month", 150_00, E2B_PILOT_THRESHOLDS).tier).toBe("soft");
    expect(evaluateWindow("month", 200_00, E2B_PILOT_THRESHOLDS).tier).toBe("hard");
  });
  it("returns hard-cap-breached-auto-disabled when either window is hard", () => {
    const r = evaluateCaps({
      daySpentCents: 99,
      monthSpentCents: 200_00,
      thresholds: E2B_PILOT_THRESHOLDS,
    });
    expect(r.shouldAutoDisable).toBe(true);
    expect(r.capState).toBe("hard-cap-breached-auto-disabled");
  });
  it("returns soft when only soft is breached", () => {
    const r = evaluateCaps({
      daySpentCents: 15_00,
      monthSpentCents: 50_00,
      thresholds: E2B_PILOT_THRESHOLDS,
    });
    expect(r.shouldAutoDisable).toBe(false);
    expect(r.capState).toBe("soft-cap-breached");
  });
  it("clamps negative spend to zero before classifying", () => {
    const r = evaluateWindow("day", -5, E2B_PILOT_THRESHOLDS);
    expect(r.tier).toBe("within");
    expect(r.spentCents).toBe(0);
  });
});
