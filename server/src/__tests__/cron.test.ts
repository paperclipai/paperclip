import { describe, expect, it } from "vitest";
import { nextCronTick, nextCronTickFromExpression, parseCron, validateCron } from "../services/cron.js";

describe("parseCron", () => {
  it("parses a simple every-minute expression", () => {
    const cron = parseCron("* * * * *");
    expect(cron.minutes).toHaveLength(60);
    expect(cron.hours).toHaveLength(24);
    expect(cron.daysOfMonth).toHaveLength(31);
    expect(cron.months).toHaveLength(12);
    expect(cron.daysOfWeek).toHaveLength(7);
  });

  it("parses exact values", () => {
    const cron = parseCron("5 14 3 7 1");
    expect(cron.minutes).toEqual([5]);
    expect(cron.hours).toEqual([14]);
    expect(cron.daysOfMonth).toEqual([3]);
    expect(cron.months).toEqual([7]);
    expect(cron.daysOfWeek).toEqual([1]);
  });

  it("parses ranges", () => {
    const cron = parseCron("0-5 9-17 * * *");
    expect(cron.minutes).toEqual([0, 1, 2, 3, 4, 5]);
    expect(cron.hours).toEqual([9, 10, 11, 12, 13, 14, 15, 16, 17]);
  });

  it("parses step syntax */N", () => {
    const cron = parseCron("*/15 * * * *");
    expect(cron.minutes).toEqual([0, 15, 30, 45]);
  });

  it("parses step syntax N/S", () => {
    const cron = parseCron("10/10 * * * *");
    expect(cron.minutes).toEqual([10, 20, 30, 40, 50]);
  });

  it("parses range-with-step N-M/S", () => {
    const cron = parseCron("0-30/10 * * * *");
    expect(cron.minutes).toEqual([0, 10, 20, 30]);
  });

  it("parses comma-separated lists", () => {
    const cron = parseCron("0,15,30,45 * * * *");
    expect(cron.minutes).toEqual([0, 15, 30, 45]);
  });

  it("parses mixed comma lists with ranges", () => {
    const cron = parseCron("0,10-12,30 * * * *");
    expect(cron.minutes).toEqual([0, 10, 11, 12, 30]);
  });

  it("deduplicates values", () => {
    const cron = parseCron("0,0,0 * * * *");
    expect(cron.minutes).toEqual([0]);
  });

  it("throws on empty expression", () => {
    expect(() => parseCron("")).toThrow("empty");
  });

  it("throws on wrong field count", () => {
    expect(() => parseCron("* * * *")).toThrow("5 fields");
    expect(() => parseCron("* * * * * *")).toThrow("5 fields");
  });

  it("throws on out-of-range minute", () => {
    expect(() => parseCron("60 * * * *")).toThrow("out of range");
  });

  it("throws on out-of-range hour", () => {
    expect(() => parseCron("* 24 * * *")).toThrow("out of range");
  });

  it("throws on invalid range (start > end)", () => {
    expect(() => parseCron("5-3 * * * *")).toThrow("start > end");
  });

  it("throws on non-numeric value", () => {
    expect(() => parseCron("abc * * * *")).toThrow();
  });

  it("sorts values in ascending order", () => {
    const cron = parseCron("30,0,15,45 * * * *");
    expect(cron.minutes).toEqual([0, 15, 30, 45]);
  });
});

describe("validateCron", () => {
  it("returns null for valid expressions", () => {
    expect(validateCron("* * * * *")).toBeNull();
    expect(validateCron("0 12 * * 1")).toBeNull();
    expect(validateCron("*/15 9-17 * * 1-5")).toBeNull();
  });

  it("returns error message for invalid expressions", () => {
    expect(validateCron("")).not.toBeNull();
    expect(validateCron("60 * * * *")).not.toBeNull();
    expect(validateCron("* * * *")).not.toBeNull();
  });

  it("returned message is a string", () => {
    const result = validateCron("invalid");
    expect(typeof result).toBe("string");
    expect(result!.length).toBeGreaterThan(0);
  });
});

describe("nextCronTick", () => {
  it("returns the next matching minute for a simple expression", () => {
    const cron = parseCron("30 14 * * *"); // 14:30 every day
    const after = new Date("2024-01-15T14:00:00Z");
    const next = nextCronTick(cron, after);
    expect(next).not.toBeNull();
    expect(next!.getUTCHours()).toBe(14);
    expect(next!.getUTCMinutes()).toBe(30);
  });

  it("advances to the next day when no match found today", () => {
    const cron = parseCron("0 8 * * *"); // 08:00 every day
    const after = new Date("2024-01-15T09:00:00Z"); // already past 08:00
    const next = nextCronTick(cron, after);
    expect(next).not.toBeNull();
    expect(next!.getUTCDate()).toBe(16);
    expect(next!.getUTCHours()).toBe(8);
    expect(next!.getUTCMinutes()).toBe(0);
  });

  it("returns a date strictly after the reference", () => {
    const cron = parseCron("30 14 * * *");
    const after = new Date("2024-01-15T14:30:00Z"); // exactly at the match
    const next = nextCronTick(cron, after);
    expect(next).not.toBeNull();
    expect(next!.getTime()).toBeGreaterThan(after.getTime());
  });

  it("handles every-minute expression", () => {
    const cron = parseCron("* * * * *");
    const after = new Date("2024-01-15T10:25:30Z");
    const next = nextCronTick(cron, after);
    expect(next).not.toBeNull();
    expect(next!.getUTCMinutes()).toBe(26);
    expect(next!.getUTCSeconds()).toBe(0);
  });

  it("handles end-of-hour rollover", () => {
    const cron = parseCron("5 * * * *"); // minute 5 of every hour
    const after = new Date("2024-01-15T10:10:00Z");
    const next = nextCronTick(cron, after);
    expect(next).not.toBeNull();
    expect(next!.getUTCHours()).toBe(11);
    expect(next!.getUTCMinutes()).toBe(5);
  });

  it("handles month boundary", () => {
    const cron = parseCron("0 0 1 3 *"); // March 1st midnight
    const after = new Date("2024-03-02T00:00:00Z"); // just past it
    const next = nextCronTick(cron, after);
    expect(next).not.toBeNull();
    expect(next!.getUTCFullYear()).toBe(2025);
    expect(next!.getUTCMonth()).toBe(2); // March = 2 (0-indexed)
    expect(next!.getUTCDate()).toBe(1);
  });

  it("respects day-of-week constraint", () => {
    const cron = parseCron("0 9 * * 1"); // Monday at 09:00
    const after = new Date("2024-01-15T09:00:00Z"); // Monday Jan 15 2024
    const next = nextCronTick(cron, after);
    expect(next).not.toBeNull();
    // Next Monday
    expect(next!.getUTCDay()).toBe(1);
    expect(next!.getUTCHours()).toBe(9);
  });
});

describe("nextCronTickFromExpression", () => {
  it("parses and computes next tick from string", () => {
    const after = new Date("2024-01-15T10:00:00Z");
    const next = nextCronTickFromExpression("30 10 * * *", after);
    expect(next).not.toBeNull();
    expect(next!.getUTCHours()).toBe(10);
    expect(next!.getUTCMinutes()).toBe(30);
  });

  it("throws on invalid expression", () => {
    expect(() => nextCronTickFromExpression("invalid")).toThrow();
  });

  it("defaults after to now", () => {
    const before = Date.now();
    const next = nextCronTickFromExpression("* * * * *");
    expect(next).not.toBeNull();
    expect(next!.getTime()).toBeGreaterThanOrEqual(before);
  });
});
