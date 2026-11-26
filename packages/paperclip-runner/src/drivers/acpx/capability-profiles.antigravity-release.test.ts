import { describe, expect, it, vi } from "vitest";

// The same build with Antigravity's `qualificationStatus` removed.
vi.mock("./qualified-profiles.js", async importOriginal => {
  const actual = await importOriginal<typeof import("./qualified-profiles.js")>();
  const { qualificationStatus: _pending, ...antigravity } = actual.QUALIFIED_ACPX_PROFILES.antigravity;
  return { ...actual, QUALIFIED_ACPX_PROFILES: { ...actual.QUALIFIED_ACPX_PROFILES, antigravity } };
});

describe("Antigravity capability claims at the qualification flip", () => {
  it("exposes form questions and interactive permissions once released", async () => {
    const { ACPX_CAPABILITY_PROFILES } = await import("./capability-profiles.js");
    expect(ACPX_CAPABILITY_PROFILES.antigravity).toMatchObject({ questions: "form", permissions: "interactive" });
    // Recovery stays unverified until a live cell proves a cross-process load.
    expect(ACPX_CAPABILITY_PROFILES.antigravity.recovery).toBe("unverified");
  });
});
