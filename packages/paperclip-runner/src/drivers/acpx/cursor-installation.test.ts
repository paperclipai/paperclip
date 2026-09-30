import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { CURSOR_PINNED_VERSION, cursorNativeDistributionSpec, verifyCursorInstallation } from "./cursor-installation.js";
import { QUALIFIED_ACPX_PROFILES } from "./qualified-profiles.js";

it("matches build materializer pins and launches only package-owned complete distributions", async () => {
  const manifest = JSON.parse(await readFile(new URL("../../../cursor-distributions.json", import.meta.url), "utf8"));
  expect(manifest.version).toBe(CURSOR_PINNED_VERSION);
  for (const [platform, architecture] of [["darwin", "arm64"], ["darwin", "x64"], ["linux", "x64"]] as const) {
    const spec = cursorNativeDistributionSpec(platform, architecture);
    expect(spec.expectedClosureSha256).toBe(manifest.platforms[`${platform}-${architecture}`].closureSha256);
    expect(spec.distributionRoot).toBe(new URL(`../../../provider-assets/cursor/${platform}-${architecture}`, import.meta.url).pathname);
    expect(spec.manifestPath).toBe(join(spec.distributionRoot, ".paperclip-cursor-closure.json"));
    expect(spec.executable).toBe("node");
    expect(spec.entrypoint).toBe("index.js");
    expect(spec.fixedArguments).toEqual(["--disable-project-configs", "--disable-auto-update", "acp"]);
    (spec.fixedArguments as string[]).push("--force");
    expect(cursorNativeDistributionSpec(platform, architecture).fixedArguments).not.toContain("--force");
  }
});

it("rejects profile substitutions before reading any native distribution", async () => {
  const base = { ...QUALIFIED_ACPX_PROFILES.cursor, qualificationModel: "explicit", reportedModelId: "explicit" };
  for (const profile of [QUALIFIED_ACPX_PROFILES.cursor, { ...base, agentServerVersion: "latest" }, { ...base, commandDigest: "forged" }, { ...base, reportedModelId: "different" }, { ...base, agentProfileVersion: 7 as const }, { ...base, agentProfileVersion: 8 as const }]) {
    await expect(verifyCursorInstallation(profile)).rejects.toThrow("exact pinned profile");
  }
});

it("fails closed on unknown platforms instead of ambient executable discovery", () => {
  expect(() => cursorNativeDistributionSpec("linux", "arm64")).toThrow("no pinned distribution");
  expect(() => cursorNativeDistributionSpec("win32", "x64")).toThrow("no pinned distribution");
  expect(() => cursorNativeDistributionSpec("darwin", "../../workspace")).toThrow("no pinned distribution");
});
