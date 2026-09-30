import { join } from "node:path";

import { verifyNativeAcpxInstallation, type VerifiedAcpxInstallation } from "./installation-integrity.js";
import type { NativeAcpxDistributionInput } from "./native-distribution-integrity.js";
import { CURSOR_FIXED_ARGUMENTS } from "./cursor-launch-policy.js";
import { QUALIFIED_ACPX_PROFILES, type QualifiedAcpxProfile } from "./qualified-profiles.js";
import { resolveRunnerProviderAssetsRoot } from "./provider-assets-root.js";

export const CURSOR_PINNED_VERSION = "2026.09.26-dd393fe";
const CLOSURE_PINS = Object.freeze({
  "darwin-arm64": "257424bd48e35412091c6adfc61e4648e836757ec1d240d890bba81a24918c30",
  "darwin-x64": "6f28c799c5afdc64fbdff8a2157f565f17ae7615efe014ac389d63bf70cf2be2",
  "linux-x64": "eadb8bb8ffb0450455b15b88c9b230307a9e149958a0c452d16dd157b4633d74",
});

/** Trusted package assets only: no workspace, PATH, executable override or env root. */
export function cursorNativeDistributionSpec(
  platform: NodeJS.Platform = process.platform,
  architecture: string = process.arch,
): NativeAcpxDistributionInput {
  const key = `${platform}-${architecture}`;
  if (!Object.hasOwn(CLOSURE_PINS, key)) throw new Error(`Cursor ${CURSOR_PINNED_VERSION} has no pinned distribution for ${key}`);
  const distributionRoot = join(resolveRunnerProviderAssetsRoot(import.meta.url, "cursor"), key);
  return {
    distributionRoot,
    manifestPath: join(distributionRoot, ".paperclip-cursor-closure.json"),
    expectedClosureSha256: CLOSURE_PINS[key as keyof typeof CLOSURE_PINS],
    executable: "node",
    entrypoint: "index.js",
    fixedArguments: [...CURSOR_FIXED_ARGUMENTS],
  };
}

/** Verifies launch bytes, not qualification. Profile admission remains separate. */
export async function verifyCursorInstallation(profile: QualifiedAcpxProfile): Promise<VerifiedAcpxInstallation> {
  const trusted = QUALIFIED_ACPX_PROFILES.cursor;
  const modelFields = new Set(["qualificationModel", "reportedModelId"]);
  if (Object.keys(profile).some(key => !Object.hasOwn(trusted, key))
    || Object.entries(trusted).some(([key, value]) => !modelFields.has(key) && profile[key as keyof QualifiedAcpxProfile] !== value)
    || !profile.qualificationModel.trim() || profile.reportedModelId !== profile.qualificationModel) {
    throw new Error("Cursor installation requires the exact pinned profile and an explicit model");
  }
  const installation = await verifyNativeAcpxInstallation(cursorNativeDistributionSpec());
  return { ...installation, commandDigest: trusted.commandDigest };
}
