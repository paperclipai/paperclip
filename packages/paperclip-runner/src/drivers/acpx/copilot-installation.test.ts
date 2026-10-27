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
import { isSupportedAcpxProfileVersion } from "./profile-compatibility.js";

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
  ["../completion-continuation.ts", "semanticContinuationSourceSha256"],
  ["../../protocol/replay-contract.ts", "semanticValidationSourceSha256"],
  ["../../protocol/result-normalization.ts", "semanticNormalizationSourceSha256"],
  ["../../contracts/completion-result.ts", "semanticCompletionContractSourceSha256"],
  ["../../contracts/native-execution.ts", "nativeExecutionSourceSha256"],
  ["installation-integrity.ts", "guardedInstallationSourceSha256"],
  ["../../live/runner-provider-launch.ts", "providerLaunchSourceSha256"],
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

async function withCopilotTestPlatform<T>(arch: "x64" | "arm64", run: () => Promise<T>): Promise<T> {
  const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");
  const archDescriptor = Object.getOwnPropertyDescriptor(process, "arch");
  if (!platformDescriptor || !archDescriptor) throw new Error("Missing process platform descriptors");
  try {
    Object.defineProperty(process, "platform", { ...platformDescriptor, value: "linux" });
    Object.defineProperty(process, "arch", { ...archDescriptor, value: arch });
    return await run();
  } finally {
    try { Object.defineProperty(process, "platform", platformDescriptor); }
    finally { Object.defineProperty(process, "arch", archDescriptor); }
  }
}

vi.mock("./installation-integrity.js", () => ({ verifyNativeAcpxInstallation: vi.fn() }));

describe("Copilot build-owned installation", () => {
  it("admits the current profile with environment launch preparation", () => {
    expect(QUALIFIED_ACPX_PROFILES.copilot.agentProfileVersion).toBe(69);
    expect(QUALIFIED_ACPX_PROFILES.copilot.qualificationStatus).toBeUndefined();
    expect(QUALIFIED_ACPX_PROFILES.copilot.commandDigest).toBe("sha256:5444547ca83543bc899ae5a8a2e895c19a86559339e60a1970786ce900742719");
  });

  it("preserves published and candidate history while binding native Grok admission in v69", async () => {
    const published = readFileSync(new URL("../../../test/fixtures/copilot-profile-v68-identity.json", import.meta.url));
    const candidate = readFileSync(new URL("../../../test/fixtures/copilot-profile-v67-grok-native-effort-candidate-historical-identity.json", import.meta.url));
    expect(createHash("sha256").update(published).digest("hex")).toBe("9692e8de4e75682c74f8e635e26b8de1f03f1d3e41966dafbb7314d35b75c3cf");
    expect(createHash("sha256").update(candidate).digest("hex")).toBe("0a20ffe33c92d86f58013582b19c2371f96d93e7e4e0e8096fbf0e7236bd02f4");
    const prior = JSON.parse(published.toString("utf8"));
    const current = JSON.parse(readFileSync(new URL("../../../test/fixtures/copilot-profile-v69-identity.json", import.meta.url), "utf8"));
    expect(Object.keys(current.declaration).filter(key => current.declaration[key] !== prior.declaration[key]).sort()).toEqual([
      "agentProfileVersion", "profileCompatibilitySourceSha256", "runtimeAdapterSourceSha256",
    ]);
    expect(Object.keys(current.declaration).sort()).toEqual(Object.keys(prior.declaration).sort());
    for (const history of [prior, JSON.parse(candidate.toString("utf8"))]) {
      expect(isSupportedAcpxProfileVersion("copilot", history.declaration.agentProfileVersion)).toBe(true);
      await expect(verifyCopilotInstallation({ ...QUALIFIED_ACPX_PROFILES.copilot,
        agentProfileVersion: history.declaration.agentProfileVersion, commandDigest: history.commandDigest })).rejects.toThrow("exact pinned");
    }
  });

  it("preserves both lineages while binding the merged implementation in v68", async () => {
    const published = readFileSync(new URL("../../../test/fixtures/copilot-profile-v66-identity.json", import.meta.url));
    const candidate = readFileSync(new URL("../../../test/fixtures/copilot-profile-v67-identity.json", import.meta.url));
    expect(createHash("sha256").update(published).digest("hex")).toBe("9eb0bfd31334210fd41ddb677a165ef7432a2951922e642dddff087e4db8b6bc");
    expect(createHash("sha256").update(candidate).digest("hex")).toBe("6c818541933b97bea896ca29179ad54c887db9b7d563021da1676a8126f960dd");
    const prior = JSON.parse(published.toString("utf8"));
    const current = JSON.parse(readFileSync(new URL("../../../test/fixtures/copilot-profile-v68-identity.json", import.meta.url), "utf8"));
    expect(Object.keys(current.declaration).filter(key => current.declaration[key] !== prior.declaration[key]).sort()).toEqual([
      "agentProfileVersion", "profileCompatibilitySourceSha256", "providerLaunchSourceSha256", "runtimeRequestBridgeSourceSha256",
    ]);
    for (const history of [prior, JSON.parse(candidate.toString("utf8"))]) {
      expect(isSupportedAcpxProfileVersion("copilot", history.declaration.agentProfileVersion)).toBe(true);
      await expect(verifyCopilotInstallation({ ...QUALIFIED_ACPX_PROFILES.copilot,
        agentProfileVersion: history.declaration.agentProfileVersion, commandDigest: history.commandDigest })).rejects.toThrow("exact pinned");
    }
  });

  it("preserves published v65 while binding hot-upgrade adoption in v67", async () => {
    const bytes = readFileSync(new URL("../../../test/fixtures/copilot-profile-v65-identity.json", import.meta.url));
    expect(createHash("sha256").update(bytes).digest("hex")).toBe("ca1d95c21b3f49c99b6d7c6bd3c2bf149715db3263927ad653cc0c6f33fb4462");
    const prior = JSON.parse(bytes.toString("utf8"));
    const current = JSON.parse(readFileSync(new URL("../../../test/fixtures/copilot-profile-v67-identity.json", import.meta.url), "utf8"));
    expect(Object.keys(current.declaration).filter(key => current.declaration[key] !== prior.declaration[key]).sort()).toEqual([
      "agentProfileVersion", "profileCompatibilitySourceSha256", "providerLaunchSourceSha256", "runtimeRequestBridgeSourceSha256",
    ]);
    expect(Object.keys(current.declaration).sort()).toEqual(Object.keys(prior.declaration).sort());
    expect(isSupportedAcpxProfileVersion("copilot", 65)).toBe(true);
    await expect(verifyCopilotInstallation({ ...QUALIFIED_ACPX_PROFILES.copilot,
      agentProfileVersion: 65, commandDigest: prior.commandDigest })).rejects.toThrow("exact pinned");
  });

  it("retains candidate v66 identity when completion recovery changes in v67", async () => {
    const bytes = readFileSync(new URL("../../../test/fixtures/copilot-profile-v66-hot-upgrade-candidate-historical-identity.json", import.meta.url));
    expect(createHash("sha256").update(bytes).digest("hex")).toBe("430f7a3bb4f51a22d6f18a515fb32eb4defa5bab60a6a4901f6750e59f2536c6");
    const prior = JSON.parse(bytes.toString("utf8"));
    const current = JSON.parse(readFileSync(new URL("../../../test/fixtures/copilot-profile-v67-identity.json", import.meta.url), "utf8"));
    expect(Object.keys(current.declaration).filter(key => current.declaration[key] !== prior.declaration[key]).sort()).toEqual([
      "agentProfileVersion", "profileCompatibilitySourceSha256", "runtimeRequestBridgeSourceSha256",
    ]);
    expect(isSupportedAcpxProfileVersion("copilot", 66)).toBe(true);
    await expect(verifyCopilotInstallation({ ...QUALIFIED_ACPX_PROFILES.copilot,
      agentProfileVersion: 66, commandDigest: prior.commandDigest })).rejects.toThrow("exact pinned");
  });

  it("retains the hot-upgrade v59 development identity without replacing published history", async () => {
    const bytes = readFileSync(new URL("../../../test/fixtures/copilot-profile-v59-hot-upgrade-candidate-historical-identity.json", import.meta.url));
    expect(createHash("sha256").update(bytes).digest("hex")).toBe("b61fe644383acbbaacd209836878243cb96b143807d90c521ef1fbee2a2fcb0c");
    const prior = JSON.parse(bytes.toString("utf8"));
    const sorted = Object.fromEntries(Object.entries(prior.declaration).sort(([a], [b]) => a.localeCompare(b)));
    expect(`sha256:${createHash("sha256").update(JSON.stringify(sorted)).digest("hex")}`).toBe(prior.commandDigest);
    expect(isSupportedAcpxProfileVersion("copilot", 59)).toBe(true);
    await expect(verifyCopilotInstallation({ ...QUALIFIED_ACPX_PROFILES.copilot,
      agentProfileVersion: 59, commandDigest: prior.commandDigest })).rejects.toThrow("exact pinned");
  });

  it("retains v65 history while binding the shared native Grok effort transport in v66", async () => {
    const prior = JSON.parse(readFileSync(new URL("../../../test/fixtures/copilot-profile-v65-identity.json", import.meta.url), "utf8"));
    const current = JSON.parse(readFileSync(new URL("../../../test/fixtures/copilot-profile-v66-identity.json", import.meta.url), "utf8"));
    expect(Object.keys(current.declaration).filter(key => current.declaration[key] !== prior.declaration[key]).sort()).toEqual([
      "agentProfileVersion", "harnessSessionContractSourceSha256", "nativeBackendSourceSha256", "nativeExecutionSourceSha256",
      "nativeInstructionsSourceSha256", "profileCompatibilitySourceSha256", "providerLaunchSourceSha256", "runtimeAdapterSourceSha256",
      "runtimeHostSourceSha256", "runtimeRequestBridgeSourceSha256", "runtimeSandboxSourceSha256", "semanticDirectDriverSourceSha256", "semanticSchemaBundleSourceSha256",
      "semanticSidecarProtocolSourceSha256", "semanticSidecarSourceSha256",
    ]);
    expect(isSupportedAcpxProfileVersion("copilot", 65)).toBe(true);
    await expect(verifyCopilotInstallation({ ...QUALIFIED_ACPX_PROFILES.copilot,
      agentProfileVersion: 65, commandDigest: prior.commandDigest })).rejects.toThrow("exact pinned");
  });

  it("preserves published v64 while binding exhausted reconnect cancellation in v65", async () => {
    const priorBytes = readFileSync(new URL("../../../test/fixtures/copilot-profile-v64-identity.json", import.meta.url));
    expect(createHash("sha256").update(priorBytes).digest("hex")).toBe("9ee015b4968d8df8d38364626d413f69f6c0e846de20fe1d5f72c7f1706837a9");
    const prior = JSON.parse(priorBytes.toString("utf8"));
    const current = JSON.parse(readFileSync(new URL("../../../test/fixtures/copilot-profile-v65-identity.json", import.meta.url), "utf8"));
    expect(Object.keys(current.declaration).filter(key => current.declaration[key] !== prior.declaration[key]).sort()).toEqual([
      "agentProfileVersion", "profileCompatibilitySourceSha256", "runtimeRequestBridgeSourceSha256",
    ]);
    expect(Object.keys(current.declaration).sort()).toEqual(Object.keys(prior.declaration).sort());
    expect(isSupportedAcpxProfileVersion("copilot", 64)).toBe(true);
    await expect(verifyCopilotInstallation({ ...QUALIFIED_ACPX_PROFILES.copilot,
      agentProfileVersion: 64, commandDigest: prior.commandDigest })).rejects.toThrow("exact pinned");
  });

  it("preserves the published startup cancellation candidate as historical v63 evidence", async () => {
    const bytes = readFileSync(new URL("../../../test/fixtures/copilot-profile-v63-reconnect-candidate-historical-identity.json", import.meta.url));
    expect(createHash("sha256").update(bytes).digest("hex")).toBe("1ed0ac81863a588f3a2ff997b0e3f3bf0b64440454eb19282bdcd05d35650207");
    const candidate = JSON.parse(bytes.toString("utf8"));
    const prior = JSON.parse(readFileSync(new URL("../../../test/fixtures/copilot-profile-v62-identity.json", import.meta.url), "utf8"));
    expect(Object.keys(candidate.declaration).filter(key => candidate.declaration[key] !== prior.declaration[key]).sort()).toEqual([
      "agentProfileVersion", "profileCompatibilitySourceSha256", "runtimeRequestBridgeSourceSha256",
    ]);
    const sorted = Object.fromEntries(Object.entries(candidate.declaration).sort(([a], [b]) => a.localeCompare(b)));
    expect(`sha256:${createHash("sha256").update(JSON.stringify(sorted)).digest("hex")}`).toBe(candidate.commandDigest);
    expect(isSupportedAcpxProfileVersion("copilot", 63)).toBe(true);
    await expect(verifyCopilotInstallation({ ...QUALIFIED_ACPX_PROFILES.copilot,
      agentProfileVersion: 63, commandDigest: candidate.commandDigest })).rejects.toThrow("exact pinned");
  });

  it("preserves published v63 while binding delegated connection guidance in v64", async () => {
    const priorBytes = readFileSync(new URL("../../../test/fixtures/copilot-profile-v63-identity.json", import.meta.url));
    expect(createHash("sha256").update(priorBytes).digest("hex")).toBe("4adb05bd642f0222a3bcc85cfefbeb2988de439f58125012e1c575caedd90798");
    const prior = JSON.parse(priorBytes.toString("utf8"));
    const current = JSON.parse(readFileSync(new URL("../../../test/fixtures/copilot-profile-v64-identity.json", import.meta.url), "utf8"));
    expect(prior.commandDigest).toBe("sha256:1412842a36a7211d84b6b98a3d1f69e3388bc4814e5825da890a774ae0e3460e");
    expect(Object.keys(current.declaration).filter(key => current.declaration[key] !== prior.declaration[key]).sort()).toEqual([
      "agentProfileVersion", "nativeRuntimePromptsSourceSha256", "profileCompatibilitySourceSha256",
    ]);
    expect(Object.keys(current.declaration).sort()).toEqual(Object.keys(prior.declaration).sort());
    expect(isSupportedAcpxProfileVersion("copilot", 63)).toBe(true);
    await expect(verifyCopilotInstallation({ ...QUALIFIED_ACPX_PROFILES.copilot,
      agentProfileVersion: 63, commandDigest: prior.commandDigest })).rejects.toThrow("exact pinned");
  });

  it("preserves both published v62 identities while binding their merged source in v63", async () => {
    const current = JSON.parse(readFileSync(new URL("../../../test/fixtures/copilot-profile-v63-identity.json", import.meta.url), "utf8"));
    for (const [name, checksum, changed] of [
      ["copilot-profile-v62-identity.json", "faa4d1b35267b54e134a8e0c84586fe1196d8fad5525cb53aa195aae53ca6e83", ["agentProfileVersion", "profileCompatibilitySourceSha256", "semanticCompletionContractSourceSha256", "semanticContinuationSourceSha256"]],
      ["copilot-profile-v62-candidate-historical-identity.json", "da3f44a3cfda31cbff558d618e1e9cb1cfb80379b613ff1266e8b866ea666df8", ["agentProfileVersion", "profileCompatibilitySourceSha256", "runtimeRequestBridgeSourceSha256"]],
    ] as const) {
      const bytes = readFileSync(new URL(`../../../test/fixtures/${name}`, import.meta.url));
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(checksum);
      const prior = JSON.parse(bytes.toString("utf8"));
      expect(Object.keys(current.declaration).filter(key => current.declaration[key] !== prior.declaration[key]).sort()).toEqual(changed);
      expect(Object.keys(current.declaration).sort()).toEqual(Object.keys(prior.declaration).sort());
      const sorted = Object.fromEntries(Object.entries(prior.declaration).sort(([a], [b]) => a.localeCompare(b)));
      expect(`sha256:${createHash("sha256").update(JSON.stringify(sorted)).digest("hex")}`).toBe(prior.commandDigest);
      expect(isSupportedAcpxProfileVersion("copilot", 62)).toBe(true);
      await expect(verifyCopilotInstallation({ ...QUALIFIED_ACPX_PROFILES.copilot,
        agentProfileVersion: 62, commandDigest: prior.commandDigest })).rejects.toThrow("exact pinned");
    }
  });

  it("preserves v61 while binding uncertain process checks and controller retirement in v62", async () => {
    const priorBytes = readFileSync(new URL("../../../test/fixtures/copilot-profile-v61-identity.json", import.meta.url));
    expect(createHash("sha256").update(priorBytes).digest("hex")).toBe("ec3c8561bc123a599a01da356978b73e6d48ab030842af9f0d63d1f30413e1a5");
    const prior = JSON.parse(priorBytes.toString("utf8"));
    const current = JSON.parse(readFileSync(new URL("../../../test/fixtures/copilot-profile-v62-identity.json", import.meta.url), "utf8"));
    expect(prior.commandDigest).toBe("sha256:956276ebee59f880249fa6955adc224af9ca7b6a9da59bcc5da4a8667550c5b3");
    expect(Object.keys(current.declaration).filter(key => current.declaration[key] !== prior.declaration[key]).sort()).toEqual([
      "agentProfileVersion", "profileCompatibilitySourceSha256", "runtimeRequestBridgeSourceSha256",
    ]);
    expect(Object.keys(current.declaration).sort()).toEqual(Object.keys(prior.declaration).sort());
    expect(isSupportedAcpxProfileVersion("copilot", 61)).toBe(true);
    await expect(verifyCopilotInstallation({ ...QUALIFIED_ACPX_PROFILES.copilot,
      agentProfileVersion: 61, commandDigest: prior.commandDigest })).rejects.toThrow("exact pinned");
  });

  it("preserves v60 while binding controller journal retirement in v61", async () => {
    const priorBytes = readFileSync(new URL("../../../test/fixtures/copilot-profile-v60-identity.json", import.meta.url));
    expect(createHash("sha256").update(priorBytes).digest("hex")).toBe("e3c45b0311517d05f06ed10f357db713ae157cfa87e4a8becf087c5b6dfa7003");
    const prior = JSON.parse(priorBytes.toString("utf8"));
    const current = JSON.parse(readFileSync(new URL("../../../test/fixtures/copilot-profile-v61-identity.json", import.meta.url), "utf8"));
    expect(Object.keys(current.declaration).filter(key => current.declaration[key] !== prior.declaration[key]).sort()).toEqual([
      "agentProfileVersion", "profileCompatibilitySourceSha256", "runtimeRequestBridgeSourceSha256",
    ]);
    expect(Object.keys(current.declaration).sort()).toEqual(Object.keys(prior.declaration).sort());
    expect(isSupportedAcpxProfileVersion("copilot", 60)).toBe(true);
    expect(current.commandDigest).not.toBe(prior.commandDigest);
    await expect(verifyCopilotInstallation({ ...QUALIFIED_ACPX_PROFILES.copilot,
      agentProfileVersion: 60, commandDigest: prior.commandDigest })).rejects.toThrow("exact pinned");
  });

  it("preserves v59 while binding the Codex-only hosted search restriction in v60", async () => {
    const priorBytes = readFileSync(new URL("../../../test/fixtures/copilot-profile-v59-identity.json", import.meta.url));
    expect(createHash("sha256").update(priorBytes).digest("hex")).toBe("a9116d0981cb0feebec31f61cd23d16b3a263fe6a797b1ba1436c6e41198538c");
    const prior = JSON.parse(priorBytes.toString("utf8"));
    const current = JSON.parse(readFileSync(new URL("../../../test/fixtures/copilot-profile-v60-identity.json", import.meta.url), "utf8"));
    expect(Object.keys(current.declaration).filter(key => current.declaration[key] !== prior.declaration[key]).sort()).toEqual([
      "agentProfileVersion", "nativeBackendSourceSha256", "nativeExecutionSourceSha256", "profileCompatibilitySourceSha256", "providerLaunchSourceSha256", "runtimeRequestBridgeSourceSha256",
    ]);
    expect(Object.keys(current.declaration).sort()).toEqual(Object.keys(prior.declaration).sort());
    expect(isSupportedAcpxProfileVersion("copilot", 59)).toBe(true);
    expect(current.commandDigest).not.toBe(prior.commandDigest);
    await expect(verifyCopilotInstallation({ ...QUALIFIED_ACPX_PROFILES.copilot,
      agentProfileVersion: 59, commandDigest: prior.commandDigest })).rejects.toThrow("exact pinned");
  });

  it("preserves v58 while binding the separate remote process reconnect policy in v59", () => {
    const prior = JSON.parse(readFileSync(new URL("../../../test/fixtures/copilot-profile-v58-identity.json", import.meta.url), "utf8"));
    const current = JSON.parse(readFileSync(new URL("../../../test/fixtures/copilot-profile-v59-identity.json", import.meta.url), "utf8"));
    expect(Object.keys(current.declaration).filter(key => current.declaration[key] !== prior.declaration[key]).sort()).toEqual([
      "agentProfileVersion", "credentialBindingSourceSha256", "nativeInstructionsSourceSha256", "nativeSessionRuntimeSourceSha256", "profileCompatibilitySourceSha256", "runtimeRequestBridgeSourceSha256", "semanticBridgeSourceSha256", "semanticSidecarSourceSha256", "transportContractSourceSha256",
    ]);
    expect(isSupportedAcpxProfileVersion("copilot", 58)).toBe(true);
    expect(current.commandDigest).not.toBe(prior.commandDigest);
  });

  it("preserves v57 while binding the shared Pi setup and launch repairs in v58", () => {
    const prior = JSON.parse(readFileSync(new URL("../../../test/fixtures/copilot-profile-v57-identity.json", import.meta.url), "utf8"));
    const current = JSON.parse(readFileSync(new URL("../../../test/fixtures/copilot-profile-v58-identity.json", import.meta.url), "utf8"));
    expect(Object.keys(current.declaration).filter(key => current.declaration[key] !== prior.declaration[key]).sort()).toEqual([
      "agentProfileVersion", "guardedInstallationSourceSha256", "nativeBackendSourceSha256", "profileCompatibilitySourceSha256", "profileInstallationSourceSha256", "providerLaunchSourceSha256", "runtimeHostSourceSha256", "runtimeRequestBridgeSourceSha256", "semanticBridgeSourceSha256", "semanticSidecarSourceSha256",
    ]);
    expect(isSupportedAcpxProfileVersion("copilot", 57)).toBe(true);
    expect(current.commandDigest).not.toBe(prior.commandDigest);
  });

  it("preserves v56 while binding the extracted core prompts in v57", () => {
    const prior = JSON.parse(readFileSync(new URL("../../../test/fixtures/copilot-profile-v56-identity.json", import.meta.url), "utf8"));
    const current = JSON.parse(readFileSync(new URL("../../../test/fixtures/copilot-profile-v57-identity.json", import.meta.url), "utf8"));
    expect(Object.keys(current.declaration).filter(key => current.declaration[key] !== prior.declaration[key]).sort()).toEqual([
      "agentProfileVersion", "nativeRuntimeContextSourceSha256", "nativeRuntimePromptsSourceSha256", "profileCompatibilitySourceSha256",
    ]);
    expect(isSupportedAcpxProfileVersion("copilot", 56)).toBe(true);
    expect(current.commandDigest).not.toBe(prior.commandDigest);
  });

  it("preserves v55 while binding reusable case workflow guidance in v56", () => {
    const prior = JSON.parse(readFileSync(new URL("../../../test/fixtures/copilot-profile-v55-identity.json", import.meta.url), "utf8"));
    const current = JSON.parse(readFileSync(new URL("../../../test/fixtures/copilot-profile-v56-identity.json", import.meta.url), "utf8"));
    expect(Object.keys(current.declaration).filter(key => current.declaration[key] !== prior.declaration[key]).sort()).toEqual([
      "agentProfileVersion", "nativeRuntimeContextSourceSha256", "profileCompatibilitySourceSha256",
    ]);
    expect(isSupportedAcpxProfileVersion("copilot", 55)).toBe(true);
    expect(current.commandDigest).not.toBe(prior.commandDigest);
  });

  it("preserves v54 while binding current workspace continuation revalidation in v55", () => {
    const prior = JSON.parse(readFileSync(new URL("../../../test/fixtures/copilot-profile-v54-identity.json", import.meta.url), "utf8"));
    const current = JSON.parse(readFileSync(new URL("../../../test/fixtures/copilot-profile-v55-identity.json", import.meta.url), "utf8"));
    expect(prior.commandDigest).toBe("sha256:171d865b9b6ff2eda3926dc957caf2993cd7e1fa1b4359e8b60b83f589bd67fa");
    expect(Object.keys(current.declaration).filter(key => current.declaration[key] !== prior.declaration[key]).sort()).toEqual([
      "agentProfileVersion", "profileCompatibilitySourceSha256", "runtimeRequestBridgeSourceSha256",
      "semanticCompletionContractSourceSha256", "semanticContinuationSourceSha256",
    ]);
    expect(isSupportedAcpxProfileVersion("copilot", 54)).toBe(true);
    expect(current.commandDigest).not.toBe(prior.commandDigest);
  });

  it("preserves v53 while binding repository setup completion guidance in v54", () => {
    const prior = JSON.parse(readFileSync(new URL("../../../test/fixtures/copilot-profile-v53-identity.json", import.meta.url), "utf8"));
    const current = JSON.parse(readFileSync(new URL("../../../test/fixtures/copilot-profile-v54-identity.json", import.meta.url), "utf8"));
    expect(prior.commandDigest).toBe("sha256:6441ff7f3fc664064bff9e7ae80252ddec7a39236f9a4b9d402785eb8b03b2c9");
    expect(Object.keys(current.declaration).filter(key => current.declaration[key] !== prior.declaration[key]).sort()).toEqual([
      "agentProfileVersion", "profileCompatibilitySourceSha256", "semanticCompletionContractSourceSha256",
    ]);
    expect(isSupportedAcpxProfileVersion("copilot", 53)).toBe(true);
    expect(current.commandDigest).not.toBe(prior.commandDigest);
  });

  it("preserves v52 while binding the workspace continuation source in v53", () => {
    const prior = JSON.parse(readFileSync(new URL("../../../test/fixtures/copilot-profile-v52-identity.json", import.meta.url), "utf8"));
    const current = JSON.parse(readFileSync(new URL("../../../test/fixtures/copilot-profile-v53-identity.json", import.meta.url), "utf8"));
    expect(prior.commandDigest).toBe("sha256:3614db52d3ddcbc0153c79361a0db2c4324249475d3be490f152b64f916bdd53");
    expect(Object.keys(current.declaration).filter(key => current.declaration[key] !== prior.declaration[key]).sort()).toEqual([
      "agentProfileVersion", "profileCompatibilitySourceSha256", "semanticContinuationSourceSha256",
    ]);
    expect(isSupportedAcpxProfileVersion("copilot", 52)).toBe(true);
    expect(current.commandDigest).not.toBe(prior.commandDigest);
  });

  it("preserves v51 when the setup transport contract changes", () => {
    const prior = JSON.parse(readFileSync(new URL("../../../test/fixtures/copilot-profile-v51-identity.json", import.meta.url), "utf8"));
    expect(prior.commandDigest).toBe("sha256:8c1cddce201eb0e3f2792cc5a8c79edf36b0ce823e728255c1897f95c74a3866");
    expect(isSupportedAcpxProfileVersion("copilot", 51)).toBe(true);
    expect(QUALIFIED_ACPX_PROFILES.copilot.commandDigest).not.toBe(prior.commandDigest);
  });

  it("preserves v49 while binding the extracted provider launch builder", () => {
    const prior = JSON.parse(readFileSync(new URL("../../../test/fixtures/copilot-profile-v49-identity.json", import.meta.url), "utf8"));
    const current = JSON.parse(readFileSync(new URL("../../../test/fixtures/copilot-profile-v50-identity.json", import.meta.url), "utf8"));
    expect(prior.commandDigest).toBe("sha256:37a8f6a540a7417bb12becbf283158df8cca925c5136ecc0db14597441fff702");
    expect(Object.keys(current.declaration).filter(key => current.declaration[key] !== prior.declaration[key]).sort()).toEqual([
      "agentProfileVersion", "profileCompatibilitySourceSha256", "providerLaunchSourceSha256", "runtimeRequestBridgeSourceSha256",
    ]);
    expect(isSupportedAcpxProfileVersion("copilot", 49)).toBe(true);
  });

  it("preserves qualified v48 while binding completion-proposal recovery in v49", async () => {
    const prior = JSON.parse(readFileSync(new URL("../../../test/fixtures/copilot-profile-v48-identity.json", import.meta.url), "utf8"));
    const current = JSON.parse(readFileSync(new URL("../../../test/fixtures/copilot-profile-v49-identity.json", import.meta.url), "utf8"));
    expect(prior.commandDigest).toBe("sha256:49171cb881c43270e101a790a109752642870daedc38cd6e91aef08fd7aab038");
    const sortedPrior = Object.fromEntries(Object.entries(prior.declaration).sort(([a], [b]) => a.localeCompare(b)));
    expect(`sha256:${createHash("sha256").update(JSON.stringify(sortedPrior)).digest("hex")}`).toBe(prior.commandDigest);
    expect(Object.keys(current.declaration).sort()).toEqual(Object.keys(prior.declaration).sort());
    expect(Object.keys(current.declaration).filter(key => current.declaration[key] !== prior.declaration[key]).sort()).toEqual([
      "agentProfileVersion", "nativeSessionRuntimeSourceSha256", "profileCompatibilitySourceSha256",
    ]);
    expect(isSupportedAcpxProfileVersion("copilot", 48)).toBe(true);
    vi.mocked(verifyNativeAcpxInstallation).mockClear();
    await expect(verifyCopilotInstallation({ ...QUALIFIED_ACPX_PROFILES.copilot,
      agentProfileVersion: 48, commandDigest: prior.commandDigest })).rejects.toThrow("exact pinned");
    expect(verifyNativeAcpxInstallation).not.toHaveBeenCalled();
  });

  it("preserves qualified v47 while binding the additive case contracts in v48", async () => {
    const prior = JSON.parse(readFileSync(new URL("../../../test/fixtures/copilot-profile-v47-identity.json", import.meta.url), "utf8"));
    const current = JSON.parse(readFileSync(new URL("../../../test/fixtures/copilot-profile-v48-identity.json", import.meta.url), "utf8"));
    expect(prior.commandDigest).toBe("sha256:55044aa235e88b3fe36ec8a556ee1e3382590870aab907e4462ef7d64af49cea");
    const sortedPrior = Object.fromEntries(Object.entries(prior.declaration).sort(([a], [b]) => a.localeCompare(b)));
    expect(`sha256:${createHash("sha256").update(JSON.stringify(sortedPrior)).digest("hex")}`).toBe(prior.commandDigest);
    expect(Object.keys(current.declaration).sort()).toEqual(Object.keys(prior.declaration).sort());
    expect(Object.keys(current.declaration).filter(key => current.declaration[key] !== prior.declaration[key]).sort()).toEqual([
      "agentProfileVersion", "nativeRuntimeContextSourceSha256", "profileCompatibilitySourceSha256",
      "semanticCompletionContractSourceSha256", "semanticSchemaBundleSourceSha256", "semanticValidatorsSourceSha256",
    ]);
    expect(isSupportedAcpxProfileVersion("copilot", 47)).toBe(true);
    vi.mocked(verifyNativeAcpxInstallation).mockClear();
    await expect(verifyCopilotInstallation({ ...QUALIFIED_ACPX_PROFILES.copilot,
      agentProfileVersion: 47, commandDigest: prior.commandDigest })).rejects.toThrow("exact pinned");
    expect(verifyNativeAcpxInstallation).not.toHaveBeenCalled();
  });

  it("preserves v12 history and changes only the version and four shared source bindings", () => {
    const prior = JSON.parse(readFileSync(new URL("../../../test/fixtures/copilot-profile-v12-identity.json", import.meta.url), "utf8"));
    const current = JSON.parse(readFileSync(new URL("../../../test/fixtures/copilot-profile-v13-identity.json", import.meta.url), "utf8"));
    const changed = Object.keys(current.declaration).filter(key => current.declaration[key] !== prior.declaration[key]).sort();
    expect(changed).toEqual(["agentProfileVersion", "semanticDirectDriverSourceSha256", "semanticSchemaBundleSourceSha256", "semanticSidecarProtocolSourceSha256", "semanticSidecarSourceSha256"]);
    expect(Object.keys(current.declaration).sort()).toEqual(Object.keys(prior.declaration).sort());
    expect(prior.declaration.agentProfileVersion).toBe(12);
    expect(current.declaration.agentProfileVersion).toBe(13);
    const sortedPrior = Object.fromEntries(Object.entries(prior.declaration).sort(([a], [b]) => a.localeCompare(b)));
    expect(`sha256:${createHash("sha256").update(JSON.stringify(sortedPrior)).digest("hex")}`).toBe(prior.commandDigest);
    expect(current.commandDigest).not.toBe(prior.commandDigest);
  });

  it("preserves v13 history while binding the shared live request snapshot", () => {
    const prior = JSON.parse(readFileSync(new URL("../../../test/fixtures/copilot-profile-v13-identity.json", import.meta.url), "utf8"));
    const current = JSON.parse(readFileSync(new URL("../../../test/fixtures/copilot-profile-v14-identity.json", import.meta.url), "utf8"));
    expect(Object.keys(current.declaration).filter(key => current.declaration[key] !== prior.declaration[key]).sort()).toEqual(["agentProfileVersion", "semanticSidecarSourceSha256"]);
  });

  it("preserves v14 history while binding the corrected outbound ACPX delivery", () => {
    const prior = JSON.parse(readFileSync(new URL("../../../test/fixtures/copilot-profile-v14-identity.json", import.meta.url), "utf8"));
    const current = JSON.parse(readFileSync(new URL("../../../test/fixtures/copilot-profile-v15-identity.json", import.meta.url), "utf8"));
    expect(Object.keys(current.declaration).filter(key => current.declaration[key] !== prior.declaration[key]).sort()).toEqual(["acpxPatchSha256", "agentProfileVersion"]);
  });

  it("preserves v17 history while binding the shared Grok descriptor schema", () => {
    const prior = JSON.parse(readFileSync(new URL("../../../test/fixtures/copilot-profile-v17-identity.json", import.meta.url), "utf8"));
    const current = JSON.parse(readFileSync(new URL("../../../test/fixtures/copilot-profile-v18-identity.json", import.meta.url), "utf8"));
    expect(Object.keys(current.declaration).filter(key => current.declaration[key] !== prior.declaration[key]).sort()).toEqual(["agentProfileVersion", "semanticSchemaBundleSourceSha256"]);
    expect(Object.keys(current.declaration).sort()).toEqual(Object.keys(prior.declaration).sort());
    expect(current.commandDigest).not.toBe(prior.commandDigest);
  });

  it("preserves the historical Muse v18 declaration without granting current launch", async () => {
    const prior = JSON.parse(readFileSync(new URL("../../../test/fixtures/copilot-profile-v17-identity.json", import.meta.url), "utf8"));
    const current = JSON.parse(readFileSync(new URL("../../../test/fixtures/copilot-profile-v18-muse-historical-identity.json", import.meta.url), "utf8"));
    expect(Object.keys(current.declaration).filter(key => current.declaration[key] !== prior.declaration[key]).sort()).toEqual([
      "agentProfileVersion", "semanticSchemaBundleSourceSha256", "semanticValidatorsSourceSha256",
    ]);
    expect(Object.keys(current.declaration).sort()).toEqual(Object.keys(prior.declaration).sort());
    expect(prior.declaration.agentProfileVersion).toBe(17);
    const sortedPrior = Object.fromEntries(Object.entries(prior.declaration).sort(([a], [b]) => a.localeCompare(b)));
    expect(`sha256:${createHash("sha256").update(JSON.stringify(sortedPrior)).digest("hex")}`).toBe(prior.commandDigest);
    expect(current.commandDigest).not.toBe(prior.commandDigest);
    vi.mocked(verifyNativeAcpxInstallation).mockClear();
    for (const override of [
      { commandDigest: prior.commandDigest },
      { agentProfileVersion: prior.declaration.agentProfileVersion },
      { commandDigest: prior.commandDigest, agentProfileVersion: prior.declaration.agentProfileVersion },
    ]) {
      await expect(verifyCopilotInstallation({ ...QUALIFIED_ACPX_PROFILES.copilot, ...override })).rejects.toThrow("exact pinned");
    }
    expect(verifyNativeAcpxInstallation).not.toHaveBeenCalled();
  });

  it("preserves the historical combined external-provider v19 declaration without granting current launch", async () => {
    const current = JSON.parse(readFileSync(new URL("../../../test/fixtures/copilot-profile-v19-muse-historical-identity.json", import.meta.url), "utf8"));
    expect(current.declaration.agentProfileVersion).toBe(19);
    expect(isSupportedAcpxProfileVersion("copilot", 18)).toBe(true);
    vi.mocked(verifyNativeAcpxInstallation).mockClear();
    for (const [name, changed] of [
      ["copilot-profile-v18-identity.json", ["agentProfileVersion", "semanticSchemaBundleSourceSha256", "semanticValidatorsSourceSha256"]],
      ["copilot-profile-v18-muse-historical-identity.json", ["agentProfileVersion", "semanticSchemaBundleSourceSha256"]],
    ] as const) {
      const prior = JSON.parse(readFileSync(new URL(`../../../test/fixtures/${name}`, import.meta.url), "utf8"));
      expect(Object.keys(current.declaration).filter(key => current.declaration[key] !== prior.declaration[key]).sort()).toEqual(changed);
      expect(Object.keys(current.declaration).sort()).toEqual(Object.keys(prior.declaration).sort());
      expect(current.commandDigest).not.toBe(prior.commandDigest);
      for (const override of [
        { commandDigest: prior.commandDigest },
        { agentProfileVersion: prior.declaration.agentProfileVersion },
        { commandDigest: prior.commandDigest, agentProfileVersion: prior.declaration.agentProfileVersion },
      ]) {
        await expect(verifyCopilotInstallation({ ...QUALIFIED_ACPX_PROFILES.copilot, ...override })).rejects.toThrow("exact pinned");
      }
    }
    expect(verifyNativeAcpxInstallation).not.toHaveBeenCalled();
  });

  it("preserves v18 history while binding the credential update protocol sources", () => {
    const prior = JSON.parse(readFileSync(new URL("../../../test/fixtures/copilot-profile-v18-identity.json", import.meta.url), "utf8"));
    const current = JSON.parse(readFileSync(new URL("../../../test/fixtures/copilot-profile-v19-identity.json", import.meta.url), "utf8"));
    expect(Object.keys(current.declaration).filter(key => current.declaration[key] !== prior.declaration[key]).sort())
      .toEqual(["agentProfileVersion", "semanticSchemaBundleSourceSha256", "semanticValidationSourceSha256", "semanticValidatorsSourceSha256"]);
    expect(Object.keys(current.declaration).sort()).toEqual(Object.keys(prior.declaration).sort());
    expect(current.commandDigest).not.toBe(prior.commandDigest);
  });
  it("binds both immutable v19 histories in a new combined v20 declaration", async () => {
    const current = JSON.parse(readFileSync(new URL("../../../test/fixtures/copilot-profile-v20-identity.json", import.meta.url), "utf8"));
    expect(current.declaration.agentProfileVersion).toBe(20);
    expect(isSupportedAcpxProfileVersion("copilot", 19)).toBe(true);
    vi.mocked(verifyNativeAcpxInstallation).mockClear();
    for (const [name, changed] of [
      ["copilot-profile-v19-identity.json", ["agentProfileVersion", "semanticSchemaBundleSourceSha256", "semanticValidatorsSourceSha256"]],
      ["copilot-profile-v19-muse-historical-identity.json", ["agentProfileVersion", "semanticSchemaBundleSourceSha256", "semanticValidationSourceSha256", "semanticValidatorsSourceSha256"]],
    ] as const) {
      const prior = JSON.parse(readFileSync(new URL(`../../../test/fixtures/${name}`, import.meta.url), "utf8"));
      expect(Object.keys(current.declaration).filter(key => current.declaration[key] !== prior.declaration[key]).sort()).toEqual(changed);
      expect(Object.keys(current.declaration).sort()).toEqual(Object.keys(prior.declaration).sort());
      const sortedPrior = Object.fromEntries(Object.entries(prior.declaration).sort(([a], [b]) => a.localeCompare(b)));
      expect(`sha256:${createHash("sha256").update(JSON.stringify(sortedPrior)).digest("hex")}`).toBe(prior.commandDigest);
      expect(current.commandDigest).not.toBe(prior.commandDigest);
      for (const override of [
        { commandDigest: prior.commandDigest },
        { agentProfileVersion: prior.declaration.agentProfileVersion },
        { commandDigest: prior.commandDigest, agentProfileVersion: prior.declaration.agentProfileVersion },
      ]) {
        await expect(verifyCopilotInstallation({ ...QUALIFIED_ACPX_PROFILES.copilot, ...override })).rejects.toThrow("exact pinned");
      }
    }
    expect(verifyNativeAcpxInstallation).not.toHaveBeenCalled();
  });

  it("preserves v20 history while binding the controller-owned monitor continuation", async () => {
    const prior = JSON.parse(readFileSync(new URL("../../../test/fixtures/copilot-profile-v20-identity.json", import.meta.url), "utf8"));
    const current = JSON.parse(readFileSync(new URL("../../../test/fixtures/copilot-profile-v21-mainline-monitor-identity.json", import.meta.url), "utf8"));
    expect(Object.keys(current.declaration).filter(key => current.declaration[key] !== prior.declaration[key]).sort()).toEqual([
      "agentProfileVersion", "semanticCompletionContractSourceSha256", "semanticContinuationSourceSha256", "semanticDirectDriverSourceSha256", "semanticSidecarSourceSha256",
    ]);
    expect(Object.keys(current.declaration).filter(key => !Object.hasOwn(prior.declaration, key))).toEqual(["semanticContinuationSourceSha256"]);
    expect(Object.keys(prior.declaration).every(key => Object.hasOwn(current.declaration, key))).toBe(true);
    expect(isSupportedAcpxProfileVersion("copilot", 20)).toBe(true);
    const sorted = Object.fromEntries(Object.entries(prior.declaration).sort(([a], [b]) => a.localeCompare(b)));
    expect(`sha256:${createHash("sha256").update(JSON.stringify(sorted)).digest("hex")}`).toBe(prior.commandDigest);
    await expect(verifyCopilotInstallation({ ...QUALIFIED_ACPX_PROFILES.copilot,
      agentProfileVersion: 20, commandDigest: prior.commandDigest })).rejects.toThrow("exact pinned");
  });

  it("preserves v22 history while binding the Claude-only preload metadata branch", async () => {
    const prior = JSON.parse(readFileSync(new URL("../../../test/fixtures/copilot-mainline-v22-identity.json", import.meta.url), "utf8"));
    const current = JSON.parse(readFileSync(new URL("../../../test/fixtures/copilot-mainline-v23-identity.json", import.meta.url), "utf8"));
    expect(Object.keys(current.declaration).filter(key => current.declaration[key] !== prior.declaration[key]).sort())
      .toEqual(["agentProfileVersion", "semanticBridgeSourceSha256"]);
    expect(Object.keys(current.declaration).sort()).toEqual(Object.keys(prior.declaration).sort());
    expect(isSupportedAcpxProfileVersion("copilot", 22)).toBe(true);
    const sorted = Object.fromEntries(Object.entries(prior.declaration).sort(([a], [b]) => a.localeCompare(b)));
    expect(`sha256:${createHash("sha256").update(JSON.stringify(sorted)).digest("hex")}`).toBe(prior.commandDigest);
    await expect(verifyCopilotInstallation({ ...QUALIFIED_ACPX_PROFILES.copilot,
      agentProfileVersion: 22, commandDigest: prior.commandDigest })).rejects.toThrow("exact pinned");
  });

  it("preserves v23 history while binding shared observability diagnostic redaction", () => {
    const prior = JSON.parse(readFileSync(new URL("../../../test/fixtures/copilot-mainline-v23-identity.json", import.meta.url), "utf8"));
    const current = JSON.parse(readFileSync(new URL("../../../test/fixtures/copilot-mainline-v24-identity.json", import.meta.url), "utf8"));
    expect(Object.keys(current.declaration).filter(key => current.declaration[key] !== prior.declaration[key]).sort()).toEqual([
      "agentProfileVersion", "semanticSidecarSourceSha256",
    ]);
    expect(isSupportedAcpxProfileVersion("copilot", 23)).toBe(true);
    expect(current.commandDigest).not.toBe(prior.commandDigest);
  });

  it("admits the current declaration and binds its source policy, receipts and patch hashes", () => {
    const identity = JSON.parse(readFileSync(new URL(`../../../test/fixtures/copilot-profile-v${QUALIFIED_ACPX_PROFILES.copilot.agentProfileVersion}-identity.json`, import.meta.url), "utf8"));
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
    for (const [relative, field] of [...PERMISSION_POLICY_SOURCES, ...COPILOT_DISPLAY_SOURCES, ...SEMANTIC_RECEIPT_SOURCES, ["../../contracts/runtime-context.ts", "nativeRuntimeContextSourceSha256"], ["../../contracts/runtime-context-prompts.ts", "nativeRuntimePromptsSourceSha256"], ["copilot-policy.ts", "policySha256"], ["profile-compatibility.ts", "profileCompatibilitySourceSha256"], ["provider-assets-root.ts", "assetOwnershipSourceSha256"], ["../../../scripts/install-copilot-assets.mjs", "assetInstallerSourceSha256"], ["../../../scripts/materialize-copilot-binary.mjs", "distributionSourceSha256"], ["../../../scripts/copilot-inner-distribution.mjs", "innerDistributionSourceSha256"], ["../../../../../patches/acpx@0.13.1.patch", "acpxPatchSha256"]]) {
      expect(createHash("sha256").update(readFileSync(new URL(relative!, import.meta.url))).digest("hex")).toBe(identity.declaration[field!]);
    }
    const manifest = JSON.parse(readFileSync(new URL("../../../acpx-profiles.json", import.meta.url), "utf8"));
    expect(manifest.profiles.copilot.commandDigest).toBe(identity.commandDigest);
    expect(readFileSync(new URL("../../../scripts/build-copilot-distribution.mjs", import.meta.url), "utf8")).toContain("profiles.profiles.copilot.commandDigest");
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
    const identity = JSON.parse(readFileSync(new URL(`../../../test/fixtures/copilot-profile-v${QUALIFIED_ACPX_PROFILES.copilot.agentProfileVersion}-identity.json`, import.meta.url), "utf8"));
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
  it("ignores ambient executable selection and supplies only pinned native launch inputs", () => withCopilotTestPlatform("x64", async () => {
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
  }));
  it("rejects an unpinned linux-arm64 distribution before native file access", () => withCopilotTestPlatform("arm64", async () => {
    vi.mocked(verifyNativeAcpxInstallation).mockClear();
    await expect(verifyCopilotInstallation(QUALIFIED_ACPX_PROFILES.copilot)).rejects.toThrow(/^Copilot native distribution is not pinned for linux-arm64$/);
    expect(verifyNativeAcpxInstallation).not.toHaveBeenCalled();
  }));
  it("rejects changed profile identities before native file access", async () => {
    vi.mocked(verifyNativeAcpxInstallation).mockClear();
    for (const override of [{ agentServerVersion: "latest" }, { commandDigest: "sha256:untrusted" }, { commandDigest: "sha256:ed39259990cb0efda48d6105d2fa3599aac76873eb75cd80b4d0b179ce0579a6" }, { agent: "cursor" }, { agentProfileVersion: 1 }, { agentProfileVersion: 2 }, { agentProfileVersion: 3 }, { agentProfileVersion: 4 }, { agentProfileVersion: 5 }, { agentProfileVersion: 6 }, { agentProfileVersion: 7 }, { agentProfileVersion: 8 }, { agentProfileVersion: 9 }, { agentProfileVersion: 10 }, { agentProfileVersion: 17 }, { agentProfileVersion: 18 }, { agentProfileVersion: 19 }]) {
      await expect(verifyCopilotInstallation({ ...QUALIFIED_ACPX_PROFILES.copilot, ...override } as never)).rejects.toThrow("exact pinned");
    }
    expect(verifyNativeAcpxInstallation).not.toHaveBeenCalled();
  });
});
