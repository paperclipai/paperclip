import { describe, expect, it } from "vitest";
import { QUALIFIED_ACPX_PROFILE_DATA } from "./generated-profiles.js";
import { isSupportedAcpxProfileVersion } from "./profile-compatibility.js";

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
