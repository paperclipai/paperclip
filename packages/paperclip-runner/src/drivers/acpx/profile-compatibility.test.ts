import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { QUALIFIED_ACPX_PROFILE_DATA } from "./generated-profiles.js";
import { isSupportedAcpxProfileVersion } from "./profile-compatibility.js";

describe("historical ACPX profile decoding", () => {
  it("retains historical Kimi and Copilot declarations while admitting only current launch identities", () => {
    expect(isSupportedAcpxProfileVersion("kimi", 13)).toBe(true);
    expect(isSupportedAcpxProfileVersion("kimi", 12)).toBe(false);
    expect(isSupportedAcpxProfileVersion("kimi", 14)).toBe(true);
    expect(isSupportedAcpxProfileVersion("kimi", 15)).toBe(true);
    expect(isSupportedAcpxProfileVersion("kimi", 16)).toBe(true);
    expect(isSupportedAcpxProfileVersion("kimi", 17)).toBe(true);
    expect(isSupportedAcpxProfileVersion("kimi", 18)).toBe(false);
    expect(isSupportedAcpxProfileVersion("copilot", 88)).toBe(true);
    expect(isSupportedAcpxProfileVersion("copilot", 89)).toBe(true);
    expect(isSupportedAcpxProfileVersion("copilot", 90)).toBe(true);
    expect(isSupportedAcpxProfileVersion("copilot", 91)).toBe(true);
    expect(isSupportedAcpxProfileVersion("copilot", 92)).toBe(true);
    expect(isSupportedAcpxProfileVersion("copilot", 93)).toBe(false);
    expect(isSupportedAcpxProfileVersion("grok", 15)).toBe(true);
    expect(isSupportedAcpxProfileVersion("grok", 16)).toBe(true);
    expect(isSupportedAcpxProfileVersion("grok", 17)).toBe(true);
    expect(isSupportedAcpxProfileVersion("grok", 18)).toBe(true);
    expect(isSupportedAcpxProfileVersion("grok", 19)).toBe(true);
    expect(isSupportedAcpxProfileVersion("grok", 20)).toBe(false);
  });
  it("retains each provider's existing revision boundary", () => {
    expect(isSupportedAcpxProfileVersion("grok", 7)).toBe(true);
    expect(isSupportedAcpxProfileVersion("pi", 30)).toBe(true);
    expect(isSupportedAcpxProfileVersion("copilot", 71)).toBe(true);
    expect(isSupportedAcpxProfileVersion("copilot", 17)).toBe(true);
    expect(isSupportedAcpxProfileVersion("pi", 17)).toBe(true);
    expect(isSupportedAcpxProfileVersion("pi", 18)).toBe(true);
    expect(isSupportedAcpxProfileVersion("pi", 23)).toBe(true);
    expect(isSupportedAcpxProfileVersion("cursor", 15)).toBe(true);
    expect(isSupportedAcpxProfileVersion("cursor", 16)).toBe(true);
    expect(isSupportedAcpxProfileVersion("cursor", 17)).toBe(false);
    for (const agent of ["pi", "copilot"]) {
      expect(isSupportedAcpxProfileVersion(agent, 16)).toBe(true);
      const current = QUALIFIED_ACPX_PROFILE_DATA[agent as "pi" | "copilot"].agentProfileVersion;
      expect(isSupportedAcpxProfileVersion(agent, current)).toBe(true);
      expect(isSupportedAcpxProfileVersion(agent, Math.max(16, current) + 1)).toBe(false);
    }
    for (const agent of ["claude", "codex"]) {
      expect(isSupportedAcpxProfileVersion(agent, 5)).toBe(true);
      expect(isSupportedAcpxProfileVersion(agent, 6)).toBe(false);
    }
    for (const version of [1, 2, 3, 4, 5, QUALIFIED_ACPX_PROFILE_DATA.grok.agentProfileVersion]) {
      expect(isSupportedAcpxProfileVersion("grok", version)).toBe(true);
    }
    expect(isSupportedAcpxProfileVersion("grok", QUALIFIED_ACPX_PROFILE_DATA.grok.agentProfileVersion + 1)).toBe(false);
  });
  it("decodes retained Copilot revisions and the current profile without widening other providers", () => {
    for (const version of [1, 5, 6, 12, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40]) {
      expect(isSupportedAcpxProfileVersion("copilot", version)).toBe(true);
    }
    expect(isSupportedAcpxProfileVersion("copilot", QUALIFIED_ACPX_PROFILE_DATA.copilot.agentProfileVersion + 1)).toBe(false);
    // Preserve Pi history and its current mainline release without admitting the next profile.
    expect(isSupportedAcpxProfileVersion("pi", 23)).toBe(true);
    expect(isSupportedAcpxProfileVersion("pi", QUALIFIED_ACPX_PROFILE_DATA.pi.agentProfileVersion)).toBe(true);
    expect(isSupportedAcpxProfileVersion("pi", QUALIFIED_ACPX_PROFILE_DATA.pi.agentProfileVersion + 1)).toBe(false);
    for (const agent of ["cursor", "claude", "codex", "grok"]) {
      expect(isSupportedAcpxProfileVersion(agent, 23)).toBe(false);
      expect(isSupportedAcpxProfileVersion(agent, 24)).toBe(false);
      expect(isSupportedAcpxProfileVersion(agent, 25)).toBe(false);
      expect(isSupportedAcpxProfileVersion(agent, 26)).toBe(false);
      expect(isSupportedAcpxProfileVersion(agent, 27)).toBe(false);
    }
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
    const files = readdirSync(root).filter(name => /^grok-profile-v\d+-identity\.json$/u.test(name));
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const identity = JSON.parse(readFileSync(new URL(file, root), "utf8"));
      expect(isSupportedAcpxProfileVersion("grok", identity.declaration.agentProfileVersion), file).toBe(true);
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


describe("independent historical profile declarations", () => {
  it("retains both exact source lineages without granting old execution identities", () => {
    const lineage = JSON.parse(readFileSync(new URL("../../../test/fixtures/profile-history-lineage.json", import.meta.url), "utf8"));
    expect(lineage.historicalDecodeOnly).toBe(true);
    expect(lineage.executionRequiresExactCurrentProfile).toBe(true);
    expect(lineage.records).toHaveLength(14);
    const variants = new Map<string, Set<string>>();
    for (const record of lineage.records) {
      const bytes = readFileSync(new URL(`../../../../../${record.path}`, import.meta.url));
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(record.sha256);
      const identity = JSON.parse(bytes.toString("utf8"));
      expect(identity.declaration.agent).toBe(record.agent);
      expect(identity.declaration.agentProfileVersion).toBe(record.version);
      expect(identity.commandDigest).toBe(record.commandDigest);
      expect(record.launchAuthority).toBe(false);
      expect(isSupportedAcpxProfileVersion(record.agent, record.version)).toBe(true);
      expect(QUALIFIED_ACPX_PROFILE_DATA[record.agent as keyof typeof QUALIFIED_ACPX_PROFILE_DATA].commandDigest).not.toBe(record.commandDigest);
      const key = `${record.agent}:${record.version}`;
      const values = variants.get(key) ?? new Set<string>();
      values.add(record.commandDigest); variants.set(key, values);
    }
    expect(variants.size).toBe(7);
    for (const values of variants.values()) expect(values.size).toBe(2);
  });
});
