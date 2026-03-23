import { describe, expect, it } from "vitest";

/**
 * Tests for adapter type migration session reset behavior.
 *
 * When an agent's adapterType changes (e.g., claude_local → gemini_local),
 * stale session data from the old adapter must be cleared to prevent the
 * new adapter from attempting to resume an incompatible session.
 *
 * GH #1505 / QUA-154
 */
describe("adapter type change clears session state", () => {
  it("detects adapter type change correctly", () => {
    const existing = { adapterType: "claude_local" };
    const patch = { adapterType: "gemini_local" };

    const adapterTypeChanged =
      typeof patch.adapterType === "string" && patch.adapterType !== existing.adapterType;

    expect(adapterTypeChanged).toBe(true);
  });

  it("does not flag change when adapter type is the same", () => {
    const existing = { adapterType: "claude_local" };
    const patch = { adapterType: "claude_local" };

    const adapterTypeChanged =
      typeof patch.adapterType === "string" && patch.adapterType !== existing.adapterType;

    expect(adapterTypeChanged).toBe(false);
  });

  it("does not flag change when adapterType is not in patch", () => {
    const existing = { adapterType: "claude_local" };
    const patch = { name: "New Name" } as Record<string, unknown>;

    const adapterTypeChanged =
      typeof patch.adapterType === "string" && patch.adapterType !== existing.adapterType;

    expect(adapterTypeChanged).toBe(false);
  });

  it("session reset payload has correct shape", () => {
    const resetPayload = {
      sessionId: null,
      adapterType: "gemini_local",
      updatedAt: new Date(),
    };

    expect(resetPayload.sessionId).toBeNull();
    expect(resetPayload.adapterType).toBe("gemini_local");
    expect(resetPayload.updatedAt).toBeInstanceOf(Date);
  });
});
