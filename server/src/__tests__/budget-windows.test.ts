import { describe, expect, it } from "vitest";
import { resolveWindow } from "../services/budgets.ts";

describe("resolveWindow", () => {
  it("resolves a calendar_day_utc window to the enclosing UTC day", () => {
    const { start, end } = resolveWindow("calendar_day_utc", new Date("2026-09-24T17:03:24.000Z"));
    expect(start.toISOString()).toBe("2026-09-24T00:00:00.000Z");
    expect(end.toISOString()).toBe("2026-09-25T00:00:00.000Z");
  });

  it("advances the daily window exactly at the UTC midnight boundary", () => {
    const before = resolveWindow("calendar_day_utc", new Date("2026-09-24T23:59:59.999Z"));
    const after = resolveWindow("calendar_day_utc", new Date("2026-09-25T00:00:00.000Z"));
    expect(before.start.toISOString()).toBe("2026-09-24T00:00:00.000Z");
    expect(before.end.toISOString()).toBe("2026-09-25T00:00:00.000Z");
    expect(after.start.toISOString()).toBe("2026-09-25T00:00:00.000Z");
    expect(after.end.toISOString()).toBe("2026-09-26T00:00:00.000Z");
  });

  it("keeps the calendar_month_utc window on UTC month boundaries", () => {
    const { start, end } = resolveWindow("calendar_month_utc", new Date("2026-09-24T17:03:24.000Z"));
    expect(start.toISOString()).toBe("2026-09-01T00:00:00.000Z");
    expect(end.toISOString()).toBe("2026-10-01T00:00:00.000Z");
  });

  it("resolves lifetime to an effectively unbounded range", () => {
    const { start, end } = resolveWindow("lifetime", new Date("2026-09-24T17:03:24.000Z"));
    expect(start.getTime()).toBeLessThan(new Date("1971-01-01T00:00:00.000Z").getTime());
    expect(end.getTime()).toBeGreaterThan(new Date("2099-01-01T00:00:00.000Z").getTime());
  });
});
