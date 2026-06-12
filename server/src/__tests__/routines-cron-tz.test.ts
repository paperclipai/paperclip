import { describe, expect, it } from "vitest";
import { nextCronTickInTimeZone } from "../services/routines.ts";

describe("nextCronTickInTimeZone", () => {
  it("finds the next hourly tick in UTC", () => {
    // 2026-01-01 00:30 UTC — next tick for "0 * * * *" is 01:00 UTC
    const after = new Date("2026-01-01T00:30:00.000Z");
    const result = nextCronTickInTimeZone("0 * * * *", "UTC", after);
    expect(result).not.toBeNull();
    expect(result?.toISOString()).toBe("2026-01-01T01:00:00.000Z");
  });

  it("finds the next daily tick in a non-UTC timezone (America/New_York)", () => {
    // 2026-06-01 14:00 UTC = 10:00 EDT; next midnight NY = 04:00 UTC the next day
    const after = new Date("2026-06-01T14:00:00.000Z");
    const result = nextCronTickInTimeZone("0 0 * * *", "America/New_York", after);
    expect(result).not.toBeNull();
    // midnight NY on 2026-06-02 = 04:00 UTC (EDT = UTC-4)
    expect(result?.toISOString()).toBe("2026-06-02T04:00:00.000Z");
  });

  it("returns the same result when called repeatedly for the same timezone (formatter cache)", () => {
    const after = new Date("2026-03-15T08:00:00.000Z");
    const first = nextCronTickInTimeZone("30 9 * * *", "Asia/Tokyo", after);
    const second = nextCronTickInTimeZone("30 9 * * *", "Asia/Tokyo", after);
    // Determinism proves the cached formatter produces the same result as a fresh one.
    expect(first?.toISOString()).toBe(second?.toISOString());
  });

  it("throws for an invalid cron expression", () => {
    const after = new Date("2026-01-01T00:00:00.000Z");
    expect(() => nextCronTickInTimeZone("99 * * * *", "UTC", after)).toThrow();
  });
});
