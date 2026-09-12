import { describe, expect, it } from "vitest";
import {
  SUCCESSFUL_RUN_MISSING_STATE_MAX_ATTEMPTS,
  SUCCESSFUL_RUN_MISSING_STATE_MAX_ATTEMPTS_CEILING,
  SUCCESSFUL_RUN_MISSING_STATE_MAX_ATTEMPTS_DEFAULT,
  hasArmedMonitorWake,
  parseSuccessfulRunMissingStateMaxAttempts,
  resolveSuccessfulRunMissingStateMaxAttempts,
} from "./service.js";

describe("parseSuccessfulRunMissingStateMaxAttempts", () => {
  it("returns the default for missing, empty, or non-integer values", () => {
    expect(parseSuccessfulRunMissingStateMaxAttempts(undefined)).toBe(
      SUCCESSFUL_RUN_MISSING_STATE_MAX_ATTEMPTS_DEFAULT,
    );
    expect(parseSuccessfulRunMissingStateMaxAttempts("")).toBe(
      SUCCESSFUL_RUN_MISSING_STATE_MAX_ATTEMPTS_DEFAULT,
    );
    expect(parseSuccessfulRunMissingStateMaxAttempts("  ")).toBe(
      SUCCESSFUL_RUN_MISSING_STATE_MAX_ATTEMPTS_DEFAULT,
    );
    expect(parseSuccessfulRunMissingStateMaxAttempts("3.5")).toBe(
      SUCCESSFUL_RUN_MISSING_STATE_MAX_ATTEMPTS_DEFAULT,
    );
    expect(parseSuccessfulRunMissingStateMaxAttempts("Infinity")).toBe(
      SUCCESSFUL_RUN_MISSING_STATE_MAX_ATTEMPTS_DEFAULT,
    );
    expect(parseSuccessfulRunMissingStateMaxAttempts("1e3")).toBe(
      SUCCESSFUL_RUN_MISSING_STATE_MAX_ATTEMPTS_DEFAULT,
    );
    expect(parseSuccessfulRunMissingStateMaxAttempts("abc")).toBe(
      SUCCESSFUL_RUN_MISSING_STATE_MAX_ATTEMPTS_DEFAULT,
    );
  });

  it("rejects zero, negatives, and values above the int32 ceiling", () => {
    expect(parseSuccessfulRunMissingStateMaxAttempts("0")).toBe(
      SUCCESSFUL_RUN_MISSING_STATE_MAX_ATTEMPTS_DEFAULT,
    );
    expect(parseSuccessfulRunMissingStateMaxAttempts("-1")).toBe(
      SUCCESSFUL_RUN_MISSING_STATE_MAX_ATTEMPTS_DEFAULT,
    );
    expect(
      parseSuccessfulRunMissingStateMaxAttempts(String(SUCCESSFUL_RUN_MISSING_STATE_MAX_ATTEMPTS_CEILING + 1)),
    ).toBe(SUCCESSFUL_RUN_MISSING_STATE_MAX_ATTEMPTS_DEFAULT);
  });

  it("accepts finite integers in the persistable range", () => {
    expect(parseSuccessfulRunMissingStateMaxAttempts("1")).toBe(1);
    expect(parseSuccessfulRunMissingStateMaxAttempts("3")).toBe(3);
    expect(parseSuccessfulRunMissingStateMaxAttempts(" 12 ")).toBe(12);
    expect(parseSuccessfulRunMissingStateMaxAttempts(String(SUCCESSFUL_RUN_MISSING_STATE_MAX_ATTEMPTS_CEILING))).toBe(
      SUCCESSFUL_RUN_MISSING_STATE_MAX_ATTEMPTS_CEILING,
    );
  });
});

describe("resolveSuccessfulRunMissingStateMaxAttempts", () => {
  it("uses the persisted integer cap when it is in the persistable range", () => {
    expect(resolveSuccessfulRunMissingStateMaxAttempts(1)).toBe(1);
    expect(resolveSuccessfulRunMissingStateMaxAttempts(5)).toBe(5);
    expect(resolveSuccessfulRunMissingStateMaxAttempts(SUCCESSFUL_RUN_MISSING_STATE_MAX_ATTEMPTS_CEILING)).toBe(
      SUCCESSFUL_RUN_MISSING_STATE_MAX_ATTEMPTS_CEILING,
    );
  });

  it("falls back to the process cap for null, missing, or unpersistable values", () => {
    expect(resolveSuccessfulRunMissingStateMaxAttempts(null)).toBe(SUCCESSFUL_RUN_MISSING_STATE_MAX_ATTEMPTS);
    expect(resolveSuccessfulRunMissingStateMaxAttempts(undefined)).toBe(SUCCESSFUL_RUN_MISSING_STATE_MAX_ATTEMPTS);
    expect(resolveSuccessfulRunMissingStateMaxAttempts(0)).toBe(SUCCESSFUL_RUN_MISSING_STATE_MAX_ATTEMPTS);
    expect(resolveSuccessfulRunMissingStateMaxAttempts(-1)).toBe(SUCCESSFUL_RUN_MISSING_STATE_MAX_ATTEMPTS);
    expect(resolveSuccessfulRunMissingStateMaxAttempts(3.5)).toBe(SUCCESSFUL_RUN_MISSING_STATE_MAX_ATTEMPTS);
    expect(resolveSuccessfulRunMissingStateMaxAttempts(Number.POSITIVE_INFINITY)).toBe(
      SUCCESSFUL_RUN_MISSING_STATE_MAX_ATTEMPTS,
    );
  });
});

// SPC-21314 deficiency #3 / SPC-37112 / SPC-39089: reconcileStrandedAssignedIssues
// must not treat an issue as stranded while it has a legitimately armed,
// unexpired monitor wake — that cadence is owned by tickDueIssueMonitors, not
// the stranded-issue reconciler.
describe("hasArmedMonitorWake", () => {
  const now = new Date("2026-09-09T00:00:00.000Z");
  const nineDaysOut = new Date("2026-09-18T00:00:00.000Z");
  const oneMinuteAgo = new Date("2026-09-08T23:59:00.000Z");

  it("is true for an in_progress issue with a future monitor wake", () => {
    expect(
      hasArmedMonitorWake(
        { status: "in_progress", monitorNextCheckAt: nineDaysOut },
        now,
      ),
    ).toBe(true);
  });

  it("is true for an in_review issue with a future monitor wake", () => {
    expect(
      hasArmedMonitorWake(
        { status: "in_review", monitorNextCheckAt: nineDaysOut },
        now,
      ),
    ).toBe(true);
  });

  it("is false once the monitor wake is in the past (due, not armed)", () => {
    expect(
      hasArmedMonitorWake(
        { status: "in_progress", monitorNextCheckAt: oneMinuteAgo },
        now,
      ),
    ).toBe(false);
  });

  it("is false when there is no scheduled monitor", () => {
    expect(
      hasArmedMonitorWake({ status: "in_progress", monitorNextCheckAt: null }, now),
    ).toBe(false);
  });

  it("is false for statuses the monitor cannot be scheduled on", () => {
    expect(
      hasArmedMonitorWake({ status: "todo", monitorNextCheckAt: nineDaysOut }, now),
    ).toBe(false);
    expect(
      hasArmedMonitorWake({ status: "blocked", monitorNextCheckAt: nineDaysOut }, now),
    ).toBe(false);
    expect(
      hasArmedMonitorWake({ status: "done", monitorNextCheckAt: nineDaysOut }, now),
    ).toBe(false);
  });
});
