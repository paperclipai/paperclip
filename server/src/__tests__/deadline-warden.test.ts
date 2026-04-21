import { describe, expect, it } from "vitest";
import { shouldStartWork, type WardenIssueSnapshot } from "../services/deadline-warden.js";

const now = new Date("2026-04-21T12:00:00Z");

function issue(overrides: Partial<WardenIssueSnapshot> = {}): WardenIssueSnapshot {
  return {
    status: "backlog",
    dueDate: new Date("2026-04-28T23:59:59Z"),
    workLeadDays: 3,
    ...overrides,
  };
}

describe("shouldStartWork", () => {
  it("ignores issues not in backlog", () => {
    expect(shouldStartWork(issue({ status: "todo" }), now)).toBe(false);
    expect(shouldStartWork(issue({ status: "in_progress" }), now)).toBe(false);
    expect(shouldStartWork(issue({ status: "done" }), now)).toBe(false);
  });

  it("ignores issues without a due date", () => {
    expect(shouldStartWork(issue({ dueDate: null }), now)).toBe(false);
  });

  it("ignores issues without work lead days set", () => {
    expect(shouldStartWork(issue({ workLeadDays: null }), now)).toBe(false);
  });

  it("promotes when start time has arrived (due in 3d, lead 3d)", () => {
    expect(
      shouldStartWork({ status: "backlog", dueDate: new Date("2026-04-24T23:59:59Z"), workLeadDays: 3 }, now),
    ).toBe(true);
  });

  it("waits when start time is still in the future", () => {
    expect(
      shouldStartWork({ status: "backlog", dueDate: new Date("2026-04-30T23:59:59Z"), workLeadDays: 3 }, now),
    ).toBe(false);
  });

  it("promotes immediately when lead days >= days until due", () => {
    expect(
      shouldStartWork({ status: "backlog", dueDate: new Date("2026-04-28T23:59:59Z"), workLeadDays: 14 }, now),
    ).toBe(true);
  });

  it("promotes overdue backlog issues", () => {
    expect(
      shouldStartWork({ status: "backlog", dueDate: new Date("2026-04-10T23:59:59Z"), workLeadDays: 1 }, now),
    ).toBe(true);
  });

  it("handles lead days of 0 — starts at due date", () => {
    const dueToday = new Date("2026-04-21T23:59:59Z");
    expect(shouldStartWork({ status: "backlog", dueDate: dueToday, workLeadDays: 0 }, now)).toBe(true);
    const dueTomorrow = new Date("2026-04-22T23:59:59Z");
    expect(shouldStartWork({ status: "backlog", dueDate: dueTomorrow, workLeadDays: 0 }, now)).toBe(false);
  });

  it("rejects invalid due date strings safely", () => {
    expect(shouldStartWork({ status: "backlog", dueDate: "not-a-date", workLeadDays: 3 }, now)).toBe(false);
  });

  it("accepts string dueDate inputs", () => {
    expect(
      shouldStartWork({ status: "backlog", dueDate: "2026-04-24T23:59:59Z", workLeadDays: 3 }, now),
    ).toBe(true);
  });

  it("clamps negative lead days to 0", () => {
    expect(
      shouldStartWork({ status: "backlog", dueDate: new Date("2026-04-22T23:59:59Z"), workLeadDays: -5 }, now),
    ).toBe(false);
  });
});
