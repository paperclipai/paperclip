import { describe, it, expect } from "vitest";
import { parseCron, validateCron, nextCronTick, nextCronTickFromExpression } from "./cron.js";

// ---------------------------------------------------------------------------
// parseCron
// ---------------------------------------------------------------------------

describe("parseCron", () => {
  it("parses a wildcard-only expression correctly", () => {
    const result = parseCron("* * * * *");
    expect(result.minutes).toHaveLength(60); // 0-59
    expect(result.hours).toHaveLength(24); // 0-23
    expect(result.daysOfMonth).toHaveLength(31); // 1-31
    expect(result.months).toHaveLength(12); // 1-12
    expect(result.daysOfWeek).toHaveLength(7); // 0-6
  });

  it("parses exact values for each field", () => {
    const result = parseCron("30 14 15 6 3");
    expect(result.minutes).toEqual([30]);
    expect(result.hours).toEqual([14]);
    expect(result.daysOfMonth).toEqual([15]);
    expect(result.months).toEqual([6]);
    expect(result.daysOfWeek).toEqual([3]);
  });

  it("parses a range in the minutes field", () => {
    const result = parseCron("0-5 * * * *");
    expect(result.minutes).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it("parses a step expression (*/15 minutes)", () => {
    const result = parseCron("*/15 * * * *");
    expect(result.minutes).toEqual([0, 15, 30, 45]);
  });

  it("parses a step expression starting at N (5/15 minutes)", () => {
    const result = parseCron("5/15 * * * *");
    expect(result.minutes).toContain(5);
    expect(result.minutes).toContain(20);
    expect(result.minutes).toContain(35);
    expect(result.minutes).toContain(50);
  });

  it("parses a range with step (0-30/10 minutes)", () => {
    const result = parseCron("0-30/10 * * * *");
    expect(result.minutes).toEqual([0, 10, 20, 30]);
  });

  it("parses a comma-separated list in the hours field", () => {
    const result = parseCron("0 0,6,12,18 * * *");
    expect(result.hours).toEqual([0, 6, 12, 18]);
  });

  it("parses a comma-separated list with ranges", () => {
    const result = parseCron("0 1-3,22-23 * * *");
    expect(result.hours).toEqual([1, 2, 3, 22, 23]);
  });

  it("deduplicates overlapping values in a comma list", () => {
    const result = parseCron("0 1,1,2 * * *");
    expect(result.hours).toEqual([1, 2]);
  });

  it("sorts values in ascending order", () => {
    const result = parseCron("59,0,30 * * * *");
    expect(result.minutes).toEqual([0, 30, 59]);
  });

  it("trims whitespace from the expression", () => {
    const result = parseCron("  0 12 * * *  ");
    expect(result.minutes).toEqual([0]);
    expect(result.hours).toEqual([12]);
  });

  it("throws on an empty expression", () => {
    expect(() => parseCron("")).toThrow();
  });

  it("throws on an expression with wrong field count (too few)", () => {
    expect(() => parseCron("* * * *")).toThrow(/5 fields/);
  });

  it("throws on an expression with wrong field count (too many)", () => {
    expect(() => parseCron("* * * * * *")).toThrow(/5 fields/);
  });

  it("throws when a minute value is out of range (60)", () => {
    expect(() => parseCron("60 * * * *")).toThrow(/out of range/);
  });

  it("throws when an hour value is out of range (24)", () => {
    expect(() => parseCron("0 24 * * *")).toThrow(/out of range/);
  });

  it("throws when day of month is out of range (0)", () => {
    expect(() => parseCron("0 0 0 * *")).toThrow(/out of range/);
  });

  it("throws when month is out of range (13)", () => {
    expect(() => parseCron("0 0 1 13 *")).toThrow(/out of range/);
  });

  it("throws on a range where start > end", () => {
    expect(() => parseCron("5-3 * * * *")).toThrow(/start > end/);
  });

  it("throws on an invalid non-numeric field value", () => {
    expect(() => parseCron("abc * * * *")).toThrow();
  });

  it("throws on a step of 0", () => {
    expect(() => parseCron("*/0 * * * *")).toThrow(/Invalid step/);
  });
});

// ---------------------------------------------------------------------------
// validateCron
// ---------------------------------------------------------------------------

describe("validateCron", () => {
  it("returns null for a valid expression", () => {
    expect(validateCron("0 12 * * *")).toBeNull();
  });

  it("returns null for the every-minute wildcard expression", () => {
    expect(validateCron("* * * * *")).toBeNull();
  });

  it("returns an error string for an expression with too few fields", () => {
    const error = validateCron("* * * *");
    expect(typeof error).toBe("string");
    expect(error).toBeTruthy();
  });

  it("returns an error string for an out-of-range minute", () => {
    const error = validateCron("60 * * * *");
    expect(typeof error).toBe("string");
  });

  it("returns an error string for an empty expression", () => {
    const error = validateCron("");
    expect(error).toBeTruthy();
  });

  it("returns null for a complex valid expression", () => {
    expect(validateCron("0-30/5 8-18 1,15 * 1-5")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// nextCronTick
// ---------------------------------------------------------------------------

describe("nextCronTick", () => {
  it("returns a date strictly after the reference date", () => {
    const after = new Date("2024-01-01T00:00:00Z");
    const cron = { minutes: [0], hours: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23], daysOfMonth: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31], months: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], daysOfWeek: [0, 1, 2, 3, 4, 5, 6] };
    const next = nextCronTick(cron, after);
    expect(next).not.toBeNull();
    expect(next!.getTime()).toBeGreaterThan(after.getTime());
  });

  it("finds the next matching minute for '*/15 * * * *'", () => {
    const cron = parseCron("*/15 * * * *");
    const after = new Date("2024-01-01T00:01:00Z"); // 1 minute past
    const next = nextCronTick(cron, after);
    expect(next).not.toBeNull();
    expect(next!.getUTCMinutes()).toBe(15);
  });

  it("advances to the next hour when no minute matches in the current hour", () => {
    const cron = parseCron("0 * * * *"); // every hour on the hour
    const after = new Date("2024-01-01T05:01:00Z");
    const next = nextCronTick(cron, after);
    expect(next).not.toBeNull();
    expect(next!.getUTCHours()).toBe(6);
    expect(next!.getUTCMinutes()).toBe(0);
  });

  it("advances to the next day when hour doesn't match", () => {
    const cron = parseCron("0 9 * * *"); // daily at 09:00
    const after = new Date("2024-01-01T10:00:00Z"); // already past 09:00
    const next = nextCronTick(cron, after);
    expect(next).not.toBeNull();
    expect(next!.getUTCDate()).toBe(2);
    expect(next!.getUTCHours()).toBe(9);
    expect(next!.getUTCMinutes()).toBe(0);
  });

  it("advances to the next matching month", () => {
    const cron = parseCron("0 0 1 6 *"); // June 1st at midnight
    const after = new Date("2024-06-02T00:00:00Z"); // after June 1
    const next = nextCronTick(cron, after);
    expect(next).not.toBeNull();
    expect(next!.getUTCFullYear()).toBe(2025);
    expect(next!.getUTCMonth()).toBe(5); // June (0-based)
    expect(next!.getUTCDate()).toBe(1);
  });

  it("matches on specific day of week", () => {
    const cron = parseCron("0 9 * * 1"); // Monday 09:00
    const after = new Date("2024-01-01T00:00:00Z"); // Monday Jan 1 2024
    const next = nextCronTick(cron, after);
    expect(next).not.toBeNull();
    expect(next!.getUTCDay()).toBe(1); // Monday
    expect(next!.getUTCHours()).toBe(9);
  });
});

// ---------------------------------------------------------------------------
// nextCronTickFromExpression
// ---------------------------------------------------------------------------

describe("nextCronTickFromExpression", () => {
  it("parses and computes next tick in one call", () => {
    const after = new Date("2024-06-15T12:00:00Z");
    const next = nextCronTickFromExpression("30 12 * * *", after);
    expect(next).not.toBeNull();
    expect(next!.getUTCHours()).toBe(12);
    expect(next!.getUTCMinutes()).toBe(30);
  });

  it("throws for an invalid expression", () => {
    expect(() => nextCronTickFromExpression("invalid")).toThrow();
  });
});
