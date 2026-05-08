import { describe, expect, it } from "vitest";
import { createSleepBoundaryTracker } from "./sleep-boundary-tracker.js";

const noopLog = { warn: () => {}, info: () => {} };

function buildTracker(intervalMs = 10_000, thresholdMs = 30_000) {
  return createSleepBoundaryTracker({
    intervalMs,
    thresholdMs,
    log: noopLog,
  });
}

describe("sleep-boundary-tracker", () => {
  it("ignores normal timer jitter", () => {
    const tracker = buildTracker();
    // Tick 5ms late -- well below threshold.
    const boundary = tracker.recordSampleForTest(10_005, 10_000);
    expect(boundary).toBeNull();
    expect(tracker.getStats().boundaryCount).toBe(0);
  });

  it("records a boundary when wall-clock skew exceeds the threshold", () => {
    const tracker = buildTracker();
    // Expected next tick at t=10_000 (one intervalMs in). Real now is +20 minutes.
    const expected = 10_000;
    const wokeAt = expected + 20 * 60 * 1000;
    const boundary = tracker.recordSampleForTest(wokeAt, expected);
    expect(boundary).not.toBeNull();
    expect(boundary?.gapMs).toBe(20 * 60 * 1000);
    // sleptAt = expected - intervalMs = the previous sample wall-clock
    expect(boundary?.sleptAt.getTime()).toBe(expected - 10_000);
    expect(boundary?.wokeAt.getTime()).toBe(wokeAt);

    const stats = tracker.getStats();
    expect(stats.boundaryCount).toBe(1);
    expect(stats.totalSleepMs).toBe(20 * 60 * 1000);
    expect(stats.lastBoundary?.wokeAt.getTime()).toBe(wokeAt);
  });

  it("flags a run window that crosses the boundary", () => {
    const tracker = buildTracker();
    // Sleep happened around minute 5 -> minute 25 of session.
    tracker.recordSampleForTest(25 * 60 * 1000, 5 * 60 * 1000);

    const runStart = new Date(4 * 60 * 1000);
    const runEnd = new Date(26 * 60 * 1000);
    expect(tracker.wasAsleepBetween(runStart, runEnd)).toBe(true);

    // A run that finished before sleep should not be flagged.
    expect(tracker.wasAsleepBetween(new Date(0), new Date(60 * 1000))).toBe(false);
    // A run that started after wake should not be flagged.
    expect(
      tracker.wasAsleepBetween(new Date(30 * 60 * 1000), new Date(40 * 60 * 1000)),
    ).toBe(false);
  });

  it("handles partial overlap (run started before sleep, ended during)", () => {
    const tracker = buildTracker();
    tracker.recordSampleForTest(25 * 60 * 1000, 5 * 60 * 1000);
    // Run that ended right at wake-up
    expect(
      tracker.wasAsleepBetween(new Date(0), new Date(25 * 60 * 1000 + 1)),
    ).toBe(true);
  });

  it("treats null start or end as no boundary", () => {
    const tracker = buildTracker();
    tracker.recordSampleForTest(25 * 60 * 1000, 5 * 60 * 1000);
    expect(tracker.wasAsleepBetween(null, new Date(10 * 60 * 1000))).toBe(false);
    expect(tracker.wasAsleepBetween(new Date(0), null)).toBe(false);
  });

  it("treats inverted windows as no boundary", () => {
    const tracker = buildTracker();
    tracker.recordSampleForTest(25 * 60 * 1000, 5 * 60 * 1000);
    expect(
      tracker.wasAsleepBetween(new Date(30 * 60 * 1000), new Date(20 * 60 * 1000)),
    ).toBe(false);
  });

  it("evicts oldest boundary when capacity is exceeded", () => {
    const tracker = createSleepBoundaryTracker({
      intervalMs: 10_000,
      thresholdMs: 30_000,
      maxBoundaries: 2,
      log: noopLog,
    });
    tracker.recordSampleForTest(20 * 60 * 1000, 0);          // gap = 20m
    tracker.recordSampleForTest(40 * 60 * 1000, 25 * 60 * 1000); // gap = 15m
    tracker.recordSampleForTest(70 * 60 * 1000, 50 * 60 * 1000); // gap = 20m

    const stats = tracker.getStats();
    expect(stats.boundaryCount).toBe(2);
    // First boundary's 20m gap should have been subtracted from the running total.
    expect(stats.totalSleepMs).toBe(15 * 60 * 1000 + 20 * 60 * 1000);
  });

  it("recentlyWoke returns true within the wake window", () => {
    const tracker = createSleepBoundaryTracker({
      intervalMs: 10_000,
      thresholdMs: 30_000,
      recentWakeWindowMs: 5_000,
      log: noopLog,
    });
    const wokeAt = 100_000;
    tracker.recordSampleForTest(wokeAt, 50_000);
    expect(tracker.recentlyWoke(new Date(wokeAt + 1_000))).toBe(true);
    expect(tracker.recentlyWoke(new Date(wokeAt + 4_999))).toBe(true);
    expect(tracker.recentlyWoke(new Date(wokeAt + 6_000))).toBe(false);
  });

  it("start/stop is idempotent and uses unref-able timers", () => {
    let intervals = 0;
    let cleared = 0;
    let lastHandle: { unref: () => void } | null = null;
    const fakeSetInterval = (() => {
      intervals++;
      const handle = { unref: () => {} };
      lastHandle = handle;
      return handle;
    }) as unknown as typeof setInterval;
    const fakeClearInterval = (() => {
      cleared++;
    }) as unknown as typeof clearInterval;

    const tracker = createSleepBoundaryTracker({
      log: noopLog,
      setIntervalImpl: fakeSetInterval,
      clearIntervalImpl: fakeClearInterval,
    });

    tracker.start();
    tracker.start();
    expect(tracker.isRunning()).toBe(true);
    expect(intervals).toBe(1);
    expect(lastHandle).not.toBeNull();

    tracker.stop();
    tracker.stop();
    expect(tracker.isRunning()).toBe(false);
    expect(cleared).toBe(1);
  });
});
