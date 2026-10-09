import { describe, expect, it } from "vitest";
import { isSupportedAcpxProfileVersion } from "./profile-compatibility.js";

describe("historical ACPX profile decoding", () => {
  it("retains each provider's existing revision boundary", () => {
    expect(isSupportedAcpxProfileVersion("cursor", 14)).toBe(true);
    for (const agent of ["pi", "claude", "codex", "grok"]) {
      expect(isSupportedAcpxProfileVersion(agent, 5)).toBe(true);
      expect(isSupportedAcpxProfileVersion(agent, 6)).toBe(false);
    }
  });
  it("decodes retained Copilot revisions and the current profile without widening other providers", () => {
    for (const version of [1, 5, 6, 12, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33]) {
      expect(isSupportedAcpxProfileVersion("copilot", version)).toBe(true);
    }
    expect(isSupportedAcpxProfileVersion("copilot", 34)).toBe(false);
    for (const agent of ["cursor", "pi", "claude", "codex", "grok"]) {
      expect(isSupportedAcpxProfileVersion(agent, 23)).toBe(false);
      expect(isSupportedAcpxProfileVersion(agent, 24)).toBe(false);
      expect(isSupportedAcpxProfileVersion(agent, 25)).toBe(false);
      expect(isSupportedAcpxProfileVersion(agent, 26)).toBe(false);
      expect(isSupportedAcpxProfileVersion(agent, 27)).toBe(false);
    }
  });
  it.each([0, 15, 1.5, "11", null, undefined, NaN])("rejects invalid revisions: %s", version => {
    expect(isSupportedAcpxProfileVersion("cursor", version)).toBe(false);
  });
  it.each(["unknown", "toString", "__proto__"])("rejects unregistered providers: %s", agent => {
    expect(isSupportedAcpxProfileVersion(agent, 1)).toBe(false);
  });
});
