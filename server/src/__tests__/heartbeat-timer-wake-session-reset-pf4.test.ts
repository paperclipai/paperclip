import { describe, expect, it } from "vitest";
import {
  describeSessionResetReason,
  shouldResetTaskSessionForWake,
} from "../services/heartbeat.ts";

// PF-4 originally forced generic timer-driven wakes ("heartbeat_timer") to
// start fresh to avoid context growth. Fresh-session telemetry reversed that
// tradeoff after OpenAI/codex runs showed repeated fresh sessions dominating
// token use: timer wakes should keep their synthetic task session warm unless
// an explicit fresh-session request or configured rotation threshold says otherwise.

describe("PF-4 shouldResetTaskSessionForWake", () => {
  it("preserves the session when wakeReason is heartbeat_timer", () => {
    expect(
      shouldResetTaskSessionForWake({
        source: "scheduler",
        reason: "interval_elapsed",
        wakeReason: "heartbeat_timer",
      }),
    ).toBe(false);
  });

  it("preserves the session when a heartbeat_timer wake is scoped to an issue task", () => {
    expect(
      shouldResetTaskSessionForWake({
        source: "scheduler",
        reason: "interval_elapsed",
        wakeReason: "heartbeat_timer",
        taskId: "issue-1",
      }),
    ).toBe(false);
  });

  it("preserves the session when a heartbeat_timer wake only carries taskId", () => {
    expect(
      shouldResetTaskSessionForWake({
        source: "scheduler",
        reason: "interval_elapsed",
        wakeReason: "heartbeat_timer",
        taskId: "issue-1",
      }),
    ).toBe(false);
  });

  it("still resets for assignment and execution wakes without task context", () => {
    for (const wakeReason of [
      "issue_assigned",
      "execution_review_requested",
      "execution_approval_requested",
      "execution_changes_requested",
    ] as const) {
      expect(shouldResetTaskSessionForWake({ wakeReason })).toBe(true);
    }
  });

  it("preserves assignment and execution wake sessions when issue-scoped", () => {
    for (const wakeReason of [
      "issue_assigned",
      "execution_review_requested",
      "execution_approval_requested",
      "execution_changes_requested",
    ] as const) {
      expect(shouldResetTaskSessionForWake({ wakeReason, issueId: "issue-1" })).toBe(false);
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
  it("does not report a reset reason for heartbeat_timer wakes", () => {
    const reason = describeSessionResetReason({
      wakeReason: "heartbeat_timer",
    });
    expect(reason).toBeNull();
  });

  it("does not report a reset reason for issue-scoped heartbeat_timer wakes", () => {
    const reason = describeSessionResetReason({
      wakeReason: "heartbeat_timer",
      issueId: "issue-1",
    });
    expect(reason).toBeNull();
  });

  it("does not report a reset reason for taskId-only heartbeat_timer wakes", () => {
    const reason = describeSessionResetReason({
      wakeReason: "heartbeat_timer",
      taskId: "issue-1",
    });
    expect(reason).toBeNull();
  });

  it("returns the existing reasons for reset triggers without task context", () => {
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

  it("does not report reset reasons for issue-scoped assignment and execution wakes", () => {
    for (const wakeReason of [
      "issue_assigned",
      "execution_review_requested",
      "execution_approval_requested",
      "execution_changes_requested",
    ] as const) {
      expect(describeSessionResetReason({ wakeReason, issueId: "issue-1" })).toBeNull();
    }
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
      { wakeReason: "issue_assigned" },
      { wakeReason: "execution_review_requested" },
      { wakeReason: "execution_approval_requested" },
      { wakeReason: "execution_changes_requested" },
      { forceFreshSession: true },
      { wakeReason: "heartbeat_timer", taskId: "issue-1" },
      { wakeReason: "issue_assigned", taskId: "issue-1" },
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
