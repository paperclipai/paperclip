import { describe, expect, it } from "vitest";
import { computeRoutineHealth } from "./routine-health.js";

const trigger = {
  id: "trigger-1",
  enabled: true,
  cronExpression: "0 2 * * *",
  timezone: "UTC",
};

describe("computeRoutineHealth", () => {
  it("treats a just-passed tick with no run as pending, not missed", () => {
    const report = computeRoutineHealth({
      routineId: "routine-1",
      triggers: [trigger],
      runs: [],
      now: new Date("2026-07-16T02:05:00Z"),
      days: 1,
    });
    const today = report.dailyResults.find((day) => day.date === "2026-07-16");
    expect(today?.result).toBe("pending");
    expect(report.alerts).toHaveLength(0);
  });

  it("flags an unmatched older tick as missed with an alert", () => {
    const report = computeRoutineHealth({
      routineId: "routine-1",
      triggers: [trigger],
      runs: [],
      now: new Date("2026-07-16T12:00:00Z"),
      days: 1,
    });
    expect(report.dailyResults).toEqual([
      expect.objectContaining({ date: "2026-07-16", result: "missed" }),
    ]);
    expect(report.alerts).toHaveLength(1);
    expect(report.alerts[0]).toContain("missed");
  });

  it("matches a late catch-up fire to its missed tick instead of calling it missed", () => {
    const report = computeRoutineHealth({
      routineId: "routine-1",
      triggers: [trigger],
      runs: [
        {
          id: "run-1",
          triggerId: "trigger-1",
          source: "schedule",
          status: "completed",
          // Server was down at 02:00 and fired the catch-up at 10:17.
          triggeredAt: new Date("2026-07-16T10:17:00Z"),
          failureReason: null,
          triggerPayload: null,
          coalescedIntoRunId: null,
          linkedIssue: null,
        },
      ],
      now: new Date("2026-07-16T12:00:00Z"),
      days: 1,
    });
    expect(report.dailyResults).toEqual([
      expect.objectContaining({ date: "2026-07-16", result: "done" }),
    ]);
  });

  it("does not let a trigger-owned run consume a sibling trigger's legacy run", () => {
    const report = computeRoutineHealth({
      routineId: "routine-1",
      triggers: [trigger, { ...trigger, id: "trigger-2" }],
      runs: [
        {
          id: "owned-run",
          triggerId: "trigger-1",
          source: "schedule",
          status: "completed",
          triggeredAt: new Date("2026-07-16T02:00:00Z"),
          failureReason: null,
          triggerPayload: null,
          coalescedIntoRunId: null,
          linkedIssue: null,
        },
        {
          id: "legacy-run",
          triggerId: null,
          source: "schedule",
          status: "completed",
          triggeredAt: new Date("2026-07-16T02:00:00Z"),
          failureReason: null,
          triggerPayload: null,
          coalescedIntoRunId: null,
          linkedIssue: null,
        },
      ],
      now: new Date("2026-07-16T12:00:00Z"),
      days: 1,
    });

    expect(report.dailyResults[0]?.ticks).toEqual([
      expect.objectContaining({ triggerId: "trigger-1", runId: "owned-run", result: "done" }),
      expect.objectContaining({ triggerId: "trigger-2", runId: "legacy-run", result: "done" }),
    ]);
    expect(report.alerts).toEqual([]);
  });

  it("reports disabled or missing schedule triggers without inventing expectations", () => {
    const report = computeRoutineHealth({
      routineId: "routine-1",
      triggers: [{ ...trigger, enabled: false }],
      runs: [],
      now: new Date("2026-07-16T12:00:00Z"),
      days: 7,
    });
    expect(report.scheduleTriggerCount).toBe(1);
    expect(report.enabledScheduleTriggerCount).toBe(0);
    expect(report.dailyResults).toEqual([]);
    expect(report.alerts).toEqual([]);
  });
});
