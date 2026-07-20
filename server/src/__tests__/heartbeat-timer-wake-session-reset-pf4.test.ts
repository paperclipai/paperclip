import { describe, expect, it } from "vitest";
import {
  describeSessionResetReason,
  shouldResetTaskSessionForWake,
} from "../services/heartbeat.ts";

// PF-4: timer-driven wakes ("heartbeat_timer") are exploratory and do not
// carry continuation state. Reusing the prior task session for repeated
// timer wakes accumulates low-value context and pushes the session toward
// the 64k compaction threshold (observed in CEO run 292a5fd1). Timer wakes
// therefore still start fresh.
//
// Execution-policy handoffs are different: review and change-request wakes
// are issue-local continuations and should be allowed to reach the durable
// task-session lookup. Config/model/workspace/session freshness checks still
// force or fall back to fresh sessions when reuse would be unsafe.
describe("shouldResetTaskSessionForWake", () => {
  it("resets the session when wakeReason is heartbeat_timer", () => {
    expect(
      shouldResetTaskSessionForWake({
        source: "scheduler",
        reason: "interval_elapsed",
        wakeReason: "heartbeat_timer",
      }),
    ).toBe(true);
  });

  it("keeps assignment, approval, and review-participant recovery as fresh boundaries", () => {
    for (const wakeReason of [
      "issue_assigned",
      "execution_approval_requested",
      "execution_review_participant_recovery",
    ] as const) {
      expect(shouldResetTaskSessionForWake({ wakeReason })).toBe(true);
    }
  });

  it("does not reset execution handoffs by wake reason alone", () => {
    for (const wakeReason of [
      "execution_review_requested",
      "execution_changes_requested",
    ] as const) {
      expect(shouldResetTaskSessionForWake({ wakeReason })).toBe(false);
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

describe("describeSessionResetReason", () => {
  it("describes heartbeat_timer wakes explicitly so run logs explain the reset", () => {
    const reason = describeSessionResetReason({
      wakeReason: "heartbeat_timer",
    });
    expect(reason).toBe("wake reason is heartbeat_timer (timer-driven wake starts fresh)");
  });

  it("returns reasons for wake reasons that still force a fresh task session", () => {
    expect(describeSessionResetReason({ wakeReason: "issue_assigned" })).toBe(
      "wake reason is issue_assigned",
    );
    expect(describeSessionResetReason({ wakeReason: "execution_approval_requested" })).toBe(
      "wake reason is execution_approval_requested",
    );
    expect(
      describeSessionResetReason({ wakeReason: "execution_review_participant_recovery" }),
    ).toBe("wake reason is execution_review_participant_recovery");
  });

  it("does not report review/change-request handoffs as reset reasons", () => {
    expect(describeSessionResetReason({ wakeReason: "execution_review_requested" })).toBeNull();
    expect(describeSessionResetReason({ wakeReason: "execution_changes_requested" })).toBeNull();
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
      { wakeReason: "execution_review_participant_recovery" },
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
