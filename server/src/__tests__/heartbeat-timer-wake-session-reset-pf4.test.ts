import { describe, expect, it } from "vitest";
import {
  describeSessionResetReason,
  shouldResetTaskSessionForWake,
} from "../services/heartbeat.ts";

// PF-4: timer-driven wakes ("heartbeat_timer") are exploratory and do not
// carry continuation state. Reusing the prior task session for repeated
// timer wakes accumulates low-value context and pushes the session toward
// the 64k compaction threshold (observed in CEO run 292a5fd1). The
// shouldResetTaskSessionForWake / describeSessionResetReason pair must
// agree that timer wakes start a fresh session, while preserving the
// existing reset rules for assignment / review / approval / changes wakes
// and the existing reuse policy for issue_commented and other reasons.

describe("PF-4 shouldResetTaskSessionForWake", () => {
  it("resets the session when wakeReason is heartbeat_timer", () => {
    expect(
      shouldResetTaskSessionForWake({
        source: "scheduler",
        reason: "interval_elapsed",
        wakeReason: "heartbeat_timer",
      }),
    ).toBe(true);
  });

  it("resets the session when wakeReason is heartbeat_idle (gh#8015)", () => {
    // An idle timer wake (no standing work) is even more exploratory than a
    // regular timer wake, so it must get the same fresh-session treatment.
    expect(
      shouldResetTaskSessionForWake({
        source: "scheduler",
        reason: "interval_elapsed_idle",
        idle: true,
        wakeReason: "heartbeat_idle",
      }),
    ).toBe(true);
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
  it("describes heartbeat_timer wakes explicitly so run logs explain the reset", () => {
    const reason = describeSessionResetReason({
      wakeReason: "heartbeat_timer",
    });
    expect(reason).toBe("wake reason is heartbeat_timer (timer-driven wake starts fresh)");
  });

  it("describes heartbeat_idle wakes explicitly (gh#8015)", () => {
    const reason = describeSessionResetReason({
      wakeReason: "heartbeat_idle",
    });
    expect(reason).toBe(
      "wake reason is heartbeat_idle (idle timer wake with no standing work starts fresh)",
    );
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
      { wakeReason: "heartbeat_idle" },
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
