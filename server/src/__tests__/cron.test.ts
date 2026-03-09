import { describe, expect, it } from "vitest";
import {
  parseCron,
  validateCron,
  nextCronTick,
  nextCronTickFromExpression,
} from "../services/cron.js";

// ---------------------------------------------------------------------------
// parseCron
// ---------------------------------------------------------------------------

describe("parseCron", () => {
  it("parses a simple every-minute expression", () => {
    const result = parseCron("* * * * *");
    expect(result.minutes).toHaveLength(60); // 0-59
    expect(result.hours).toHaveLength(24); // 0-23
    expect(result.daysOfMonth).toHaveLength(31); // 1-31
    expect(result.months).toHaveLength(12); // 1-12
    expect(result.daysOfWeek).toHaveLength(7); // 0-6
  });

  it("parses exact values", () => {
    const result = parseCron("5 3 15 6 2");
    expect(result.minutes).toEqual([5]);
    expect(result.hours).toEqual([3]);
    expect(result.daysOfMonth).toEqual([15]);
    expect(result.months).toEqual([6]);
    expect(result.daysOfWeek).toEqual([2]);
  });

  it("parses step expressions with wildcard", () => {
    const result = parseCron("*/15 * * * *");
    expect(result.minutes).toEqual([0, 15, 30, 45]);
  });

  it("parses step expressions with start value", () => {
    const result = parseCron("5/20 * * * *");
    expect(result.minutes).toEqual([5, 25, 45]);
  });

  it("parses range expressions", () => {
    const result = parseCron("0-5 * * * *");
    expect(result.minutes).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it("parses range with step expressions", () => {
    const result = parseCron("10-30/10 * * * *");
    expect(result.minutes).toEqual([10, 20, 30]);
  });

  it("parses comma-separated lists", () => {
    const result = parseCron("1,15,30,45 * * * *");
    expect(result.minutes).toEqual([1, 15, 30, 45]);
  });

  it("parses mixed syntax (list with ranges and steps)", () => {
    const result = parseCron("1,5-7,*/30 * * * *");
    // 1, 5,6,7, 0,30 → unique sorted: [0, 1, 5, 6, 7, 30]
    expect(result.minutes).toEqual([0, 1, 5, 6, 7, 30]);
  });

  it("parses every hour at minute 0", () => {
    const result = parseCron("0 * * * *");
    expect(result.minutes).toEqual([0]);
    expect(result.hours).toHaveLength(24);
  });

  it("parses weekday-only (Mon-Fri)", () => {
    const result = parseCron("0 9 * * 1-5");
    expect(result.daysOfWeek).toEqual([1, 2, 3, 4, 5]);
  });

  it("handles extra whitespace between fields", () => {
    const result = parseCron("  0   */2   *   *   *  ");
    expect(result.minutes).toEqual([0]);
    expect(result.hours).toEqual([0, 2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 22]);
  });

  // Error cases
  it("throws on empty expression", () => {
    expect(() => parseCron("")).toThrow("must not be empty");
  });

  it("throws on wrong number of fields", () => {
    expect(() => parseCron("* * *")).toThrow("exactly 5 fields");
    expect(() => parseCron("* * * * * *")).toThrow("exactly 5 fields");
  });

  it("throws on out-of-range minute", () => {
    expect(() => parseCron("60 * * * *")).toThrow("out of range");
  });

  it("throws on out-of-range hour", () => {
    expect(() => parseCron("* 24 * * *")).toThrow("out of range");
  });

  it("throws on out-of-range day of month (0)", () => {
    expect(() => parseCron("* * 0 * *")).toThrow("out of range");
  });

  it("throws on out-of-range month (13)", () => {
    expect(() => parseCron("* * * 13 *")).toThrow("out of range");
  });

  it("throws on out-of-range day of week (7)", () => {
    expect(() => parseCron("* * * * 7")).toThrow("out of range");
  });

  it("throws on invalid step value", () => {
    expect(() => parseCron("*/0 * * * *")).toThrow("Invalid step");
    expect(() => parseCron("*/-1 * * * *")).toThrow("Invalid step");
    expect(() => parseCron("*/abc * * * *")).toThrow("Invalid step");
  });

  it("throws on invalid range (start > end)", () => {
    expect(() => parseCron("10-5 * * * *")).toThrow("start > end");
  });

  it("throws on non-numeric value", () => {
    expect(() => parseCron("abc * * * *")).toThrow("Invalid value");
  });
});

// ---------------------------------------------------------------------------
// validateCron
// ---------------------------------------------------------------------------

describe("validateCron", () => {
  it("returns null for valid expressions", () => {
    expect(validateCron("* * * * *")).toBeNull();
    expect(validateCron("0 */6 * * *")).toBeNull();
    expect(validateCron("30 4 1,15 * 0")).toBeNull();
  });

  it("returns error message for invalid expressions", () => {
    expect(validateCron("")).toContain("must not be empty");
    expect(validateCron("60 * * * *")).toContain("out of range");
    expect(validateCron("* * *")).toContain("exactly 5 fields");
  });
});

// ---------------------------------------------------------------------------
// nextCronTick
// ---------------------------------------------------------------------------

describe("nextCronTick", () => {
  it("finds next minute for every-minute schedule", () => {
    const cron = parseCron("* * * * *");
    const after = new Date("2025-01-15T10:30:00Z");
    const next = nextCronTick(cron, after);

    expect(next).not.toBeNull();
    expect(next!.toISOString()).toBe("2025-01-15T10:31:00.000Z");
  });

  it("finds next occurrence for every-15-minutes schedule", () => {
    const cron = parseCron("*/15 * * * *");

    // After 10:07 → next is 10:15
    const after1 = new Date("2025-01-15T10:07:00Z");
    expect(nextCronTick(cron, after1)!.toISOString()).toBe(
      "2025-01-15T10:15:00.000Z",
    );

    // After 10:15 → next is 10:30
    const after2 = new Date("2025-01-15T10:15:00Z");
    expect(nextCronTick(cron, after2)!.toISOString()).toBe(
      "2025-01-15T10:30:00.000Z",
    );

    // After 10:45 → next is 11:00
    const after3 = new Date("2025-01-15T10:45:00Z");
    expect(nextCronTick(cron, after3)!.toISOString()).toBe(
      "2025-01-15T11:00:00.000Z",
    );
  });

  it("finds next occurrence for hourly schedule at minute 0", () => {
    const cron = parseCron("0 * * * *");
    const after = new Date("2025-01-15T10:30:00Z");
    const next = nextCronTick(cron, after);

    expect(next!.toISOString()).toBe("2025-01-15T11:00:00.000Z");
  });

  it("rolls over to next day correctly", () => {
    const cron = parseCron("0 9 * * *"); // daily at 09:00
    const after = new Date("2025-01-15T10:00:00Z"); // past 9am

    const next = nextCronTick(cron, after);
    expect(next!.toISOString()).toBe("2025-01-16T09:00:00.000Z");
  });

  it("rolls over to next month correctly", () => {
    const cron = parseCron("0 0 1 * *"); // 1st of every month at midnight
    const after = new Date("2025-01-15T00:00:00Z");

    const next = nextCronTick(cron, after);
    expect(next!.toISOString()).toBe("2025-02-01T00:00:00.000Z");
  });

  it("handles specific month schedule", () => {
    const cron = parseCron("0 0 1 6 *"); // June 1st at midnight
    const after = new Date("2025-01-15T00:00:00Z");

    const next = nextCronTick(cron, after);
    expect(next!.toISOString()).toBe("2025-06-01T00:00:00.000Z");
  });

  it("handles specific day of week schedule", () => {
    const cron = parseCron("0 9 * * 1"); // Monday at 9am
    // 2025-01-15 is a Wednesday
    const after = new Date("2025-01-15T10:00:00Z");

    const next = nextCronTick(cron, after);
    // Next Monday is Jan 20
    expect(next!.toISOString()).toBe("2025-01-20T09:00:00.000Z");
  });

  it("handles weekday-only schedule (Mon-Fri)", () => {
    const cron = parseCron("0 9 * * 1-5");
    // 2025-01-17 is a Friday
    const after = new Date("2025-01-17T10:00:00Z"); // past 9am on Friday

    const next = nextCronTick(cron, after);
    // Next weekday is Monday Jan 20
    expect(next!.toISOString()).toBe("2025-01-20T09:00:00.000Z");
  });

  it("accounts for seconds in the reference date", () => {
    const cron = parseCron("* * * * *");
    const after = new Date("2025-01-15T10:30:45Z");
    const next = nextCronTick(cron, after);

    // Should advance to next minute regardless of seconds
    expect(next!.toISOString()).toBe("2025-01-15T10:31:00.000Z");
  });

  it("returns null for impossible schedule", () => {
    // February 31st — never matches
    const cron = parseCron("0 0 31 2 *");
    const after = new Date("2025-01-01T00:00:00Z");

    const next = nextCronTick(cron, after);
    expect(next).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// nextCronTickFromExpression
// ---------------------------------------------------------------------------

describe("nextCronTickFromExpression", () => {
  it("combines parsing and tick calculation", () => {
    const after = new Date("2025-01-15T10:30:00Z");
    const next = nextCronTickFromExpression("*/15 * * * *", after);

    expect(next!.toISOString()).toBe("2025-01-15T10:45:00.000Z");
  });

  it("throws on invalid expression", () => {
    expect(() => nextCronTickFromExpression("bad")).toThrow();
  });
});
