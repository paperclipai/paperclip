import { describe, expect, it } from "vitest";
import { MONITOR_MIN_INTERVAL_MS, enforceMonitorMinimumInterval } from "./issue-execution-policy.js";

describe("enforceMonitorMinimumInterval", () => {
  const now = new Date("2026-10-16T10:00:00.000Z");
  const policy = (nextCheckAt: string) => ({ mode: "normal", monitor: { nextCheckAt, scheduledBy: "assignee" } });

  it("raises a new monitor that is sooner than the minimum", () => {
    const out = enforceMonitorMinimumInterval(policy("2026-10-16T10:05:00.000Z"), null, now);
    expect(Date.parse(out!.monitor!.nextCheckAt)).toBe(now.getTime() + MONITOR_MIN_INTERVAL_MS);
  });

  it("keeps a monitor that is already far enough out", () => {
    const p = policy("2026-10-16T13:00:00.000Z");
    expect(enforceMonitorMinimumInterval(p, null, now)).toBe(p);
  });

  it("does not move an unchanged monitor on an unrelated update", () => {
    const p = policy("2026-10-16T10:05:00.000Z");
    expect(enforceMonitorMinimumInterval(p, p, now)).toBe(p);
  });

  it("passes through a policy without a monitor", () => {
    expect(enforceMonitorMinimumInterval(null, null, now)).toBeNull();
    const p = { mode: "normal", monitor: null };
    expect(enforceMonitorMinimumInterval(p, null, now)).toBe(p);
  });
});
