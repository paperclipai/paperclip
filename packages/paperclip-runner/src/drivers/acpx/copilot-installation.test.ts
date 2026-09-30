import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { verifyNativeAcpxInstallation } from "./installation-integrity.js";
import { COPILOT_CLOSURE_SHA256, verifyCopilotInstallation } from "./copilot-installation.js";
import { COPILOT_LAUNCH_ARGUMENTS, COPILOT_SYSTEM_INSTRUCTION_DELIVERY } from "./copilot-profile.js";
import { QUALIFIED_ACPX_PROFILES } from "./qualified-profiles.js";

vi.mock("./installation-integrity.js", () => ({ verifyNativeAcpxInstallation: vi.fn() }));

describe("Copilot build-owned installation", () => {
  it("admits the current v6 declaration and binds its source policy/patch hashes", () => {
    const identity = JSON.parse(readFileSync(new URL("../../../test/fixtures/copilot-profile-v6-identity.json", import.meta.url), "utf8"));
    expect(identity.declaration.systemInstructionDelivery).toBe(COPILOT_SYSTEM_INSTRUCTION_DELIVERY);
    expect(identity.declaration.sharedRuntimeContract).toBe("paperclip.acpx-runtime-contract.v1");
    expect(QUALIFIED_ACPX_PROFILES.copilot.agentProfileVersion).toBe(identity.declaration.agentProfileVersion);
    expect(QUALIFIED_ACPX_PROFILES.copilot.commandDigest).toBe(identity.commandDigest);
    const sorted = Object.fromEntries(Object.entries(identity.declaration).sort(([a], [b]) => a.localeCompare(b)));
    expect(`sha256:${createHash("sha256").update(JSON.stringify(sorted)).digest("hex")}`).toBe(identity.commandDigest);
    for (const [relative, field] of [["copilot-policy.ts", "policySha256"], ["../../../scripts/materialize-copilot-binary.mjs", "distributionSourceSha256"], ["../../../../../patches/acpx@0.13.1.patch", "acpxPatchSha256"]]) {
      expect(createHash("sha256").update(readFileSync(new URL(relative!, import.meta.url))).digest("hex")).toBe(identity.declaration[field!]);
    }
    expect(readFileSync(new URL("../../../scripts/build-copilot-distribution.mjs", import.meta.url), "utf8")).toContain(identity.commandDigest);
  });
  it("pins the materializer's complete executable closure on every target platform", () => {
    const script = readFileSync(new URL("../../../scripts/materialize-copilot-binary.mjs", import.meta.url), "utf8");
    const records = [...script.matchAll(/"(darwin-arm64|darwin-x64|linux-x64)": Object\.freeze\(\{ packageName: "[^"]+", executableDigest: "([a-f0-9]+)", size: (\d+)/g)];
    expect(records).toHaveLength(3);
    for (const [, platform, sha256, size] of records) {
      const digest = createHash("sha256").update(JSON.stringify([{ path: "copilot", sha256, size: Number(size), executable: true }])).digest("hex");
      expect(COPILOT_CLOSURE_SHA256[platform as keyof typeof COPILOT_CLOSURE_SHA256]).toBe(digest);
    }
  });
  it("ignores ambient executable selection and supplies only pinned native launch inputs", async () => {
    const openCommand = vi.fn();
    vi.mocked(verifyNativeAcpxInstallation).mockResolvedValueOnce({ commandDigest: "sha256:closure", agentServerPackageJsonPath: "/verified/closure.json", agentRuntimePackageJsonPath: null, openCommand });
    const before = process.env.COPILOT_PATH;
    process.env.COPILOT_PATH = "/untrusted/copilot";
    try {
      const result = await verifyCopilotInstallation(QUALIFIED_ACPX_PROFILES.copilot);
      const root = fileURLToPath(new URL(`../../../provider-assets/copilot/${process.platform}-${process.arch}`, import.meta.url));
      expect(verifyNativeAcpxInstallation).toHaveBeenCalledWith({
        distributionRoot: root, manifestPath: `${root}/.paperclip-copilot-closure.json`,
        expectedClosureSha256: COPILOT_CLOSURE_SHA256[`${process.platform}-${process.arch}` as keyof typeof COPILOT_CLOSURE_SHA256],
        executable: "copilot", fixedArguments: COPILOT_LAUNCH_ARGUMENTS, isolatedCacheEnvironmentName: "COPILOT_PKG_CACHE_HOME",
      });
      expect(result.commandDigest).toBe(QUALIFIED_ACPX_PROFILES.copilot.commandDigest);
      expect(result.openCommand).toBe(openCommand);
    } finally { if (before === undefined) delete process.env.COPILOT_PATH; else process.env.COPILOT_PATH = before; }
  });
  it("rejects changed profile identities before native file access", async () => {
    vi.mocked(verifyNativeAcpxInstallation).mockClear();
    for (const override of [{ agentServerVersion: "latest" }, { commandDigest: "sha256:untrusted" }, { agent: "cursor" }, { agentProfileVersion: 1 }, { agentProfileVersion: 2 }, { agentProfileVersion: 3 }, { agentProfileVersion: 4 }, { agentProfileVersion: 5 }, { agentProfileVersion: 7 }]) {
      await expect(verifyCopilotInstallation({ ...QUALIFIED_ACPX_PROFILES.copilot, ...override } as never)).rejects.toThrow("exact pinned");
    }
    expect(verifyNativeAcpxInstallation).not.toHaveBeenCalled();
  });
});
