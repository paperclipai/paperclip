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
  // Released Kimi uses revision 17 to refuse saved pending-candidate sessions.
  // The upstream-only attestation migration retains that existing revision.
  kimi: 17,
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
  it("keeps both reconciled historical lineages immutable and decode-only", () => {
    const lineage = JSON.parse(readFileSync(new URL("../../../test/fixtures/profile-history-lineage.json", import.meta.url), "utf8")) as {
      schema: string; historicalDecodeOnly: boolean; executionRequiresExactCurrentProfile: boolean;
      records: Array<{ path: string; originRevision: string; sha256: string; agent: keyof typeof QUALIFIED_ACPX_PROFILE_DATA;
        version: number; commandDigest: string; launchAuthority: boolean }>;
    };
    expect(lineage.schema).toBe("paperclip.acpx-profile-history-lineage.v1");
    expect(lineage.historicalDecodeOnly).toBe(true);
    expect(lineage.executionRequiresExactCurrentProfile).toBe(true);
    const reconciled = lineage.records.filter(record => [
      "42e9d3d710a2ef5b387f9bb29bf615973b4adba9", "59da15066acd2077b1161b06217acfbd11f8da04",
    ].includes(record.originRevision));
    expect(reconciled).toHaveLength(6);
    const paths = new Set<string>();
    for (const record of reconciled) {
      expect(paths.has(record.path), record.path).toBe(false);
      paths.add(record.path);
      expect(record.originRevision, record.path).toMatch(/^[a-f0-9]{40}$/u);
      expect(record.launchAuthority, record.path).toBe(false);
      const bytes = readFileSync(new URL(`../../../../../${record.path}`, import.meta.url));
      expect(createHash("sha256").update(bytes).digest("hex"), record.path).toBe(record.sha256);
      const identity = JSON.parse(bytes.toString("utf8"));
      expect(identity.declaration.agent, record.path).toBe(record.agent);
      expect(identity.declaration.agentProfileVersion, record.path).toBe(record.version);
      expect(identity.commandDigest, record.path).toBe(record.commandDigest);
      expect(isSupportedAcpxProfileVersion(record.agent, record.version), record.path).toBe(true);
      expect(identity.commandDigest, record.path).not.toBe(QUALIFIED_ACPX_PROFILE_DATA[record.agent].commandDigest);
    }
  });

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
    for (const agent of ["copilot", "grok", "pi", "cursor", "antigravity", "kimi"] as const) {
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
