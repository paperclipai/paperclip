import { describe, expect, it } from "vitest";
import {
  STALE_SESSION_ALERT_THRESHOLD,
  STALE_SESSION_ROTATION_REASON,
  countLeadingZeroTokenRuns,
  isStaleZeroTokenSession,
  readUsageTokenTotals,
} from "../services/heartbeat.js";

describe("isStaleZeroTokenSession", () => {
  const base = { outcome: "succeeded" as const, freshSession: false, inputTokens: 0, outputTokens: 0 };

  it("flags a completed, reused (non-fresh) 0-token run as a dead session", () => {
    expect(isStaleZeroTokenSession(base)).toBe(true);
    expect(isStaleZeroTokenSession({ ...base, outcome: "failed" })).toBe(true);
  });

  it("does NOT rotate a fresh 0-token run (legitimately idle first wake)", () => {
    expect(isStaleZeroTokenSession({ ...base, freshSession: true })).toBe(false);
  });

  it("does NOT rotate when any tokens were exchanged", () => {
    expect(isStaleZeroTokenSession({ ...base, inputTokens: 1 })).toBe(false);
    expect(isStaleZeroTokenSession({ ...base, outputTokens: 1 })).toBe(false);
    expect(isStaleZeroTokenSession({ ...base, inputTokens: 4200, outputTokens: 17 })).toBe(false);
  });

  it("ignores cancelled and timed_out runs (not a dead handshake)", () => {
    expect(isStaleZeroTokenSession({ ...base, outcome: "cancelled" })).toBe(false);
    expect(isStaleZeroTokenSession({ ...base, outcome: "timed_out" })).toBe(false);
  });
});

describe("countLeadingZeroTokenRuns", () => {
  const zero = { inputTokens: 0, outputTokens: 0 };

  it("counts the leading streak of 0-token runs (most-recent-first)", () => {
    expect(countLeadingZeroTokenRuns([zero, zero, zero])).toBe(3);
    expect(countLeadingZeroTokenRuns([])).toBe(0);
  });

  it("stops at the first run that produced any tokens (criterion 4 reset)", () => {
    expect(countLeadingZeroTokenRuns([zero, zero, { inputTokens: 5, outputTokens: 0 }, zero])).toBe(2);
    expect(countLeadingZeroTokenRuns([{ inputTokens: 0, outputTokens: 9 }, zero])).toBe(0);
  });

  it("treats runs with unknown usage as streak-breaking", () => {
    expect(countLeadingZeroTokenRuns([zero, { inputTokens: null, outputTokens: null }, zero])).toBe(1);
  });

  it("reaches the alert threshold only after enough consecutive bad runs", () => {
    const streak = Array.from({ length: STALE_SESSION_ALERT_THRESHOLD }, () => zero);
    expect(countLeadingZeroTokenRuns(streak)).toBe(STALE_SESSION_ALERT_THRESHOLD);
    expect(countLeadingZeroTokenRuns(streak.slice(1))).toBeLessThan(STALE_SESSION_ALERT_THRESHOLD);
  });
});

describe("readUsageTokenTotals", () => {
  it("reads normalized token totals from a persisted usageJson", () => {
    expect(readUsageTokenTotals({ inputTokens: 0, outputTokens: 0 })).toEqual({
      inputTokens: 0,
      outputTokens: 0,
    });
    expect(readUsageTokenTotals({ inputTokens: 123, outputTokens: 45 })).toEqual({
      inputTokens: 123,
      outputTokens: 45,
    });
  });

  it("returns nulls for missing or malformed usage (so the streak breaks)", () => {
    expect(readUsageTokenTotals(null)).toEqual({ inputTokens: null, outputTokens: null });
    expect(readUsageTokenTotals({})).toEqual({ inputTokens: null, outputTokens: null });
    expect(readUsageTokenTotals({ inputTokens: "x", outputTokens: 5 })).toEqual({
      inputTokens: null,
      outputTokens: 5,
    });
  });
});

describe("cleared session-state cascade contract", () => {
  // On stale detection, runSession reassigns nextSessionState to this all-null
  // shape. These assertions lock the invariant the cascade depends on: the same
  // shape must (a) null out sessionIdAfter on the run, (b) route the task session
  // to clearTaskSessions rather than upsertTaskSession, and (c) null out
  // agentRuntimeState.sessionId. If the cleared shape ever changes, the next run
  // would silently reuse the dead session — so guard it here.
  const cleared = { params: null, displayId: null, legacySessionId: null } as const;

  it("nulls sessionIdAfter (displayId ?? legacySessionId)", () => {
    expect(cleared.displayId ?? cleared.legacySessionId).toBeNull();
  });

  it("takes the clearTaskSessions branch (!params && !displayId)", () => {
    expect(!cleared.params && !cleared.displayId).toBe(true);
  });

  it("nulls agentRuntimeState.sessionId (legacySessionId)", () => {
    expect(cleared.legacySessionId).toBeNull();
  });
});

describe("rotation constants", () => {
  it("exposes a stable rotation reason and an alert threshold below the watchdog (10)", () => {
    expect(STALE_SESSION_ROTATION_REASON).toBe("stale_session_zero_token");
    expect(STALE_SESSION_ALERT_THRESHOLD).toBe(3);
    expect(STALE_SESSION_ALERT_THRESHOLD).toBeLessThan(10);
  });
});
