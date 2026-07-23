import { describe, expect, it } from "vitest";
import {
  DEFAULT_HIBERNATION_THRESHOLD_HOURS,
  detectColdWake,
  resolveHibernationThresholdHours,
} from "../services/cold-wake-briefing.ts";

const NOW = new Date("2026-06-11T20:00:00Z");
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000);

describe("detectColdWake", () => {
  it("flags the wake cold when there is no prior succeeded run", () => {
    expect(detectColdWake({ lastRunFinishedAt: null, now: NOW })).toEqual({
      isColdWake: true,
      hoursSinceLastRun: null,
      lastRunFinishedAt: null,
      thresholdHours: DEFAULT_HIBERNATION_THRESHOLD_HOURS,
    });
  });

  it("flags the wake warm when the last run is inside the threshold", () => {
    const last = hoursAgo(2);
    const result = detectColdWake({ lastRunFinishedAt: last, now: NOW });
    expect(result.isColdWake).toBe(false);
    expect(result.hoursSinceLastRun).toBeCloseTo(2, 6);
    expect(result.lastRunFinishedAt).toBe(last);
    expect(result.thresholdHours).toBe(DEFAULT_HIBERNATION_THRESHOLD_HOURS);
  });

  it("flags the wake cold when the last run is older than the threshold", () => {
    const last = hoursAgo(48);
    const result = detectColdWake({ lastRunFinishedAt: last, now: NOW });
    expect(result.isColdWake).toBe(true);
    expect(result.hoursSinceLastRun).toBeCloseTo(48, 6);
  });

  it("respects an explicit thresholdHours override", () => {
    const last = hoursAgo(6);
    const result = detectColdWake({ lastRunFinishedAt: last, now: NOW, thresholdHours: 4 });
    expect(result.isColdWake).toBe(true);
    expect(result.thresholdHours).toBe(4);
  });

  it("treats exactly-at-threshold as warm (boundary is strict-greater)", () => {
    const last = hoursAgo(24);
    const result = detectColdWake({ lastRunFinishedAt: last, now: NOW, thresholdHours: 24 });
    expect(result.isColdWake).toBe(false);
    expect(result.hoursSinceLastRun).toBeCloseTo(24, 6);
  });

  it("returns a Date for lastRunFinishedAt that round-trips through ISO", () => {
    const last = hoursAgo(3);
    const result = detectColdWake({ lastRunFinishedAt: last, now: NOW });
    expect(result.lastRunFinishedAt).toBeInstanceOf(Date);
    expect(result.lastRunFinishedAt?.toISOString()).toBe(last.toISOString());
  });

  it("falls back to the env-resolved threshold when override is invalid", () => {
    const last = hoursAgo(30);
    const result = detectColdWake({ lastRunFinishedAt: last, now: NOW, thresholdHours: -1 });
    expect(result.thresholdHours).toBe(DEFAULT_HIBERNATION_THRESHOLD_HOURS);
    expect(result.isColdWake).toBe(true);
  });
});

describe("resolveHibernationThresholdHours", () => {
  it("returns the default when the env var is unset", () => {
    expect(resolveHibernationThresholdHours({})).toBe(DEFAULT_HIBERNATION_THRESHOLD_HOURS);
  });

  it("respects a valid numeric env var", () => {
    expect(
      resolveHibernationThresholdHours({ PAPERCLIP_HIBERNATION_THRESHOLD_HOURS: "12" }),
    ).toBe(12);
  });

  it("falls back to the default when the env var is non-numeric", () => {
    expect(
      resolveHibernationThresholdHours({ PAPERCLIP_HIBERNATION_THRESHOLD_HOURS: "abc" }),
    ).toBe(DEFAULT_HIBERNATION_THRESHOLD_HOURS);
  });

  it("falls back to the default when the env var is zero or negative", () => {
    expect(
      resolveHibernationThresholdHours({ PAPERCLIP_HIBERNATION_THRESHOLD_HOURS: "0" }),
    ).toBe(DEFAULT_HIBERNATION_THRESHOLD_HOURS);
    expect(
      resolveHibernationThresholdHours({ PAPERCLIP_HIBERNATION_THRESHOLD_HOURS: "-5" }),
    ).toBe(DEFAULT_HIBERNATION_THRESHOLD_HOURS);
  });
});
