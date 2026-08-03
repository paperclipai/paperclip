import { describe, expect, it } from "vitest";
import {
  computeIssueMonitorFailedDispatchBackoffDelayMs,
  countConsecutiveFailedIssueMonitorDispatches,
} from "../services/heartbeat.ts";

const NOW = new Date("2026-08-03T20:00:00.000Z");

function monitorRun(input: {
  id: string;
  status?: "failed" | "timed_out" | "succeeded";
  wakeReason?: string;
}) {
  return {
    id: input.id,
    status: input.status ?? "failed",
    finishedAt: new Date(NOW.getTime() - 1_000),
    error: "dispatch failed",
    errorCode: "adapter_runtime_error",
    resultJson: null,
    contextSnapshot: { wakeReason: input.wakeReason ?? "issue_monitor_due" },
  };
}

describe("issue monitor failed-dispatch backoff", () => {
  it("escalates exponentially from the 150 second base", () => {
    expect(computeIssueMonitorFailedDispatchBackoffDelayMs(1)).toBe(150_000);
    expect(computeIssueMonitorFailedDispatchBackoffDelayMs(2)).toBe(300_000);
    expect(computeIssueMonitorFailedDispatchBackoffDelayMs(3)).toBe(600_000);
  });

  it("caps large failure streaks at one hour", () => {
    expect(computeIssueMonitorFailedDispatchBackoffDelayMs(20)).toBe(3_600_000);
    expect(computeIssueMonitorFailedDispatchBackoffDelayMs(100)).toBeLessThanOrEqual(3_600_000);
  });

  it.each([0, -1, -10, 0.5])("normalizes %s to the 150 second base", (failures) => {
    expect(computeIssueMonitorFailedDispatchBackoffDelayMs(failures)).toBe(150_000);
  });

  it("resets the streak when the latest monitor dispatch succeeds", () => {
    expect(countConsecutiveFailedIssueMonitorDispatches({
      recentRuns: [
        monitorRun({ id: "success", status: "succeeded" }),
        monitorRun({ id: "failure-2" }),
        monitorRun({ id: "failure-1" }),
      ],
      runIdsWithIssueProgress: new Set(),
      hasNewIssueInputSinceLastRun: false,
      now: NOW,
    })).toBe(0);
  });

  it("resets the streak at issue-progress activity", () => {
    expect(countConsecutiveFailedIssueMonitorDispatches({
      recentRuns: [
        monitorRun({ id: "failure-3" }),
        monitorRun({ id: "progress" }),
        monitorRun({ id: "failure-1" }),
      ],
      runIdsWithIssueProgress: new Set(["progress"]),
      hasNewIssueInputSinceLastRun: false,
      now: NOW,
    })).toBe(1);
  });
});
