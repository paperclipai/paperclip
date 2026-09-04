import { describe, expect, it } from "vitest";
import { classifySilenceLevel, silenceAgeMs, silenceStartedAt } from "./silence.js";

const SUSPICION_THRESHOLD_MS = 60 * 60 * 1000;
const CRITICAL_THRESHOLD_MS = 4 * 60 * 60 * 1000;

describe("silenceStartedAt / silenceAgeMs", () => {
  it.each([
    {
      name: "prefers the last output time over every other timestamp",
      run: {
        lastOutputAt: new Date("2026-01-01T00:10:00.000Z"),
        processStartedAt: new Date("2026-01-01T00:05:00.000Z"),
        startedAt: new Date("2026-01-01T00:04:00.000Z"),
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
      },
      expected: "2026-01-01T00:10:00.000Z",
    },
    {
      name: "falls back to the process start time when there is no output",
      run: {
        lastOutputAt: null,
        processStartedAt: new Date("2026-01-01T00:05:00.000Z"),
        startedAt: new Date("2026-01-01T00:04:00.000Z"),
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
      },
      expected: "2026-01-01T00:05:00.000Z",
    },
    {
      name: "falls back to the run start time when there is no process start",
      run: {
        lastOutputAt: null,
        processStartedAt: null,
        startedAt: new Date("2026-01-01T00:04:00.000Z"),
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
      },
      expected: "2026-01-01T00:04:00.000Z",
    },
    {
      name: "falls back to the run creation time last",
      run: {
        lastOutputAt: null,
        processStartedAt: null,
        startedAt: null,
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
      },
      expected: "2026-01-01T00:00:00.000Z",
    },
  ])("selects the latest usable timestamp: $name", ({ run, expected }) => {
    expect(silenceStartedAt(run)?.toISOString()).toBe(expected);
  });

  it("returns null when every timestamp is null", () => {
    expect(silenceStartedAt({ lastOutputAt: null, processStartedAt: null, startedAt: null, createdAt: null })).toBeNull();
  });

  it("calculates the silence age from the selected timestamp", () => {
    const run = {
      lastOutputAt: new Date("2026-01-01T00:00:00.000Z"),
      processStartedAt: null,
      startedAt: null,
      createdAt: null,
    };
    const now = new Date("2026-01-01T01:00:00.000Z");

    expect(silenceAgeMs(run, now)).toBe(60 * 60 * 1000);
  });

  it("floors the silence age at zero when the clock reads before the start", () => {
    const run = {
      lastOutputAt: new Date("2026-01-01T01:00:00.000Z"),
      processStartedAt: null,
      startedAt: null,
      createdAt: null,
    };
    const now = new Date("2026-01-01T00:00:00.000Z");

    expect(silenceAgeMs(run, now)).toBe(0);
  });

  it("returns null silence age when there is no usable timestamp", () => {
    const run = { lastOutputAt: null, processStartedAt: null, startedAt: null, createdAt: null };

    expect(silenceAgeMs(run, new Date("2026-01-01T00:00:00.000Z"))).toBeNull();
  });
});

describe("classifySilenceLevel", () => {
  it.each([
    {
      name: "not-applicable when the run is not running",
      input: {
        isRunningRun: false,
        silenceAgeMs: CRITICAL_THRESHOLD_MS + 1,
        dismissedFalsePositive: false,
        snoozed: false,
        suspicionThresholdMs: SUSPICION_THRESHOLD_MS,
        criticalThresholdMs: CRITICAL_THRESHOLD_MS,
      },
      expected: "not_applicable",
    },
    {
      name: "not-applicable when the run has a permanent false-positive dismissal",
      input: {
        isRunningRun: true,
        silenceAgeMs: CRITICAL_THRESHOLD_MS + 1,
        dismissedFalsePositive: true,
        snoozed: false,
        suspicionThresholdMs: SUSPICION_THRESHOLD_MS,
        criticalThresholdMs: CRITICAL_THRESHOLD_MS,
      },
      expected: "not_applicable",
    },
    {
      name: "snoozed when a snooze or continue decision is active",
      input: {
        isRunningRun: true,
        silenceAgeMs: CRITICAL_THRESHOLD_MS + 1,
        dismissedFalsePositive: false,
        snoozed: true,
        suspicionThresholdMs: SUSPICION_THRESHOLD_MS,
        criticalThresholdMs: CRITICAL_THRESHOLD_MS,
      },
      expected: "snoozed",
    },
    {
      name: "healthy below the suspicion threshold",
      input: {
        isRunningRun: true,
        silenceAgeMs: SUSPICION_THRESHOLD_MS - 1,
        dismissedFalsePositive: false,
        snoozed: false,
        suspicionThresholdMs: SUSPICION_THRESHOLD_MS,
        criticalThresholdMs: CRITICAL_THRESHOLD_MS,
      },
      expected: "ok",
    },
    {
      name: "suspicious at or above the suspicion threshold",
      input: {
        isRunningRun: true,
        silenceAgeMs: SUSPICION_THRESHOLD_MS,
        dismissedFalsePositive: false,
        snoozed: false,
        suspicionThresholdMs: SUSPICION_THRESHOLD_MS,
        criticalThresholdMs: CRITICAL_THRESHOLD_MS,
      },
      expected: "suspicious",
    },
    {
      name: "critical at or above the critical threshold",
      input: {
        isRunningRun: true,
        silenceAgeMs: CRITICAL_THRESHOLD_MS,
        dismissedFalsePositive: false,
        snoozed: false,
        suspicionThresholdMs: SUSPICION_THRESHOLD_MS,
        criticalThresholdMs: CRITICAL_THRESHOLD_MS,
      },
      expected: "critical",
    },
    {
      name: "healthy when there is no silence age yet",
      input: {
        isRunningRun: true,
        silenceAgeMs: null,
        dismissedFalsePositive: false,
        snoozed: false,
        suspicionThresholdMs: SUSPICION_THRESHOLD_MS,
        criticalThresholdMs: CRITICAL_THRESHOLD_MS,
      },
      expected: "ok",
    },
  ])("classifies: $name", ({ input, expected }) => {
    expect(classifySilenceLevel(input)).toBe(expected);
  });
});
