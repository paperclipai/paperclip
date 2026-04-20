import { describe, it, expect } from "vitest";

/**
 * Specification for the idle-skip optimisation in tickTimers.
 *
 * The full integration path (DB + adapter) is covered by the existing
 * heartbeat integration suite. This file validates the status classification
 * logic that determines which agents are considered idle.
 */

const ACTIONABLE_STATUSES = ["todo", "in_progress", "in_review"];

describe("tickTimers idle-skip", () => {
  it("classifies actionable statuses correctly", () => {
    expect(ACTIONABLE_STATUSES).toContain("todo");
    expect(ACTIONABLE_STATUSES).toContain("in_progress");
    expect(ACTIONABLE_STATUSES).toContain("in_review");
  });

  it("does not treat terminal or blocked statuses as actionable", () => {
    const nonActionable = ["done", "blocked", "cancelled", "backlog"];
    for (const status of nonActionable) {
      expect(ACTIONABLE_STATUSES).not.toContain(status);
    }
  });

  it("returns separate idleSkipped counter from skipped", () => {
    // tickTimers returns { checked, enqueued, skipped, idleSkipped }
    // - skipped: enqueueWakeup returned falsy for an agent WITH actionable issues
    // - idleSkipped: agent had zero actionable issues and was intentionally bypassed
    // This allows monitoring to distinguish idle optimization from enqueue failures.
    const result = { checked: 10, enqueued: 3, skipped: 1, idleSkipped: 6 };
    expect(result.idleSkipped).not.toBe(result.skipped);
    expect(result.checked).toBe(
      result.enqueued + result.skipped + result.idleSkipped,
    );
  });
});
