import { assertAcpxExecutionAdmission, type AcpxCandidateStartupAdmission } from "./candidate-admission.js";
import { lstatSync } from "node:fs";
import { userInfo } from "node:os";
import { isAbsolute, join } from "node:path";
import { ANTIGRAVITY_DISTRIBUTION_PINS } from "./generated-profiles.js";
import { verifyNativeAcpxInstallation, type VerifiedAcpxInstallation } from "./installation-integrity.js";
import type { NativeAcpxDistributionInput } from "./native-distribution-integrity.js";
import { resolveRunnerProviderAssetsRoot } from "./provider-assets-root.js";
import { QUALIFIED_ACPX_PROFILES, type QualifiedAcpxProfile } from "./qualified-profiles.js";

/** Owned cache resolution is independent of the isolated provider's HOME. */
export function antigravityRuntimeCachePath(closure: string, platform: string, architecture: string, home = userInfo().homedir): string {
  if (!/^[a-f0-9]{64}$/.test(closure) || !Object.hasOwn(ANTIGRAVITY_DISTRIBUTION_PINS, `${platform}-${architecture}`)
    || !isAbsolute(home) || home.includes("\0")) throw new Error("Invalid Antigravity runtime cache identity");
  let directory = home;
  for (const part of [".paperclip", "runtimes", "antigravity", `${platform}-${architecture}`, closure]) {
    directory = join(directory, part);
    try {
      const stat = lstatSync(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Antigravity runtime cache must contain real directories");
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  return directory;
}

export function antigravityNativeDistributionSpec(platform: NodeJS.Platform = process.platform, architecture: string = process.arch): NativeAcpxDistributionInput {
  const key = `${platform}-${architecture}`;
  if (!Object.hasOwn(ANTIGRAVITY_DISTRIBUTION_PINS, key)) throw new Error(`Antigravity has no admitted complete runtime closure for ${key}`);
  const pin = ANTIGRAVITY_DISTRIBUTION_PINS[key as keyof typeof ANTIGRAVITY_DISTRIBUTION_PINS];
  const packaged = join(resolveRunnerProviderAssetsRoot(import.meta.url, "antigravity"), key);
  let distributionRoot = packaged;
  try {
    const stat = lstatSync(packaged);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Antigravity packaged runtime must be a real directory");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    distributionRoot = antigravityRuntimeCachePath(pin.closureSha256, platform, architecture);
  }
  return { distributionRoot, manifestPath: join(distributionRoot, ".paperclip-antigravity-closure.json"), expectedClosureSha256: pin.closureSha256,
    executable: pin.executable, fixedArguments: [...pin.args] };
}

export async function verifyAntigravityInstallation(profile: QualifiedAcpxProfile, candidateAdmission?: AcpxCandidateStartupAdmission): Promise<VerifiedAcpxInstallation> {
  assertAcpxExecutionAdmission(profile, candidateAdmission);
  const trusted = QUALIFIED_ACPX_PROFILES.antigravity;
  const modelFields = new Set(["qualificationModel", "reportedModelId"]);
  if (Object.keys(profile).some(key => !modelFields.has(key) && !Object.hasOwn(trusted, key))
    || Object.entries(trusted).some(([key, value]) => profile[key as keyof QualifiedAcpxProfile] !== value)
    || !profile.qualificationModel?.trim() || profile.reportedModelId !== profile.qualificationModel) {
    throw new Error("Antigravity installation requires its exact pinned profile and an explicit model");
  }
  return { ...await verifyNativeAcpxInstallation(antigravityNativeDistributionSpec()), commandDigest: trusted.commandDigest };
}
