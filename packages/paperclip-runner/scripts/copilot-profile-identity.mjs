// Regenerate after changing any bound implementation; live qualification must
// restart whenever the resulting identity changes. Historical identities remain.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const fixture = resolve(root, "test/fixtures/copilot-profile-v37-identity.json");
const historical = JSON.parse(readFileSync(resolve(root, "test/fixtures/copilot-profile-v12-identity.json"), "utf8"));
const declaration = { ...historical.declaration, agentProfileVersion: 37 };
delete declaration.permissionIdentitySourceSha256;
const sources = {
  displayEventSourceSha256: "src/drivers/acpx/copilot-events.ts",
  displayProjectionSourceSha256: "src/drivers/acpx/copilot-extension-adapter.ts",
  configuredEnvironmentSourceSha256: "src/configured-environment.ts",
  configuredEnvironmentRustSourceSha256: "runner/crates/runner-core/src/configured_environment.rs",
  profileActivitySourceSha256: "src/drivers/acpx/profile-activity.ts",
  profileExtensionsSourceSha256: "src/drivers/acpx/profile-extensions.ts",
  profileInstallationSourceSha256: "src/drivers/acpx/profile-installation.ts",
  attachmentPolicySourceSha256: "runner/crates/runner-core/src/acpx_provider_capabilities.rs",
  singleReadEvidenceSourceSha256: "src/drivers/acpx/single-read-evidence.ts",
  nativeSessionRuntimeSourceSha256: "src/native-session-runtime.ts",
  nativeRuntimeContextSourceSha256: "src/contracts/runtime-context.ts",
  nativeSessionContractSourceSha256: "src/contracts/native-session-backend.ts",
  harnessSessionContractSourceSha256: "src/contracts/harness-driver.ts",
  harnessBackendSourceSha256: "src/backends/harness-driver-backend.ts",
  harnessSessionSourceSha256: "src/drivers/codex/codex-harness-session.ts",
  transportContractSourceSha256: "src/drivers/codex/app-server-transport.ts",
  nativeBackendSourceSha256: "src/backends/codex-native-backend.ts",
  nativeBackendFactorySourceSha256: "src/backends/native-backend-factory.ts",
  nativeInstructionsSourceSha256: "src/backends/runtime-context.ts",
  runtimeRequestBridgeSourceSha256: "src/live/runnerd-codex-transport.ts",
  runtimeRequestFacadeSourceSha256: "src/drivers/codex/codex-session-notifications.ts",
  runtimeRequestNotificationSourceSha256: "src/drivers/codex/codex-thread-normalization.ts",
  guardedInstallationSourceSha256: "src/drivers/acpx/installation-integrity.ts",
  nativeExecutionSourceSha256: "src/contracts/native-execution.ts",
  profileCompatibilitySourceSha256: "src/drivers/acpx/profile-compatibility.ts",
  installationSourceSha256: "src/drivers/acpx/copilot-installation.ts",
  assetOwnershipSourceSha256: "src/drivers/acpx/provider-assets-root.ts",
  assetInstallerSourceSha256: "scripts/install-copilot-assets.mjs",
  credentialBindingSourceSha256: "src/drivers/acpx/environment.ts",
  sidecarErrorSourceSha256: "src/cli/acpx-sidecar-input.ts",
  profileSourceSha256: "src/drivers/acpx/copilot-profile.ts",
  metadataProbeSourceSha256: "src/drivers/copilot-metadata-probe.ts",
  acpxPatchSha256: "../../patches/acpx@0.13.1.patch",
  policySha256: "src/drivers/acpx/copilot-policy.ts",
  distributionSourceSha256: "scripts/materialize-copilot-binary.mjs",
  innerDistributionSourceSha256: "scripts/copilot-inner-distribution.mjs",
  permissionContextSourceSha256: "src/drivers/acpx/copilot-permission-context.ts",
  permissionAdapterSourceSha256: "src/drivers/acpx/acp-permission-adapter.ts",
  permissionToolIdentitySourceSha256: "src/drivers/acpx/cursor-plan-tool-identity.ts",
  permissionLocationsSourceSha256: "src/drivers/acpx/safe-locations.ts",
  permissionRedactionSourceSha256: "src/semantic-tools/redaction.ts",
  permissionClassifierSourceSha256: "src/drivers/acpx/generated-sidecar-contract.ts",
  semanticReceiptSourceSha256: "src/drivers/semantic-tool-receipt.ts",
  semanticBridgeSourceSha256: "src/drivers/runner-tool-bridge.ts",
  toolEvidenceSourceSha256: "src/drivers/acpx/copilot-tool-evidence.ts",
  semanticSidecarSourceSha256: "src/cli/acpx-runtime-sidecar.ts",
  semanticDirectDriverSourceSha256: "src/drivers/acpx/codex-acpx-driver.ts",
  semanticValidationSourceSha256: "src/protocol/replay-contract.ts",
  semanticNormalizationSourceSha256: "src/protocol/result-normalization.ts",
  semanticCompletionContractSourceSha256: "src/contracts/completion-result.ts",
  semanticValidatorsSourceSha256: "src/protocol/generated/standalone-validators.ts",
  semanticSchemaBundleSourceSha256: "src/protocol/generated/schema-bundle.ts",
  semanticSidecarProtocolSourceSha256: "src/drivers/acpx/sidecar-protocol.ts",
  runtimeHostSourceSha256: "src/drivers/acpx/runtime-host.ts",
  runtimeAdapterSourceSha256: "src/drivers/acpx/codex-runtime-adapter.ts",
  runtimeSandboxSourceSha256: "src/drivers/acpx/runtime-sandbox.ts",
  cancellationSourceSha256: "src/drivers/acpx/turn-cancellation.ts",
  agentFilesSourceSha256: "src/drivers/acpx/agent-files-binding.ts",
  nativeDistributionSourceSha256: "src/drivers/acpx/native-distribution-integrity.ts",
};
for (const [field, path] of Object.entries(sources)) {
  declaration[field] = createHash("sha256").update(readFileSync(resolve(root, path))).digest("hex");
}
const sorted = Object.fromEntries(Object.entries(declaration).sort(([a], [b]) => a.localeCompare(b)));
const commandDigest = `sha256:${createHash("sha256").update(JSON.stringify(sorted)).digest("hex")}`;
const identity = `${JSON.stringify({ commandDigest, declaration }, null, 2)}\n`;
// The shared manifest now generates both TypeScript and Rust admission. Update
// only Copilot; other providers retain their upstream release attestations.
const manifestPath = resolve(root, "acpx-profiles.json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
if (process.argv.includes("--check")) {
  if (manifest.profiles.copilot.commandDigest !== commandDigest
    || manifest.profiles.copilot.agentProfileVersion !== declaration.agentProfileVersion) {
    throw new Error("Copilot identity is stale in acpx-profiles.json");
  }
} else {
  manifest.profiles.copilot.commandDigest = commandDigest;
  manifest.profiles.copilot.agentProfileVersion = declaration.agentProfileVersion;
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}
// The builder reads the active manifest; no duplicate digest literal is allowed.
const distributionSource = readFileSync(resolve(root, "scripts/build-copilot-distribution.mjs"), "utf8");
if (!distributionSource.includes("profiles.profiles.copilot.commandDigest")) {
  throw new Error("Copilot distribution builder must use the active manifest identity");
}
// The shared generator validates this exact attestation before emitting admission.
if (process.argv.includes("--check")) {
  if (readFileSync(fixture, "utf8") !== identity) throw new Error("Copilot source identity is stale");
} else writeFileSync(fixture, identity);
execFileSync(process.execPath, [resolve(root, "scripts/generate-acpx-profiles.mjs"),
  ...(process.argv.includes("--check") ? ["--check"] : [])], { stdio: "inherit" });
console.log(commandDigest);
