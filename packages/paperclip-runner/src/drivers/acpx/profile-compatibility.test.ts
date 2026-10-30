import { readdirSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
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
  it.each([
    ["copilot", "copilot-profile-v88-identity.json", "81e5fbccf057c04e012f638dc7a02c5758bf6ca67f7c4ed0045f3f61525401c2", "published cd5"],
    ["copilot", "copilot-profile-v88-cursor-cloud-qualification-historical-identity.json", "6010dc772d914afec7dd31f35f953ce74b65ab3a648ce54aaee559f908b492f9", "private Cloud qualification"],
    ["grok", "grok-profile-v15-identity.json", "54f7063c82dc5b135a9b5e2b0d8653b5c839a42bbc3a845dbcfb6cd225fa623f", "published cd5"],
    ["grok", "grok-profile-v15-cursor-cloud-qualification-historical-identity.json", "f5d4b41284d60413575f88371e66e940942c256d8b6d9619104deaee181054b2", "private Cloud qualification"],
    ["copilot", "copilot-profile-v86-identity.json", "6baeb98adc7132b2afdce8b1d2da1df2f00356677eb4497c49c05aa9def79138", "published a8"],
    ["copilot", "copilot-profile-v86-cursor-cloud-qualification-historical-identity.json", "118a4b0a782b56570e5530cca91255da8932c31f827c319b40a5810bd4d446e9", "private Cloud qualification"],
    ["copilot", "copilot-profile-v87-identity.json", "505bb72a933d11e3f5aa8a1700d239c06b4d34bb83d5187470483812df996501", "published a8"],
    ["copilot", "copilot-profile-v87-cursor-cloud-qualification-historical-identity.json", "ce9912c34ae9126e74061f7bc170b59589af7cb6ab26751e250da9e9dd9553c9", "private Cloud qualification"],
    ["copilot", "copilot-profile-v85-identity.json", "15d2790d94d7cc46ac728119ed9b4d07ed2b682be039b3debc716600708d8c1a", "published ed8"],
    ["copilot", "copilot-profile-v85-cursor-cloud-qualification-historical-identity.json", "977d68b327f3964e8337ef8ba00230eb1b1697017db21f8010f664fee3d3c70a", "private Cloud qualification"],
    ["grok", "grok-profile-v14-identity.json", "08294ec6bdcbdbe46c8c8b711d8b368558a05f0d84d25c9f5fd0c3b67b79cd17", "published ed8"],
    ["grok", "grok-profile-v14-cursor-cloud-qualification-historical-identity.json", "fa34ba395ff51affed7e7195dc44f4e33a3c6718ada1c80e8e36852cf7af40ac", "private Cloud qualification"],
  ] as const)("keeps %s identity %s immutable and decode-only", (agent, filename, checksum) => {
    const bytes = readFileSync(new URL(`../../../test/fixtures/${filename}`, import.meta.url));
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(checksum);
    const identity = JSON.parse(bytes.toString("utf8"));
    expect(isSupportedAcpxProfileVersion(agent, identity.declaration.agentProfileVersion)).toBe(true);
    expect(identity.commandDigest).not.toBe(QUALIFIED_ACPX_PROFILE_DATA[agent].commandDigest);
  });

  it("decodes every retained Copilot identity so saved runs can reach recovery", () => {
    const root = new URL("../../../test/fixtures/", import.meta.url);
    const files = readdirSync(root).filter(name => /^copilot-profile-v\d+.*-identity\.json$/u.test(name));
    expect(files.length).toBeGreaterThan(30);
    for (const file of files) {
      const identity = JSON.parse(readFileSync(new URL(file, root), "utf8"));
      expect(isSupportedAcpxProfileVersion("copilot", identity.declaration.agentProfileVersion), file).toBe(true);
    }
  });
  it("decodes every retained Grok identity so saved runs can reach recovery", () => {
    const root = new URL("../../../test/fixtures/", import.meta.url);
    const files = readdirSync(root).filter(name => /^grok-profile-v\d+.*-identity\.json$/u.test(name));
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const identity = JSON.parse(readFileSync(new URL(file, root), "utf8"));
      expect(isSupportedAcpxProfileVersion("grok", identity.declaration.agentProfileVersion), file).toBe(true);
    }
  });
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
