import { describe, expect, it } from "vitest";
import { shouldSelfWake, hasNonDelegatedWork } from "../services/heartbeat.js";

describe("shouldSelfWake", () => {
  it("returns true when outcome is succeeded", () => {
    expect(shouldSelfWake("succeeded", undefined)).toBe(true);
  });

  it("returns true when outcome is failed with task-specific error", () => {
    expect(shouldSelfWake("failed", "some_task_error")).toBe(true);
  });

  it("returns true when outcome is failed with no errorCode", () => {
    expect(shouldSelfWake("failed", undefined)).toBe(true);
  });

  it("returns true when outcome is failed with null errorCode", () => {
    expect(shouldSelfWake("failed", null)).toBe(true);
  });

  it("returns false when outcome is failed with auth_failed", () => {
    expect(shouldSelfWake("failed", "auth_failed")).toBe(false);
  });

  it("returns false when outcome is failed with claude_auth_required", () => {
    expect(shouldSelfWake("failed", "claude_auth_required")).toBe(false);
  });

  it("returns false when outcome is failed with adapter_failed", () => {
    expect(shouldSelfWake("failed", "adapter_failed")).toBe(false);
  });

  it("returns false when outcome is failed with timeout", () => {
    expect(shouldSelfWake("failed", "timeout")).toBe(false);
  });

  // A Claude CLI usage/rate-limit hit is systemic — retrying immediately
  // burns tokens without any chance of success until the subscription
  // window resets. Must short-circuit the self-wake chain or the agent
  // tight-loops making 429-ing API calls. See claude-local-adapter.test.ts
  // for detection-side tests and the original diagnosis.
  it("returns false when outcome is failed with claude_usage_limited", () => {
    expect(shouldSelfWake("failed", "claude_usage_limited")).toBe(false);
  });

  // Max turns is NOT a systemic failure — the agent did real work but
  // exhausted its turn budget. It should still self-wake to process
  // remaining inbox items in a fresh session.
  it("returns true when outcome is failed with claude_max_turns", () => {
    expect(shouldSelfWake("failed", "claude_max_turns")).toBe(true);
  });

  it("returns false when outcome is timed_out", () => {
    expect(shouldSelfWake("timed_out", undefined)).toBe(false);
  });

  it("returns false when outcome is cancelled", () => {
    expect(shouldSelfWake("cancelled", undefined)).toBe(false);
  });

  it("returns false when outcome is timed_out with timeout errorCode", () => {
    expect(shouldSelfWake("timed_out", "timeout")).toBe(false);
  });

  it("returns false when outcome is cancelled with cancelled errorCode", () => {
    expect(shouldSelfWake("cancelled", "cancelled")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// hasNonDelegatedWork — exported for verification
//
// This helper is used by the self-wake gate to prevent CTO polling loops.
// When the CTO delegates subtasks and the only remaining assigned issues are
// parents waiting on open children, the self-wake should be suppressed.
// The CTO will instead be woken by `engineer_run_completed` events.
//
// Full integration testing requires a database; these are smoke tests to
// verify the export exists and the function signature is correct.
// ---------------------------------------------------------------------------

describe("hasNonDelegatedWork", () => {
  it("is exported as an async function", () => {
    expect(typeof hasNonDelegatedWork).toBe("function");
  });
});
