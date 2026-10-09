import { describe, expect, it } from "vitest";
import { isSupportedAcpxProfileVersion } from "./profile-compatibility.js";

describe("historical ACPX profile decoding", () => {
  it("retains each provider's existing revision boundary", () => {
    expect(isSupportedAcpxProfileVersion("cursor", 14)).toBe(true);
    expect(isSupportedAcpxProfileVersion("cursor", 15)).toBe(true);
    expect(isSupportedAcpxProfileVersion("cursor", 16)).toBe(true);
    expect(isSupportedAcpxProfileVersion("hermes", 1)).toBe(true);
    expect(isSupportedAcpxProfileVersion("hermes", 2)).toBe(false);
    for (const agent of ["pi", "claude", "codex", "grok", "copilot"]) {
      expect(isSupportedAcpxProfileVersion(agent, 5)).toBe(true);
      expect(isSupportedAcpxProfileVersion(agent, 6)).toBe(false);
    }
  });
  it.each([0, 17, 1.5, "11", null, undefined, NaN])("rejects invalid revisions: %s", version => {
    expect(isSupportedAcpxProfileVersion("cursor", version)).toBe(false);
  });
  it.each(["unknown", "toString", "__proto__"])("rejects unregistered providers: %s", agent => {
    expect(isSupportedAcpxProfileVersion(agent, 1)).toBe(false);
  });
});
