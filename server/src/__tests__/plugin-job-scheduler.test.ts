import { describe, it, expect, vi, beforeEach } from "vitest";
import { calculateNextRunAt, shouldFireJob } from "../plugins/job-scheduler.js";

describe("calculateNextRunAt", () => {
  it("calculates next run time from now", () => {
    const now = new Date("2026-03-13T08:00:00Z");
    const next = calculateNextRunAt("0 9 * * *", now);
    expect(next.getUTCHours()).toBe(9);
    expect(next.getUTCMinutes()).toBe(0);
  });

  it("wraps to next day if time has passed", () => {
    const now = new Date("2026-03-13T10:00:00Z");
    const next = calculateNextRunAt("0 9 * * *", now);
    expect(next.getUTCDate()).toBe(14);
  });

  it("handles every-minute cron", () => {
    const now = new Date("2026-03-13T08:30:30Z");
    const next = calculateNextRunAt("* * * * *", now);
    expect(next.getTime()).toBeGreaterThan(now.getTime());
    expect(next.getTime() - now.getTime()).toBeLessThanOrEqual(60_000);
  });
});

describe("shouldFireJob", () => {
  it("fires when now >= nextRunAt", () => {
    const now = new Date("2026-03-13T09:00:01Z");
    const nextRunAt = new Date("2026-03-13T09:00:00Z");
    expect(shouldFireJob(now, nextRunAt, null)).toBe(true);
  });

  it("does not fire when now < nextRunAt", () => {
    const now = new Date("2026-03-13T08:59:59Z");
    const nextRunAt = new Date("2026-03-13T09:00:00Z");
    expect(shouldFireJob(now, nextRunAt, null)).toBe(false);
  });

  it("does not fire when previous run is still running", () => {
    const now = new Date("2026-03-13T09:00:01Z");
    const nextRunAt = new Date("2026-03-13T09:00:00Z");
    expect(shouldFireJob(now, nextRunAt, "running")).toBe(false);
  });
});
