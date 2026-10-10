import { describe, expect, it } from "vitest";
import { QUALIFIED_ACPX_PROFILE_DATA } from "./generated-profiles.js";
import { isSupportedAcpxProfileVersion } from "./profile-compatibility.js";

describe("historical ACPX profile decoding", () => {
  it("retains each provider's existing revision boundary", () => {
    expect(isSupportedAcpxProfileVersion("pi", 17)).toBe(true);
    expect(isSupportedAcpxProfileVersion("pi", 18)).toBe(true);
    expect(isSupportedAcpxProfileVersion("cursor", 15)).toBe(true);
    expect(isSupportedAcpxProfileVersion("cursor", 16)).toBe(false);
    for (const agent of ["pi", "copilot"]) {
      expect(isSupportedAcpxProfileVersion(agent, 16)).toBe(true);
      const current = QUALIFIED_ACPX_PROFILE_DATA[agent as "pi" | "copilot"].agentProfileVersion;
      expect(isSupportedAcpxProfileVersion(agent, current)).toBe(true);
      expect(isSupportedAcpxProfileVersion(agent, Math.max(16, current) + 1)).toBe(false);
    }
    for (const agent of ["claude", "codex", "grok"]) {
      expect(isSupportedAcpxProfileVersion(agent, 5)).toBe(true);
      expect(isSupportedAcpxProfileVersion(agent, 6)).toBe(false);
    }
  });
  it.each([0, 1.5, "11", null, undefined, NaN])("rejects invalid revisions: %s", version => {
    expect(isSupportedAcpxProfileVersion("cursor", version)).toBe(false);
  });
  it("decodes every current release while retaining exact launch admission separately", () => {
    for (const [agent, current] of Object.entries(QUALIFIED_ACPX_PROFILE_DATA)) {
      expect(isSupportedAcpxProfileVersion(agent, current.agentProfileVersion)).toBe(true);
    }
  });
  it.each(["unknown", "toString", "__proto__"])("rejects unregistered providers: %s", agent => {
    expect(isSupportedAcpxProfileVersion(agent, 1)).toBe(false);
  });
});
