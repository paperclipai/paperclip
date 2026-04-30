import { describe, it, expect } from "vitest";
import { parseCron, mostRecentPastSlot } from "../services/cron.ts";

describe("mostRecentPastSlot", () => {
  it("returns the most recent matching minute", () => {
    const cron = parseCron("0 * * * *");
    const ref = new Date("2026-04-30T09:30:00Z");
    const r = mostRecentPastSlot(cron, ref);
    expect(r?.toISOString()).toBe("2026-04-30T09:00:00.000Z");
  });

  it("returns the same minute when ref matches exactly", () => {
    const cron = parseCron("0 * * * *");
    const ref = new Date("2026-04-30T09:00:00Z");
    const r = mostRecentPastSlot(cron, ref);
    expect(r?.toISOString()).toBe("2026-04-30T09:00:00.000Z");
  });

  it("handles uneven schedules like 0 9,18,22 * * *", () => {
    const cron = parseCron("0 9,18,22 * * *");
    const ref = new Date("2026-04-30T20:00:00Z");
    const r = mostRecentPastSlot(cron, ref);
    expect(r?.toISOString()).toBe("2026-04-30T18:00:00.000Z");
  });
});
