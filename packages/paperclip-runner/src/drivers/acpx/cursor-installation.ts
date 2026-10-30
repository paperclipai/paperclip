import { join } from "node:path";

import { verifyNativeAcpxInstallation, type VerifiedAcpxInstallation } from "./installation-integrity.js";
import type { NativeAcpxDistributionInput } from "./native-distribution-integrity.js";
import { CURSOR_PINNED_VERSION, CURSOR_FIXED_ARGUMENTS } from "./cursor-launch-policy.js";
import { QUALIFIED_ACPX_PROFILES, type QualifiedAcpxProfile } from "./qualified-profiles.js";
import { resolveRunnerProviderAssetsRoot } from "./provider-assets-root.js";
import { resolveCursorDistributionRoot } from "./cursor-runtime-cache.js";

import { CURSOR_DISTRIBUTION_PINS } from "./generated-profiles.js";
export { CURSOR_PINNED_VERSION } from "./cursor-launch-policy.js";

/** Pinned package assets or OS-user cache; never workspace, PATH or provider env roots. */
export function cursorNativeDistributionSpec(
  platform: NodeJS.Platform = process.platform,
  architecture: string = process.arch,
): NativeAcpxDistributionInput {
  const key = `${platform}-${architecture}`;
  if (!Object.hasOwn(CURSOR_DISTRIBUTION_PINS, key)) throw new Error(`Cursor ${CURSOR_PINNED_VERSION} has no pinned distribution for ${key}`);
  const distribution = CURSOR_DISTRIBUTION_PINS[key as keyof typeof CURSOR_DISTRIBUTION_PINS];
  const distributionRoot = resolveCursorDistributionRoot(resolveRunnerProviderAssetsRoot(import.meta.url, "cursor"), distribution.closureSha256, platform, architecture);
  return {
    distributionRoot,
    manifestPath: join(distributionRoot, ".paperclip-cursor-closure.json"),
    expectedClosureSha256: distribution.closureSha256,
    executable: distribution.executable,
    entrypoint: distribution.entrypoint,
    fixedArguments: [...CURSOR_FIXED_ARGUMENTS],
  };
}

/** Verifies launch bytes, not qualification. Profile admission remains separate. */
export async function verifyCursorInstallation(profile: QualifiedAcpxProfile): Promise<VerifiedAcpxInstallation> {
  const trusted = QUALIFIED_ACPX_PROFILES.cursor;
  const modelFields = new Set(["qualificationModel", "reportedModelId"]);
  if (Object.keys(profile).some(key => !modelFields.has(key) && !Object.hasOwn(trusted, key))
    || Object.entries(trusted).some(([key, value]) => profile[key as keyof QualifiedAcpxProfile] !== value)
    || typeof profile.qualificationModel !== "string" || !profile.qualificationModel.trim()
    || profile.reportedModelId !== profile.qualificationModel) {
    throw new Error("Cursor installation requires the exact pinned profile and an explicit model");
  }
  const installation = await verifyNativeAcpxInstallation(cursorNativeDistributionSpec());
  return { ...installation, commandDigest: trusted.commandDigest };
}
