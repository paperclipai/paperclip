import { describe, it, expect } from "vitest";
import {
  parseCron,
  validateCron,
  nextCronTick,
  nextCronTickFromExpression,
} from "../services/cron.js";

// ---------------------------------------------------------------------------
// Helper: create a UTC Date from components
// ---------------------------------------------------------------------------

function utc(year: number, month: number, day: number, hour = 0, minute = 0): Date {
  return new Date(Date.UTC(year, month - 1, day, hour, minute, 0, 0));
}

// ---------------------------------------------------------------------------
// parseCron
// ---------------------------------------------------------------------------

describe("parseCron", () => {
  it("parses '* * * * *' — all wildcards", () => {
    const c = parseCron("* * * * *");
    expect(c.minutes).toHaveLength(60); // 0-59
    expect(c.hours).toHaveLength(24); // 0-23
    expect(c.daysOfMonth).toHaveLength(31); // 1-31
    expect(c.months).toHaveLength(12); // 1-12
    expect(c.daysOfWeek).toHaveLength(7); // 0-6
  });

  it("parses exact values", () => {
    const c = parseCron("30 14 5 6 1");
    expect(c.minutes).toEqual([30]);
    expect(c.hours).toEqual([14]);
    expect(c.daysOfMonth).toEqual([5]);
    expect(c.months).toEqual([6]);
    expect(c.daysOfWeek).toEqual([1]);
  });

  it("parses a range expression '1-5' in minutes", () => {
    const c = parseCron("1-5 * * * *");
    expect(c.minutes).toEqual([1, 2, 3, 4, 5]);
  });

  it("parses a step expression '*/15' in minutes", () => {
    const c = parseCron("*/15 * * * *");
    expect(c.minutes).toEqual([0, 15, 30, 45]);
  });

  it("parses a range+step expression '0-30/10' in minutes", () => {
    const c = parseCron("0-30/10 * * * *");
    expect(c.minutes).toEqual([0, 10, 20, 30]);
  });

  it("parses a comma-separated list '0,15,30,45' in minutes", () => {
    const c = parseCron("0,15,30,45 * * * *");
    expect(c.minutes).toEqual([0, 15, 30, 45]);
  });

  it("parses mixed comma-list with range '0,10-12,30' in minutes", () => {
    const c = parseCron("0,10-12,30 * * * *");
    expect(c.minutes).toContain(0);
    expect(c.minutes).toContain(10);
    expect(c.minutes).toContain(11);
    expect(c.minutes).toContain(12);
    expect(c.minutes).toContain(30);
  });

  it("trims leading/trailing whitespace", () => {
    expect(() => parseCron("  * * * * *  ")).not.toThrow();
  });

  it("throws on empty string", () => {
    expect(() => parseCron("")).toThrow(/empty/i);
  });

  it("throws on fewer than 5 fields", () => {
    expect(() => parseCron("* * * *")).toThrow(/5 fields/);
  });

  it("throws on more than 5 fields", () => {
    expect(() => parseCron("* * * * * *")).toThrow(/5 fields/);
  });

  it("throws when minute is out of range (60)", () => {
    expect(() => parseCron("60 * * * *")).toThrow();
  });

  it("throws when hour is out of range (24)", () => {
    expect(() => parseCron("* 24 * * *")).toThrow();
  });

  it("throws when month is out of range (0)", () => {
    expect(() => parseCron("* * * 0 *")).toThrow();
  });

  it("throws when month is out of range (13)", () => {
    expect(() => parseCron("* * * 13 *")).toThrow();
  });

  it("throws when dayOfWeek is out of range (7)", () => {
    expect(() => parseCron("* * * * 7")).toThrow();
  });
});

// ---------------------------------------------------------------------------
// validateCron
// ---------------------------------------------------------------------------

describe("validateCron", () => {
  it("returns null for a valid expression", () => {
    expect(validateCron("* * * * *")).toBeNull();
    expect(validateCron("0 9 * * 1-5")).toBeNull();
    expect(validateCron("*/5 * * * *")).toBeNull();
  });

  it("returns an error string for an empty expression", () => {
    const result = validateCron("");
    expect(typeof result).toBe("string");
    expect(result!.length).toBeGreaterThan(0);
  });

  it("returns an error string for a 4-field expression", () => {
    const result = validateCron("* * * *");
    expect(typeof result).toBe("string");
  });

  it("returns an error string when minute is out of range", () => {
    const result = validateCron("60 * * * *");
    expect(typeof result).toBe("string");
  });

  it("returns an error string when hour is out of range", () => {
    const result = validateCron("* 25 * * *");
    expect(typeof result).toBe("string");
  });
});

// ---------------------------------------------------------------------------
// nextCronTick
// ---------------------------------------------------------------------------

describe("nextCronTick", () => {
  it("returns the next minute for '* * * * *' (every minute)", () => {
    const cron = parseCron("* * * * *");
    const after = utc(2024, 1, 15, 10, 30);
    const next = nextCronTick(cron, after);
    expect(next).not.toBeNull();
    expect(next!.getUTCHours()).toBe(10);
    expect(next!.getUTCMinutes()).toBe(31);
  });

  it("returns next matching minute within the same hour", () => {
    const cron = parseCron("0,15,30,45 * * * *");
    const after = utc(2024, 1, 15, 10, 20);
    const next = nextCronTick(cron, after);
    expect(next).not.toBeNull();
    expect(next!.getUTCMinutes()).toBe(30);
    expect(next!.getUTCHours()).toBe(10);
  });

  it("wraps to the next hour when no more matching minutes in the current hour", () => {
    const cron = parseCron("0 * * * *");
    const after = utc(2024, 1, 15, 10, 0); // already at :00, so next is 11:00
    const next = nextCronTick(cron, after);
    expect(next).not.toBeNull();
    expect(next!.getUTCHours()).toBe(11);
    expect(next!.getUTCMinutes()).toBe(0);
  });

  it("skips to next matching hour when the current hour does not match", () => {
    const cron = parseCron("0 9 * * *");
    const after = utc(2024, 1, 15, 8, 0);
    const next = nextCronTick(cron, after);
    expect(next).not.toBeNull();
    expect(next!.getUTCHours()).toBe(9);
    expect(next!.getUTCMinutes()).toBe(0);
  });

  it("advances to the next day when hour does not match today", () => {
    const cron = parseCron("0 6 * * *");
    const after = utc(2024, 1, 15, 10, 0); // past 6am
    const next = nextCronTick(cron, after);
    expect(next).not.toBeNull();
    expect(next!.getUTCDate()).toBe(16);
    expect(next!.getUTCHours()).toBe(6);
  });

  it("respects day-of-week constraints", () => {
    // 0 9 * * 1 = every Monday at 09:00 UTC
    const cron = parseCron("0 9 * * 1");
    const after = utc(2024, 1, 15, 9, 0); // 2024-01-15 is a Monday at 09:00 UTC
    const next = nextCronTick(cron, after);
    expect(next).not.toBeNull();
    // Next Monday is 2024-01-22
    expect(next!.getUTCFullYear()).toBe(2024);
    expect(next!.getUTCMonth() + 1).toBe(1);
    expect(next!.getUTCDate()).toBe(22);
    expect(next!.getUTCHours()).toBe(9);
  });

  it("respects day-of-month constraints", () => {
    // 0 0 1 * * = first of every month at midnight
    const cron = parseCron("0 0 1 * *");
    const after = utc(2024, 1, 15);
    const next = nextCronTick(cron, after);
    expect(next).not.toBeNull();
    expect(next!.getUTCDate()).toBe(1);
    expect(next!.getUTCMonth() + 1).toBe(2); // February
  });

  it("respects month constraints", () => {
    // 0 0 1 6 * = June 1 at midnight
    const cron = parseCron("0 0 1 6 *");
    const after = utc(2024, 1, 15);
    const next = nextCronTick(cron, after);
    expect(next).not.toBeNull();
    expect(next!.getUTCMonth() + 1).toBe(6);
    expect(next!.getUTCDate()).toBe(1);
  });

  it("handles @daily equivalent '0 0 * * *'", () => {
    const cron = parseCron("0 0 * * *");
    const after = utc(2024, 3, 10, 12, 0);
    const next = nextCronTick(cron, after);
    expect(next).not.toBeNull();
    expect(next!.getUTCDate()).toBe(11);
    expect(next!.getUTCHours()).toBe(0);
    expect(next!.getUTCMinutes()).toBe(0);
  });

  it("handles @weekly equivalent '0 0 * * 0' (Sunday)", () => {
    const cron = parseCron("0 0 * * 0");
    const after = utc(2024, 1, 15, 0, 0); // Monday 2024-01-15
    const next = nextCronTick(cron, after);
    expect(next).not.toBeNull();
    expect(next!.getUTCDay()).toBe(0); // Sunday
  });

  it("handles step expression '*/5 * * * *'", () => {
    const cron = parseCron("*/5 * * * *");
    const after = utc(2024, 1, 15, 10, 7);
    const next = nextCronTick(cron, after);
    expect(next).not.toBeNull();
    expect(next!.getUTCMinutes()).toBe(10);
  });

  it("always returns a time strictly after the reference", () => {
    const cron = parseCron("* * * * *");
    const after = utc(2024, 6, 15, 12, 30);
    const next = nextCronTick(cron, after);
    expect(next!.getTime()).toBeGreaterThan(after.getTime());
  });

  it("returns a Date with seconds and ms zeroed", () => {
    const cron = parseCron("* * * * *");
    const after = utc(2024, 1, 15, 10, 30);
    const next = nextCronTick(cron, after);
    expect(next!.getUTCSeconds()).toBe(0);
    expect(next!.getUTCMilliseconds()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// nextCronTickFromExpression
// ---------------------------------------------------------------------------

describe("nextCronTickFromExpression", () => {
  it("returns the next cron tick for a valid expression", () => {
    const after = utc(2024, 1, 15, 10, 30);
    const next = nextCronTickFromExpression("*/30 * * * *", after);
    expect(next).not.toBeNull();
    expect(next!.getUTCMinutes()).toBe(0);
    expect(next!.getUTCHours()).toBe(11);
  });

  it("throws for an invalid expression", () => {
    expect(() => nextCronTickFromExpression("not a cron", utc(2024, 1, 1))).toThrow();
  });

  it("uses current time when no 'after' argument is given", () => {
    const before = new Date();
    const next = nextCronTickFromExpression("* * * * *");
    expect(next).not.toBeNull();
    expect(next!.getTime()).toBeGreaterThan(before.getTime());
  });
});
