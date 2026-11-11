import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { assertKimiInstallationProfile, verifyKimiInstallation } from "./kimi-installation.js";
import { QUALIFIED_ACPX_PROFILES } from "./qualified-profiles.js";
import { isSupportedAcpxProfileVersion } from "./profile-compatibility.js";

const roots: string[] = [];
const previous = new Map<string, string | undefined>();
function environment(key: string, value: string) {
  if (!previous.has(key)) previous.set(key, process.env[key]);
  process.env[key] = value;
}
afterEach(async () => {
  for (const [key, value] of previous) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  previous.clear();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe("Kimi installed runtime admission", () => {
  it("rejects caller-selected package/version/command changes before filesystem resolution", () => {
    const profile = QUALIFIED_ACPX_PROFILES.kimi;
    expect(() => assertKimiInstallationProfile(profile)).not.toThrow();
    for (const alteration of [{ agentServerVersion: "latest" }, { agentServerPackage: "foreign" }, { commandDigest: `sha256:${"f".repeat(64)}` }, { agentProfileVersion: profile.agentProfileVersion + 1 }]) {
      expect(() => assertKimiInstallationProfile({ ...profile, ...alteration })).toThrow(/trusted declaration/);
    }
  });

  it("retains pending profile 10 while binding the merged entrypoint builder in profile 11", () => {
    const bytes = readFileSync(new URL("../../../test/fixtures/kimi-profile-v10-identity.json", import.meta.url));
    expect(createHash("sha256").update(bytes).digest("hex")).toBe("b859f4aefcc36fc5e75b3aeeb02135ca9f7acc84866c856a3939effdd13cb358");
    const prior = JSON.parse(bytes.toString("utf8"));
    const current = JSON.parse(readFileSync(new URL("../../../test/fixtures/kimi-profile-v11-identity.json", import.meta.url), "utf8"));
    expect(Object.keys(current.declaration.sources).filter(key => current.declaration.sources[key] !== prior.declaration.sources[key])).toEqual([
      "scripts/build-verified-provider-entrypoints.mjs",
    ]);
    expect(() => assertKimiInstallationProfile({ ...QUALIFIED_ACPX_PROFILES.kimi,
      agentProfileVersion: 10, commandDigest: prior.commandDigest })).toThrow(/trusted declaration/);
  });

  it("preserves historical profile 11 while binding the reconciled authority and event boundaries in 13", () => {
    const bytes = readFileSync(new URL("../../../test/fixtures/kimi-profile-v11-identity.json", import.meta.url));
    expect(createHash("sha256").update(bytes).digest("hex")).toBe("17b3db5659cfbaa4d3f5dddd8a97ffeab38353795aa4dbfa6c6fe1520f415ab1");
    const prior = JSON.parse(bytes.toString("utf8"));
    const current = JSON.parse(readFileSync(new URL("../../../test/fixtures/kimi-profile-v13-identity.json", import.meta.url), "utf8"));
    expect(prior.declaration.agentProfileVersion).toBe(11);
    expect(Object.keys(prior.declaration.sources)).toHaveLength(31);
    expect(current.declaration.agentProfileVersion).toBe(13);
    expect(Object.keys(current.declaration.sources)).toHaveLength(55);
    expect(Object.hasOwn(current.declaration.sources, "src/drivers/acpx/candidate-admission.ts")).toBe(true);
    expect(Object.hasOwn(current.declaration.sources, "runner/crates/runner-core/src/provider_events.rs")).toBe(true);
    expect(isSupportedAcpxProfileVersion("kimi", 11)).toBe(true);
    expect(() => assertKimiInstallationProfile({ ...QUALIFIED_ACPX_PROFILES.kimi,
      agentProfileVersion: 11, commandDigest: prior.commandDigest })).toThrow(/trusted declaration/);
  });

  it("decodes pending14 history without installing it as the repaired pending15 runtime", () => {
    const bytes = readFileSync(new URL("../../../test/fixtures/kimi-profile-v14-identity.json", import.meta.url));
    expect(createHash("sha256").update(bytes).digest("hex")).toBe("13ce8e301e6b7d622f4b3ffdca7981e18538e7a5ca2f1b2208ec466259469e7b");
    const prior = JSON.parse(bytes.toString("utf8"));
    const current = JSON.parse(readFileSync(new URL("../../../test/fixtures/kimi-profile-v15-identity.json", import.meta.url), "utf8"));
    expect(current.declaration.agentProfileVersion).toBe(15);
    expect(Object.keys(current.declaration.sources)).toHaveLength(55);
    expect(Object.keys(current.declaration.sources).filter(key => current.declaration.sources[key] !== prior.declaration.sources[key])).toEqual([
      "runner/crates/runner-core/src/acpx_provider_backend.rs",
    ]);
    expect(isSupportedAcpxProfileVersion("kimi", 14)).toBe(true);
    expect(() => assertKimiInstallationProfile({ ...QUALIFIED_ACPX_PROFILES.kimi,
      agentProfileVersion: 14, commandDigest: prior.commandDigest })).toThrow(/trusted declaration/);
    expect(() => assertKimiInstallationProfile(QUALIFIED_ACPX_PROFILES.kimi)).not.toThrow();
  });

  it("decodes pending15 history without installing it as merged pending16", () => {
    const bytes = readFileSync(new URL("../../../test/fixtures/kimi-profile-v15-identity.json", import.meta.url));
    expect(createHash("sha256").update(bytes).digest("hex")).toBe("5221f6f9f64c02ca7ee68b185e08ed46b1c82a13037b001854065b9fad28ff87");
    const prior = JSON.parse(bytes.toString("utf8"));
    const current = JSON.parse(readFileSync(new URL("../../../test/fixtures/kimi-profile-v16-identity.json", import.meta.url), "utf8"));
    expect(current.declaration.agentProfileVersion).toBe(16);
    expect(current.declaration.qualificationStatus).toBe("pending");
    expect(Object.keys(current.declaration.sources)).toHaveLength(58);
    expect(isSupportedAcpxProfileVersion("kimi", 15)).toBe(true);
    expect(() => assertKimiInstallationProfile({ ...QUALIFIED_ACPX_PROFILES.kimi,
      agentProfileVersion: 15, commandDigest: prior.commandDigest })).toThrow(/trusted declaration/);
    expect(() => assertKimiInstallationProfile(QUALIFIED_ACPX_PROFILES.kimi)).not.toThrow();
  });

  it("decodes pending16 history without installing it as ordinary released17", () => {
    const bytes = readFileSync(new URL("../../../test/fixtures/kimi-profile-v16-identity.json", import.meta.url));
    expect(createHash("sha256").update(bytes).digest("hex")).toBe("69e5fb7e7c445be7eee37bf7e6a8fa135cf2f88e0a997a95065ca79526e91470");
    const prior = JSON.parse(bytes.toString("utf8"));
    expect(prior.declaration.qualificationStatus).toBe("pending");
    expect(isSupportedAcpxProfileVersion("kimi", 16)).toBe(true);
    expect(QUALIFIED_ACPX_PROFILES.kimi.agentProfileVersion).toBe(17);
    expect(QUALIFIED_ACPX_PROFILES.kimi.qualificationStatus).toBeUndefined();
    expect(() => assertKimiInstallationProfile({ ...QUALIFIED_ACPX_PROFILES.kimi,
      agentProfileVersion: 16, commandDigest: prior.commandDigest })).toThrow(/trusted declaration/);
    expect(() => assertKimiInstallationProfile(QUALIFIED_ACPX_PROFILES.kimi)).not.toThrow();
  });

  it("preserves the source-bound released17 identity without accepting its old digest", () => {
    const bytes = readFileSync(new URL("../../../test/fixtures/kimi-profile-v17-identity.json", import.meta.url));
    expect(createHash("sha256").update(bytes).digest("hex")).toBe("c3b6a1bf95e7de1abf7a07f042b5dbe9c10d1a3ae2007a886b6387d779a7a205");
    const historical = JSON.parse(bytes.toString("utf8"));
    expect(historical.declaration.agentProfileVersion).toBe(17);
    expect(QUALIFIED_ACPX_PROFILES.kimi.agentProfileVersion).toBe(17);
    expect(QUALIFIED_ACPX_PROFILES.kimi.commandDigest).not.toBe(historical.commandDigest);
    expect(() => assertKimiInstallationProfile({ ...QUALIFIED_ACPX_PROFILES.kimi,
      commandDigest: historical.commandDigest })).toThrow(/trusted declaration/);
    expect(() => assertKimiInstallationProfile(QUALIFIED_ACPX_PROFILES.kimi)).not.toThrow();
  });

  it("gives the normal setup command and never falls back to ambient kimi when assets are missing", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "paperclip-kimi-installation-test-"))); roots.push(root);
    await writeFile(join(root, "package.json"), '{"name":"@paperclipai/paperclip-runner"}');
    environment("PAPERCLIP_ACPX_PROVIDER_PACKAGE_ROOT", root);
    environment("PAPERCLIP_ACPX_PROVIDER_PACKAGE_MANIFEST", join(root, "package.json"));
    await expect(verifyKimiInstallation(QUALIFIED_ACPX_PROFILES.kimi)).rejects.toThrow(/paperclipai runtime setup kimi/);
    const assets = join(root, "provider-assets/kimi", `${process.platform}-${process.arch}`);
    await mkdir(join(assets, "runtime"), { recursive: true });
    await writeFile(join(assets, "kimi-distribution.json"), JSON.stringify({ schema: "paperclip.kimi-distribution.v1", nativeClosureSha256: "f".repeat(64) }));
    await expect(verifyKimiInstallation(QUALIFIED_ACPX_PROFILES.kimi)).rejects.toThrow(/source-owned pin/);
  });
});
