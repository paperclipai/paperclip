import { assertAcpxExecutionAdmission, type AcpxCandidateStartupAdmission } from "./candidate-admission.js";
import { lstatSync } from "node:fs";
import { userInfo } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { ANTIGRAVITY_DISTRIBUTION_PINS } from "./generated-profiles.js";
import { verifyNativeAcpxInstallation, type VerifiedAcpxInstallation } from "./installation-integrity.js";
import type { NativeAcpxDistributionInput } from "./native-distribution-integrity.js";
import { resolveRunnerProviderAssetsRoot } from "./provider-assets-root.js";
import { realRuntimeCachePath } from "./runtime-cache-path.js";
import { QUALIFIED_ACPX_PROFILES, type QualifiedAcpxProfile } from "./qualified-profiles.js";

/** Owned cache resolution is independent of the isolated provider's HOME. */
export function antigravityRuntimeCachePath(closure: string, platform: string, architecture: string, home = userInfo().homedir): string {
  if (!/^[a-f0-9]{64}$/.test(closure) || !Object.hasOwn(ANTIGRAVITY_DISTRIBUTION_PINS, `${platform}-${architecture}`)
    || !isAbsolute(home) || home.includes("\0")) throw new Error("Invalid Antigravity runtime cache identity");
  return realRuntimeCachePath(home, "antigravity", `${platform}-${architecture}`, closure, "Antigravity runtime cache must contain real directories");
}

function realDirectoryExists(path: string, message: string): boolean {
  try {
    const stat = lstatSync(path);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(message);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return false;
  }
}

const ANTIGRAVITY_PROVIDER_PACK_ENV = "PAPERCLIP_RUNNER_REMOTE_PROVIDER_PACK_PATH";

export function antigravityProviderPackRoot(environment: NodeJS.ProcessEnv = process.env): string | undefined {
  const configured = environment[ANTIGRAVITY_PROVIDER_PACK_ENV]?.trim();
  if (!configured) return undefined;
  const root = configured.replace(/\/+$/, "") || "/";
  if (!isAbsolute(root) || root.includes("\0") || resolve(root) !== root) throw new Error("Antigravity provider pack root must be a normalized absolute path");
  return root;
}

function providerPackDistribution(pack: string, key: string): string | undefined {
  if (!realDirectoryExists(pack, "Antigravity provider pack must be a real directory")) return undefined;
  const directory = join(resolveRunnerProviderAssetsRoot(import.meta.url, "antigravity", { providerPackageRoot: pack }), key);
  return realDirectoryExists(directory, "Antigravity provider pack runtime must be a real directory") ? directory : undefined;
}

export function antigravityNativeDistributionSpec(platform: NodeJS.Platform = process.platform, architecture: string = process.arch): NativeAcpxDistributionInput {
  const key = `${platform}-${architecture}`;
  if (!Object.hasOwn(ANTIGRAVITY_DISTRIBUTION_PINS, key)) throw new Error(`Antigravity has no admitted complete runtime closure for ${key}`);
  const pin = ANTIGRAVITY_DISTRIBUTION_PINS[key as keyof typeof ANTIGRAVITY_DISTRIBUTION_PINS];
  const packaged = join(resolveRunnerProviderAssetsRoot(import.meta.url, "antigravity"), key);
  let distributionRoot = packaged;
  if (!realDirectoryExists(packaged, "Antigravity packaged runtime must be a real directory")) {
    const pack = antigravityProviderPackRoot();
    distributionRoot = (pack === undefined ? undefined : providerPackDistribution(pack, key))
      ?? antigravityRuntimeCachePath(pin.closureSha256, platform, architecture);
  }
  return { distributionRoot, manifestPath: join(distributionRoot, ".paperclip-antigravity-closure.json"), expectedClosureSha256: pin.closureSha256,
    executable: pin.executable, fixedArguments: [...pin.args], storeFamily: "antigravity" };
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
