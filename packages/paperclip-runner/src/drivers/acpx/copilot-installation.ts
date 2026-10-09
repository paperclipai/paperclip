import { join } from "node:path";
import { resolveRunnerProviderAssetsRoot } from "./provider-assets-root.js";
import { verifyNativeAcpxInstallation, type VerifiedAcpxInstallation } from "./installation-integrity.js";
import { COPILOT_LAUNCH_ARGUMENTS, COPILOT_VERSION } from "./copilot-profile.js";
import { QUALIFIED_ACPX_PROFILES, type QualifiedAcpxProfile } from "./qualified-profiles.js";

export const COPILOT_CLOSURE_SHA256 = Object.freeze({
  "darwin-arm64": "362f2663e967fb9e34a814bac4619cbf89e6b23069c4051ab1f2f686852d0a32",
  "darwin-x64": "c08b7c3dd4e7bcf9a3e16ec6eba29cfa10308e865d196c5f120a3a15f6b3116a",
  "linux-x64": "a3d8f4367cfa1694d79e3f8b7930b6fbfe42a229c272b375b11951d631db8d07",
});

/** Admission primitive only. Pending candidates remain gated by qualification. */
export async function verifyCopilotInstallation(profile: QualifiedAcpxProfile): Promise<VerifiedAcpxInstallation> {
  const expected = QUALIFIED_ACPX_PROFILES.copilot;
  if (profile.agent !== "copilot" || profile.agentProfileVersion !== expected.agentProfileVersion
    || profile.acpxVersion !== expected.acpxVersion || profile.agentServerPackage !== "@github/copilot"
    || profile.agentServerVersion !== COPILOT_VERSION || profile.commandDigest !== expected.commandDigest
    || profile.agentRuntimePackage !== null || profile.agentRuntimeVersion !== null) {
    throw new Error("Copilot installation requires the exact pinned candidate profile");
  }
  const platform = `${process.platform}-${process.arch}`;
  if (!Object.prototype.hasOwnProperty.call(COPILOT_CLOSURE_SHA256, platform)) {
    throw new Error(`Copilot native distribution is not pinned for ${platform}`);
  }
  const distributionRoot = join(resolveRunnerProviderAssetsRoot(import.meta.url, "copilot"), platform);
  let native: VerifiedAcpxInstallation;
  try { native = await verifyNativeAcpxInstallation({
    distributionRoot,
    manifestPath: join(distributionRoot, ".paperclip-copilot-closure.json"),
    expectedClosureSha256: COPILOT_CLOSURE_SHA256[platform as keyof typeof COPILOT_CLOSURE_SHA256],
    executable: "copilot", fixedArguments: COPILOT_LAUNCH_ARGUMENTS,
    isolatedCacheEnvironmentName: "COPILOT_PKG_CACHE_HOME",
    copilotDistributionDirectory: "distribution",
  }); } catch {
    throw Object.assign(new Error("Install the verified Copilot runtime beside the admitted sidecar."), { code: "COPILOT_INSTALLATION_INVALID", retryable: false });
  }
  // The host identity binds the versioned profile. Native admission independently
  // binds the complete platform closure before creating each single-use lease.
  return Object.freeze({ ...native, commandDigest: expected.commandDigest });
}
