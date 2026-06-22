import { describe, it, expect } from "vitest";
import {
  advanceDate,
  computeNextDueDate,
  isIssueRecurrenceFrequency,
  type IssueRecurrence,
} from "./issue-recurrence.js";

const iso = (d: Date) => d.toISOString();

describe("advanceDate", () => {
  it("adds days for daily cadence", () => {
    const out = advanceDate(new Date("2026-06-22T09:00:00.000Z"), { frequency: "daily", interval: 1 });
    expect(iso(out)).toBe("2026-06-23T09:00:00.000Z");
  });

  it("adds N*7 days for weekly cadence", () => {
    const out = advanceDate(new Date("2026-06-22T09:00:00.000Z"), { frequency: "weekly", interval: 2 });
    expect(iso(out)).toBe("2026-07-06T09:00:00.000Z");
  });

  it("adds calendar months for monthly cadence", () => {
    const out = advanceDate(new Date("2026-01-15T12:00:00.000Z"), { frequency: "monthly", interval: 1 });
    expect(iso(out)).toBe("2026-02-15T12:00:00.000Z");
  });

  it("clamps day-of-month when the target month is shorter (Jan 31 -> Feb 28)", () => {
    const out = advanceDate(new Date("2026-01-31T12:00:00.000Z"), { frequency: "monthly", interval: 1 });
    expect(iso(out)).toBe("2026-02-28T12:00:00.000Z");
  });

  it("adds years for yearly cadence", () => {
    const out = advanceDate(new Date("2026-06-22T09:00:00.000Z"), { frequency: "yearly", interval: 1 });
    expect(iso(out)).toBe("2027-06-22T09:00:00.000Z");
  });

  it("does not mutate the input date", () => {
    const input = new Date("2026-06-22T09:00:00.000Z");
    advanceDate(input, { frequency: "daily", interval: 1 });
    expect(iso(input)).toBe("2026-06-22T09:00:00.000Z");
  });

  it("treats interval < 1 as 1", () => {
    const out = advanceDate(new Date("2026-06-22T09:00:00.000Z"), { frequency: "daily", interval: 0 });
    expect(iso(out)).toBe("2026-06-23T09:00:00.000Z");
  });
});

describe("computeNextDueDate", () => {
  const weekly: IssueRecurrence = { frequency: "weekly", interval: 1 };

  it("anchors on the previous due date when completed on time", () => {
    const prevDue = new Date("2026-06-22T09:00:00.000Z");
    const now = new Date("2026-06-22T10:00:00.000Z");
    expect(iso(computeNextDueDate(prevDue, weekly, now))).toBe("2026-06-29T09:00:00.000Z");
  });

  it("rolls forward past 'now' when completed late, instead of spawning already-overdue", () => {
    const prevDue = new Date("2026-06-01T09:00:00.000Z");
    const now = new Date("2026-06-20T10:00:00.000Z"); // ~3 weeks late
    const next = computeNextDueDate(prevDue, weekly, now);
    expect(next.getTime()).toBeGreaterThan(now.getTime());
    expect(iso(next)).toBe("2026-06-22T09:00:00.000Z");
  });

  it("falls back to now when there is no previous due date", () => {
    const now = new Date("2026-06-22T09:00:00.000Z");
    expect(iso(computeNextDueDate(null, weekly, now))).toBe("2026-06-29T09:00:00.000Z");
  });
});

describe("isIssueRecurrenceFrequency", () => {
  it("accepts known frequencies and rejects others", () => {
    expect(isIssueRecurrenceFrequency("weekly")).toBe(true);
    expect(isIssueRecurrenceFrequency("hourly")).toBe(false);
    expect(isIssueRecurrenceFrequency(undefined)).toBe(false);
  });
});
