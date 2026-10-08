import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { build } from "esbuild";
import { verifyNativeAcpxInstallation } from "./installation-integrity.js";
import { COPILOT_CLOSURE_SHA256, verifyCopilotInstallation } from "./copilot-installation.js";
import { COPILOT_LAUNCH_ARGUMENTS, COPILOT_SYSTEM_INSTRUCTION_DELIVERY } from "./copilot-profile.js";
import { COPILOT_PERMISSION_CONTEXT_CONTRACT } from "./copilot-permission-context.js";
import { QUALIFIED_ACPX_PROFILES } from "./qualified-profiles.js";

const PERMISSION_POLICY_SOURCES = [
  ["copilot-permission-context.ts", "permissionContextSourceSha256"],
  ["acp-permission-adapter.ts", "permissionAdapterSourceSha256"],
  ["cursor-plan-tool-identity.ts", "permissionToolIdentitySourceSha256"],
  ["safe-locations.ts", "permissionLocationsSourceSha256"],
  ["../../semantic-tools/redaction.ts", "permissionRedactionSourceSha256"],
  ["generated-sidecar-contract.ts", "permissionClassifierSourceSha256"],
] as const;

const COPILOT_DISPLAY_SOURCES = [
  ["copilot-events.ts", "displayEventSourceSha256"],
  ["copilot-extension-adapter.ts", "displayProjectionSourceSha256"],
] as const;

const SEMANTIC_RECEIPT_SOURCES = [
  ["../semantic-tool-receipt.ts", "semanticReceiptSourceSha256"],
  ["../runner-tool-bridge.ts", "semanticBridgeSourceSha256"],
  ["copilot-tool-evidence.ts", "toolEvidenceSourceSha256"],
  ["../../cli/acpx-runtime-sidecar.ts", "semanticSidecarSourceSha256"],
  ["sidecar-protocol.ts", "semanticSidecarProtocolSourceSha256"],
  ["codex-acpx-driver.ts", "semanticDirectDriverSourceSha256"],
  ["../../protocol/replay-contract.ts", "semanticValidationSourceSha256"],
  ["../../protocol/result-normalization.ts", "semanticNormalizationSourceSha256"],
  ["../../contracts/completion-result.ts", "semanticCompletionContractSourceSha256"],
  ["../../contracts/native-execution.ts", "nativeExecutionSourceSha256"],
  ["installation-integrity.ts", "guardedInstallationSourceSha256"],
  ["../../live/runnerd-codex-transport.ts", "runtimeRequestBridgeSourceSha256"],
  ["../codex/codex-session-notifications.ts", "runtimeRequestFacadeSourceSha256"],
  ["../codex/codex-thread-normalization.ts", "runtimeRequestNotificationSourceSha256"],
  ["../../protocol/generated/standalone-validators.ts", "semanticValidatorsSourceSha256"],
  ["../../protocol/generated/schema-bundle.ts", "semanticSchemaBundleSourceSha256"],
] as const;

// Walk executable imports, not just the projector's immediate dependencies.
async function permissionPolicyClosure(extraClassifierImport = false): Promise<Set<string>> {
  const root = fileURLToPath(new URL(".", import.meta.url));
  const result = await build({
    absWorkingDir: root,
    entryPoints: ["acp-permission-adapter.ts"],
    bundle: true, write: false, metafile: true, platform: "node", treeShaking: false,
    plugins: extraClassifierImport ? [{
      name: "unbound-transitive-policy-negative-control",
      setup(builder) {
        builder.onResolve({ filter: /^unbound-policy$/ }, () => ({ path: "unbound-policy", namespace: "negative-control" }));
        builder.onLoad({ filter: /.*/, namespace: "negative-control" }, () => ({ contents: "export const policy = true;", loader: "ts" }));
        builder.onLoad({ filter: /generated-sidecar-contract\.ts$/ }, args => ({
          contents: readFileSync(args.path, "utf8") + '\nimport "unbound-policy";',
          loader: "ts", resolveDir: root,
        }));
      },
    }] : [],
  });
  return new Set(Object.keys(result.metafile!.inputs).map(path => path.startsWith("negative-control:")
    ? path : pathToFileURL(resolve(root, path)).href));
}

vi.mock("./installation-integrity.js", () => ({ verifyNativeAcpxInstallation: vi.fn() }));

describe("Copilot build-owned installation", () => {
  it("admits the current declaration and binds its source policy, receipts and patch hashes", () => {
    const identity = JSON.parse(readFileSync(new URL("../../../test/fixtures/copilot-profile-v33-identity.json", import.meta.url), "utf8"));
    expect(identity.declaration.systemInstructionDelivery).toBe(COPILOT_SYSTEM_INSTRUCTION_DELIVERY);
    expect(identity.declaration.sharedRuntimeContract).toBe("paperclip.acpx-runtime-contract.v1");
    expect(identity.declaration.permissionContextContract).toBe(COPILOT_PERMISSION_CONTEXT_CONTRACT);
    expect(identity.declaration.semanticToolReceiptContract).toBe("paperclip.semantic_tool_receipt.v2");
    expect(identity.declaration.semanticNormalizedInputContract).toBe("validated-forwarded-input-commit-v1");
    expect(identity.declaration.semanticSidecarReceiptCommitContract).toBe("correlated-tool-resolve-v1");
    expect(identity.declaration.messageIdentityContract).toBe("copilot-native-message-id-v1");
    expect(identity.declaration.ownedDistributionDelivery).toBe("COPILOT_CLI_DIST_DIR:lease-owned-guarded-inner-distribution:v1");
    const inventory = JSON.parse(readFileSync(new URL("../../../test/fixtures/copilot-message-identity-distributions-1.0.88.json", import.meta.url), "utf8"));
    expect(identity.declaration.upstreamAppSha256).toBe(inventory.upstreamAppSha256);
    expect(identity.declaration.patchedAppSha256).toBe(inventory.patchedAppSha256);
    expect(QUALIFIED_ACPX_PROFILES.copilot.agentProfileVersion).toBe(identity.declaration.agentProfileVersion);
    expect(QUALIFIED_ACPX_PROFILES.copilot.commandDigest).toBe(identity.commandDigest);
    const sorted = Object.fromEntries(Object.entries(identity.declaration).sort(([a], [b]) => a.localeCompare(b)));
    expect(`sha256:${createHash("sha256").update(JSON.stringify(sorted)).digest("hex")}`).toBe(identity.commandDigest);
    for (const [relative, field] of [...PERMISSION_POLICY_SOURCES, ...COPILOT_DISPLAY_SOURCES, ...SEMANTIC_RECEIPT_SOURCES, ["copilot-policy.ts", "policySha256"], ["profile-compatibility.ts", "profileCompatibilitySourceSha256"], ["provider-assets-root.ts", "assetOwnershipSourceSha256"], ["../../../scripts/install-copilot-assets.mjs", "assetInstallerSourceSha256"], ["../../../scripts/materialize-copilot-binary.mjs", "distributionSourceSha256"], ["../../../scripts/copilot-inner-distribution.mjs", "innerDistributionSourceSha256"], ["../../../../../patches/acpx@0.13.1.patch", "acpxPatchSha256"]]) {
      expect(createHash("sha256").update(readFileSync(new URL(relative!, import.meta.url))).digest("hex")).toBe(identity.declaration[field!]);
    }
    expect(readFileSync(new URL("../../../scripts/build-copilot-distribution.mjs", import.meta.url), "utf8")).toContain(identity.commandDigest);
    expect(readFileSync(new URL("../../../runner/crates/runner-core/src/generated_acpx_profiles.rs", import.meta.url), "utf8")).toContain(identity.commandDigest);
  });
  it("binds the complete executable permission-policy import closure", async () => {
    expect(await permissionPolicyClosure()).toEqual(new Set(PERMISSION_POLICY_SOURCES.map(([path]) => new URL(path, import.meta.url).href)));
  });
  it("detects an added transitive dependency even when the projector is unchanged", async () => {
    const closure = await permissionPolicyClosure(true);
    const bound = new Set(PERMISSION_POLICY_SOURCES.map(([path]) => new URL(path, import.meta.url).href));
    expect([...closure].filter(path => !bound.has(path))).toEqual(["negative-control:unbound-policy"]);
  });
  it.each([...PERMISSION_POLICY_SOURCES, ...COPILOT_DISPLAY_SOURCES, ...SEMANTIC_RECEIPT_SOURCES])("changing %s changes the candidate identity", (_path, field) => {
    const identity = JSON.parse(readFileSync(new URL("../../../test/fixtures/copilot-profile-v33-identity.json", import.meta.url), "utf8"));
    identity.declaration[field] = "0".repeat(64);
    const sorted = Object.fromEntries(Object.entries(identity.declaration).sort(([a], [b]) => a.localeCompare(b)));
    expect(`sha256:${createHash("sha256").update(JSON.stringify(sorted)).digest("hex")}`).not.toBe(identity.commandDigest);
  });
  it("pins the unchanged executable plus complete patched distribution on every target platform", () => {
    const fixture = JSON.parse(readFileSync(new URL("../../../test/fixtures/copilot-message-identity-distributions-1.0.88.json", import.meta.url), "utf8"));
    const script = readFileSync(new URL("../../../scripts/materialize-copilot-binary.mjs", import.meta.url), "utf8");
    const records = [...script.matchAll(/"(darwin-arm64|darwin-x64|linux-x64)": Object\.freeze\(\{ packageName: "[^"]+", executableDigest: "([a-f0-9]+)", size: (\d+)/g)];
    expect(records).toHaveLength(3);
    for (const [, platform, sha256, size] of records) {
      const platformFixture = fixture.platforms[platform!];
      expect(platformFixture.executableSha256).toBe(sha256);
      expect(platformFixture.entries).toContainEqual({ path: "copilot", sha256, size: Number(size), executable: true });
      expect(platformFixture.entries.find((entry: { path: string }) => entry.path === "distribution/app.js").sha256).toBe(fixture.patchedAppSha256);
      expect(platformFixture.entries.some((entry: { path: string }) => entry.path === `distribution/prebuilds/${platform}/runtime.node`)).toBe(true);
      const digest = createHash("sha256").update(JSON.stringify(platformFixture.entries)).digest("hex");
      expect(platformFixture.closureSha256).toBe(digest);
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
        copilotDistributionDirectory: "distribution",
      });
      expect(result.commandDigest).toBe(QUALIFIED_ACPX_PROFILES.copilot.commandDigest);
      expect(result.openCommand).toBe(openCommand);
    } finally { if (before === undefined) delete process.env.COPILOT_PATH; else process.env.COPILOT_PATH = before; }
  });
  it("rejects changed profile identities before native file access", async () => {
    vi.mocked(verifyNativeAcpxInstallation).mockClear();
    for (const override of [{ agentServerVersion: "latest" }, { commandDigest: "sha256:untrusted" }, { commandDigest: "sha256:ed39259990cb0efda48d6105d2fa3599aac76873eb75cd80b4d0b179ce0579a6" }, { agent: "cursor" }, { agentProfileVersion: 1 }, { agentProfileVersion: 2 }, { agentProfileVersion: 3 }, { agentProfileVersion: 4 }, { agentProfileVersion: 5 }, { agentProfileVersion: 6 }, { agentProfileVersion: 7 }, { agentProfileVersion: 8 }, { agentProfileVersion: 9 }, { agentProfileVersion: 10 }]) {
      await expect(verifyCopilotInstallation({ ...QUALIFIED_ACPX_PROFILES.copilot, ...override } as never)).rejects.toThrow("exact pinned");
    }
    expect(verifyNativeAcpxInstallation).not.toHaveBeenCalled();
  });
});
