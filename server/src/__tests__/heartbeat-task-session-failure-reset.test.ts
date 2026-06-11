import { describe, expect, it } from "vitest";
import { shouldResetTaskSessionForConsecutiveFailures } from "../services/heartbeat.ts";

// SUP-2320: a task session whose runs keep failing (e.g. a poisoned resume id
// the adapter never classifies as a session error) must be auto-abandoned
// after a threshold of consecutive failures so the agent self-heals instead
// of failing every wake forever. A successful run resets the counter to 0 in
// upsertTaskSession, so reuse resumes normally after recovery.

describe("shouldResetTaskSessionForConsecutiveFailures", () => {
  it("does not reset below the threshold", () => {
    expect(shouldResetTaskSessionForConsecutiveFailures(0)).toBe(false);
    expect(shouldResetTaskSessionForConsecutiveFailures(1)).toBe(false);
    expect(shouldResetTaskSessionForConsecutiveFailures(2)).toBe(false);
  });

  it("resets at and above the threshold", () => {
    expect(shouldResetTaskSessionForConsecutiveFailures(3)).toBe(true);
    expect(shouldResetTaskSessionForConsecutiveFailures(26)).toBe(true);
  });

  it("treats missing counters as healthy", () => {
    expect(shouldResetTaskSessionForConsecutiveFailures(null)).toBe(false);
    expect(shouldResetTaskSessionForConsecutiveFailures(undefined)).toBe(false);
  });
});
