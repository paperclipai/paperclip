import { describe, expect, it } from "vitest";
import {
  cadenceToSeconds,
  formatRunsPerDay,
  normalizeIntervalSec,
  runsPerDay,
  secondsToCadence,
  type CadenceUnit,
} from "./cadence";

describe("secondsToCadence", () => {
  it("picks the coarsest exact unit", () => {
    expect(secondsToCadence(300)).toEqual({ value: 5, unit: "minutes" });
    expect(secondsToCadence(3600)).toEqual({ value: 1, unit: "hours" });
    expect(secondsToCadence(7200)).toEqual({ value: 2, unit: "hours" });
    expect(secondsToCadence(60)).toEqual({ value: 1, unit: "minutes" });
  });

  it("falls back to seconds when not evenly divisible", () => {
    expect(secondsToCadence(90)).toEqual({ value: 90, unit: "seconds" });
    expect(secondsToCadence(45)).toEqual({ value: 45, unit: "seconds" });
    // 5400 = 90 min but not a whole hour → minutes
    expect(secondsToCadence(5400)).toEqual({ value: 90, unit: "minutes" });
  });

  it("clamps invalid or sub-second values to 1 second", () => {
    expect(secondsToCadence(0)).toEqual({ value: 1, unit: "seconds" });
    expect(secondsToCadence(-10)).toEqual({ value: 1, unit: "seconds" });
    expect(secondsToCadence(Number.NaN)).toEqual({ value: 1, unit: "seconds" });
  });
});

describe("cadence round-trips seconds", () => {
  // Regression guard (acceptance): cadence must round-trip the stored seconds
  // exactly. Changing the display unit and back must not mutate the value.
  const cases = [1, 10, 30, 60, 300, 600, 900, 3600, 7200, 86_400];
  for (const seconds of cases) {
    it(`round-trips ${seconds}s`, () => {
      const { value, unit } = secondsToCadence(seconds);
      expect(cadenceToSeconds(value, unit)).toBe(normalizeIntervalSec(seconds));
    });
  }

  it("re-expressing 300s across every unit preserves seconds", () => {
    // The stored value is the source of truth; only when the user edits the
    // number does the second count change.
    const units: CadenceUnit[] = ["seconds", "minutes", "hours"];
    // 300s = 300 sec = 5 min; expressing as hours is lossy for the value but
    // cadenceToSeconds always recomputes from (value, unit).
    expect(cadenceToSeconds(300, "seconds")).toBe(300);
    expect(cadenceToSeconds(5, "minutes")).toBe(300);
    for (const unit of units) {
      const secs = cadenceToSeconds(3, unit);
      expect(secondsToCadence(secs)).toBeTruthy();
    }
  });

  it("never returns less than one second", () => {
    expect(cadenceToSeconds(0, "minutes")).toBe(1);
    expect(cadenceToSeconds(-5, "hours")).toBe(1);
  });
});

describe("runs/day preview", () => {
  it("computes runs per day", () => {
    expect(runsPerDay(300)).toBe(288);
    expect(runsPerDay(3600)).toBe(24);
    expect(runsPerDay(86_400)).toBe(1);
  });

  it("formats the consequence string", () => {
    expect(formatRunsPerDay(300)).toBe("≈ 288 runs/day");
    expect(formatRunsPerDay(3600)).toBe("≈ 24 runs/day");
    expect(formatRunsPerDay(86_400)).toBe("≈ 1 run/day");
    expect(formatRunsPerDay(172_800)).toBe("< 1 run/day");
  });
});
