import { describe, expect, it } from "vitest";
import {
  describeSessionResetReason,
  shouldResetTaskSessionForWake,
} from "../services/heartbeat.ts";

// PF-4 keeps exploratory timer wakes fresh to avoid low-value context growth.
// Issue-scoped timer wakes are continuation work and should reuse the task
// session so orchestration does not repay session-start/re-orientation cost.

describe("PF-4 shouldResetTaskSessionForWake", () => {
  it("resets the session for an unscoped heartbeat_timer wake", () => {
    expect(
      shouldResetTaskSessionForWake({
        source: "scheduler",
        reason: "interval_elapsed",
        wakeReason: "heartbeat_timer",
      }),
    ).toBe(true);
  });

  it("reuses the task session for an issue-scoped heartbeat_timer wake", () => {
    expect(
      shouldResetTaskSessionForWake({
        source: "scheduler",
        reason: "interval_elapsed",
        wakeReason: "heartbeat_timer",
        issueId: "issue-1",
      }),
    ).toBe(false);
  });

  it("still resets for the existing reset reasons", () => {
    for (const wakeReason of [
      "issue_assigned",
      "execution_review_requested",
      "execution_approval_requested",
      "execution_changes_requested",
    ] as const) {
      expect(shouldResetTaskSessionForWake({ wakeReason })).toBe(true);
    }
  });

  it("still respects forceFreshSession === true", () => {
    expect(shouldResetTaskSessionForWake({ forceFreshSession: true })).toBe(true);
  });

  it("does not reset for issue_commented (preserve continuation context)", () => {
    expect(shouldResetTaskSessionForWake({ wakeReason: "issue_commented" })).toBe(false);
  });

  it("does not reset for transient_failure_retry (resume in-flight work)", () => {
    expect(shouldResetTaskSessionForWake({ wakeReason: "transient_failure_retry" })).toBe(false);
  });

  it("does not reset for unknown wake reasons", () => {
    expect(shouldResetTaskSessionForWake({ wakeReason: "unknown_reason" })).toBe(false);
  });

  it("does not reset when context is null/undefined", () => {
    expect(shouldResetTaskSessionForWake(null)).toBe(false);
    expect(shouldResetTaskSessionForWake(undefined)).toBe(false);
  });
});

describe("PF-4 describeSessionResetReason", () => {
  it("describes unscoped heartbeat_timer wakes explicitly so run logs explain the reset", () => {
    const reason = describeSessionResetReason({
      wakeReason: "heartbeat_timer",
    });
    expect(reason).toBe("wake reason is heartbeat_timer (unscoped timer wake starts fresh)");
  });

  it("does not describe an issue-scoped heartbeat_timer wake as a reset", () => {
    expect(
      describeSessionResetReason({
        wakeReason: "heartbeat_timer",
        issueId: "issue-1",
      }),
    ).toBeNull();
  });

  it("returns the existing reasons for the existing reset triggers", () => {
    expect(describeSessionResetReason({ wakeReason: "issue_assigned" })).toBe(
      "wake reason is issue_assigned",
    );
    expect(describeSessionResetReason({ wakeReason: "execution_review_requested" })).toBe(
      "wake reason is execution_review_requested",
    );
    expect(describeSessionResetReason({ wakeReason: "execution_approval_requested" })).toBe(
      "wake reason is execution_approval_requested",
    );
    expect(describeSessionResetReason({ wakeReason: "execution_changes_requested" })).toBe(
      "wake reason is execution_changes_requested",
    );
  });

  it("returns the forceFreshSession message when explicitly requested", () => {
    expect(describeSessionResetReason({ forceFreshSession: true })).toBe(
      "forceFreshSession was requested",
    );
  });

  it("returns null for non-resetting wake reasons", () => {
    expect(describeSessionResetReason({ wakeReason: "issue_commented" })).toBeNull();
    expect(describeSessionResetReason({ wakeReason: "transient_failure_retry" })).toBeNull();
    expect(describeSessionResetReason({ wakeReason: "unknown_reason" })).toBeNull();
    expect(describeSessionResetReason(null)).toBeNull();
    expect(describeSessionResetReason(undefined)).toBeNull();
  });

  it("agrees with shouldResetTaskSessionForWake on every input — non-null reason iff should reset", () => {
    const cases: Array<Record<string, unknown> | null | undefined> = [
      { wakeReason: "heartbeat_timer" },
      { wakeReason: "heartbeat_timer", issueId: "issue-1" },
      { wakeReason: "issue_assigned" },
      { wakeReason: "execution_review_requested" },
      { wakeReason: "execution_approval_requested" },
      { wakeReason: "execution_changes_requested" },
      { forceFreshSession: true },
      { wakeReason: "issue_commented" },
      { wakeReason: "transient_failure_retry" },
      { wakeReason: "unknown_reason" },
      null,
      undefined,
    ];
    for (const ctx of cases) {
      const shouldReset = shouldResetTaskSessionForWake(ctx);
      const reason = describeSessionResetReason(ctx);
      expect(Boolean(reason)).toBe(shouldReset);
    }
  });
});
