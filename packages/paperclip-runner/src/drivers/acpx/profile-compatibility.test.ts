import { describe, expect, it } from "vitest";
import { isSupportedAcpxProfileVersion } from "./profile-compatibility.js";

describe("historical ACPX profile decoding", () => {
  it("retains each provider's existing revision boundary", () => {
    expect(isSupportedAcpxProfileVersion("cursor", 14)).toBe(true);
    for (const agent of ["pi", "claude", "codex", "grok", "copilot"]) {
      expect(isSupportedAcpxProfileVersion(agent, 5)).toBe(true);
      expect(isSupportedAcpxProfileVersion(agent, 6)).toBe(false);
    }
  });
  it.each([0, 15, 1.5, "11", null, undefined, NaN])("rejects invalid revisions: %s", version => {
    expect(isSupportedAcpxProfileVersion("cursor", version)).toBe(false);
  });
  it.each(["unknown", "toString", "__proto__"])("rejects unregistered providers: %s", agent => {
    expect(isSupportedAcpxProfileVersion(agent, 1)).toBe(false);
  });
});
