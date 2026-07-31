import { describe, expect, it } from "vitest";
import {
  RECOVERY_NON_INVOKABLE_AGENT_STATUSES,
  isAgentInvokableForRecovery,
} from "@paperclipai/shared";

describe("isAgentInvokableForRecovery", () => {
  it("treats active-ish statuses as invokable", () => {
    expect(isAgentInvokableForRecovery("active")).toBe(true);
    expect(isAgentInvokableForRecovery("idle")).toBe(true);
    expect(isAgentInvokableForRecovery("running")).toBe(true);
  });

  it("treats paused, terminated, and pending_approval as non-invokable", () => {
    expect(isAgentInvokableForRecovery("paused")).toBe(false);
    expect(isAgentInvokableForRecovery("terminated")).toBe(false);
    expect(isAgentInvokableForRecovery("pending_approval")).toBe(false);
  });

  it("treats error as non-invokable so recovery does not immediately re-queue a failing agent", () => {
    expect(isAgentInvokableForRecovery("error")).toBe(false);
  });

  it("treats null/undefined status as non-invokable", () => {
    expect(isAgentInvokableForRecovery(null)).toBe(false);
    expect(isAgentInvokableForRecovery(undefined)).toBe(false);
  });

  it("keeps the exclusion set in sync with the statuses this test documents", () => {
    expect(RECOVERY_NON_INVOKABLE_AGENT_STATUSES).toEqual(
      new Set(["paused", "terminated", "pending_approval", "error"]),
    );
  });
});
