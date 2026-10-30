import { describe, expect, it } from "vitest";
import { QUALIFIED_ACPX_PROFILE_DATA } from "./generated-profiles.js";
import { isSupportedAcpxProfileVersion } from "./profile-compatibility.js";

// A profile version changes only to reset saved sessions on purpose. An upstream
// release changes the commandDigest and keeps the version; a new provider starts
// at 1. Update this table, with the reason, only for a deliberate reset.
const PROFILE_VERSIONS: Readonly<Record<string, number>> = {
  antigravity: 1, claude: 1, codex: 1, copilot: 92, cursor: 17, grok: 20, pi: 37,
};

describe("ACPX profile versions", () => {
  it("change only for a deliberate session reset", () => {
    for (const [agent, profile] of Object.entries(QUALIFIED_ACPX_PROFILE_DATA)) {
      expect(profile.agentProfileVersion, `${agent}: a profile version bump resets every saved ${agent} session. `
        + "An upstream release changes only the commandDigest. See rules/acpx-profile-identity.mdc.")
        .toBe(PROFILE_VERSIONS[agent] ?? 1);
    }
  });
});

describe("historical ACPX profile decoding", () => {
  it("decodes every revision from 1 through the current one so saved runs reach recovery", () => {
    for (const [agent, current] of Object.entries(QUALIFIED_ACPX_PROFILE_DATA)) {
      for (let version = 1; version <= current.agentProfileVersion; version += 1) {
        expect(isSupportedAcpxProfileVersion(agent, version), `${agent} v${version}`).toBe(true);
      }
    }
  });
  it("does not decode a revision newer than the current one", () => {
    for (const agent of ["copilot", "grok", "pi", "cursor", "antigravity"] as const) {
      expect(isSupportedAcpxProfileVersion(agent, QUALIFIED_ACPX_PROFILE_DATA[agent].agentProfileVersion + 1)).toBe(false);
    }
  });
  it("keeps Claude and Codex revisions 1 through 5 decodable", () => {
    for (const agent of ["claude", "codex"]) {
      expect(isSupportedAcpxProfileVersion(agent, 5)).toBe(true);
      expect(isSupportedAcpxProfileVersion(agent, 6)).toBe(false);
    }
  });
  it.each([0, -1, 1.5, "11", null, undefined, NaN, Number.MAX_SAFE_INTEGER + 1])("rejects invalid revisions: %s", version => {
    expect(isSupportedAcpxProfileVersion("cursor", version)).toBe(false);
  });
  it.each(["unknown", "toString", "__proto__"])("rejects unregistered providers: %s", agent => {
    expect(isSupportedAcpxProfileVersion(agent, 1)).toBe(false);
  });
});
