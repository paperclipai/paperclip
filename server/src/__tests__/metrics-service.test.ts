import { afterEach, describe, expect, it } from "vitest";
import {
  getDepBlockedMetric,
  incrementDepBlockedMetric,
  resetDepBlockedMetrics,
  snapshotDepBlockedMetrics,
} from "../services/dep-blocked-metrics.ts";

describe("dep-blocked metrics counters", () => {
  afterEach(() => {
    resetDepBlockedMetrics();
  });

  it("starts at zero for all keys", () => {
    const snap = snapshotDepBlockedMetrics();
    for (const value of Object.values(snap)) {
      expect(value).toBe(0);
    }
  });

  it("increments a specific counter", () => {
    incrementDepBlockedMetric("dep_blocked_scheduled");
    incrementDepBlockedMetric("dep_blocked_scheduled");
    expect(getDepBlockedMetric("dep_blocked_scheduled")).toBe(2);
    expect(getDepBlockedMetric("dep_blocked_coalesced")).toBe(0);
  });

  it("increments multiple distinct counters independently", () => {
    incrementDepBlockedMetric("dep_blocked_scheduled");
    incrementDepBlockedMetric("dep_blocked_coalesced");
    incrementDepBlockedMetric("dep_blocked_reset");
    const snap = snapshotDepBlockedMetrics();
    expect(snap.dep_blocked_scheduled).toBe(1);
    expect(snap.dep_blocked_coalesced).toBe(1);
    expect(snap.dep_blocked_reset).toBe(1);
    expect(snap.dep_blocked_promoted).toBe(0);
  });

  it("snapshot returns a copy that does not mutate on further increments", () => {
    incrementDepBlockedMetric("dep_blocked_redeferred");
    const snap = snapshotDepBlockedMetrics();
    incrementDepBlockedMetric("dep_blocked_redeferred");
    expect(snap.dep_blocked_redeferred).toBe(1);
    expect(getDepBlockedMetric("dep_blocked_redeferred")).toBe(2);
  });

  it("resets all counters to zero", () => {
    incrementDepBlockedMetric("dep_blocked_exhausted");
    incrementDepBlockedMetric("dep_blocked_promoted");
    resetDepBlockedMetrics();
    const snap = snapshotDepBlockedMetrics();
    for (const value of Object.values(snap)) {
      expect(value).toBe(0);
    }
  });
});
