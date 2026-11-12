import { describe, expect, it } from "vitest";
import {
  BACKGROUND_JITTER_MAX_MS,
  FOCUSED_JITTER_MAX_MS,
  computeStartupJitterMs,
  jitterBoundForVisibility,
  resolvePollingInterval,
} from "./polling";

describe("resolvePollingInterval", () => {
  it("polls at the visible cadence when focused", () => {
    expect(
      resolvePollingInterval({ visible: true, focused: true }, { visibleMs: 5000 }),
    ).toBe(5000);
  });

  it("falls back to visibleMs when visible but unfocused and no unfocusedMs given", () => {
    expect(
      resolvePollingInterval({ visible: true, focused: false }, { visibleMs: 5000 }),
    ).toBe(5000);
  });

  it("uses unfocusedMs for a visible-but-unfocused tab when provided", () => {
    expect(
      resolvePollingInterval(
        { visible: true, focused: false },
        { visibleMs: 5000, unfocusedMs: 15000 },
      ),
    ).toBe(15000);
  });

  it("stops polling when hidden by default", () => {
    expect(
      resolvePollingInterval({ visible: false, focused: false }, { visibleMs: 5000 }),
    ).toBe(false);
  });

  it("slows polling when hidden if hiddenMs is provided", () => {
    expect(
      resolvePollingInterval(
        { visible: false, focused: false },
        { visibleMs: 5000, hiddenMs: 60000 },
      ),
    ).toBe(60000);
  });
});

describe("computeStartupJitterMs", () => {
  it("returns 0 when maxMs <= 0", () => {
    expect(computeStartupJitterMs(0, () => 0.5)).toBe(0);
    expect(computeStartupJitterMs(-100, () => 0.5)).toBe(0);
  });

  it("scales the rng value into [0, maxMs]", () => {
    expect(computeStartupJitterMs(1000, () => 0)).toBe(0);
    expect(computeStartupJitterMs(1000, () => 0.25)).toBe(250);
    expect(computeStartupJitterMs(1000, () => 0.999999)).toBe(1000);
  });

  it("clamps rng values outside [0, 1)", () => {
    expect(computeStartupJitterMs(1000, () => -1)).toBe(0);
    expect(computeStartupJitterMs(1000, () => 5)).toBe(1000);
  });

  it("never exceeds the bound for a focused tab", () => {
    for (const r of [0, 0.3, 0.7, 0.9999]) {
      const jitter = computeStartupJitterMs(FOCUSED_JITTER_MAX_MS, () => r);
      expect(jitter).toBeGreaterThanOrEqual(0);
      expect(jitter).toBeLessThanOrEqual(FOCUSED_JITTER_MAX_MS);
    }
  });
});

describe("jitterBoundForVisibility", () => {
  it("uses the small focused bound for a focused tab", () => {
    expect(jitterBoundForVisibility({ visible: true, focused: true })).toBe(
      FOCUSED_JITTER_MAX_MS,
    );
  });

  it("uses the wider background bound for a hidden or unfocused tab", () => {
    expect(jitterBoundForVisibility({ visible: false, focused: false })).toBe(
      BACKGROUND_JITTER_MAX_MS,
    );
    expect(jitterBoundForVisibility({ visible: true, focused: false })).toBe(
      BACKGROUND_JITTER_MAX_MS,
    );
  });

  it("respects custom bounds", () => {
    expect(
      jitterBoundForVisibility(
        { visible: true, focused: true },
        { focusedMaxMs: 100, backgroundMaxMs: 9000 },
      ),
    ).toBe(100);
    expect(
      jitterBoundForVisibility(
        { visible: false, focused: false },
        { focusedMaxMs: 100, backgroundMaxMs: 9000 },
      ),
    ).toBe(9000);
  });
});
