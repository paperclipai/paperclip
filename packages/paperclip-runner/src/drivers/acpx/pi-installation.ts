import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { join } from "node:path";
import { verifyNativeAcpxInstallation, type VerifiedAcpxInstallation } from "./installation-integrity.js";
import { PI_DISTRIBUTION_CLOSURE_SHA256 } from "./pi-closure-pins.js";
import { PI_NODE_VERSION } from "./pi-node-pins.js";
import { verifyPiRuntimeLayoutForNativeSnapshot, type PiRuntimeManifest } from "./pi-verified-runtime.js";
import { readNativeAcpxDistributionEntries } from "./native-distribution-integrity.js";
import { resolveRunnerProviderAssetsRoot } from "./provider-assets-root.js";
import { QUALIFIED_ACPX_PROFILES, type QualifiedAcpxProfile } from "./qualified-profiles.js";

const MAX_DISTRIBUTION_METADATA_BYTES = 4 * 1024 * 1024;
const PI_MODEL = "openrouter/deepseek/deepseek-v4-flash-0731";
const FIXED_PATHS = Object.freeze({
  node: "node/bin/node",
  piEntrypoint: "node_modules/@earendil-works/pi-coding-agent/dist/cli.js",
  extension: "extensions/paperclip.js",
  wrapperEntrypoint: "node_modules/pi-acp/dist/index.js",
});
function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("Pi distribution metadata is invalid");
  return value as Record<string, unknown>;
}

/** Candidate identity is build-owned; model selection cannot substitute a CLI. */
export function assertPiInstallationProfile(profile: QualifiedAcpxProfile): void {
  const trusted = QUALIFIED_ACPX_PROFILES.pi;
  if (profile.agentProfileVersion !== 12) throw new Error("Pi rich ACP requires profile version 12; reopen the previous session");
  if (profile.agent !== "pi" || profile.driverKind !== trusted.driverKind || profile.protocolVersion !== trusted.protocolVersion || profile.acpxVersion !== trusted.acpxVersion || profile.agentServerPackage !== "pi-acp" || profile.agentServerVersion !== "0.0.33" || profile.agentRuntimePackage !== "@earendil-works/pi-coding-agent" || profile.agentRuntimeVersion !== "1.0.0" || profile.commandDigest !== trusted.commandDigest || profile.permissionPolicy !== "interactive" || profile.qualificationModel !== PI_MODEL || profile.reportedModelId !== PI_MODEL) throw new Error("Pi distribution profile differs from its trusted declaration");
}

async function readDistributionMetadata(path: string): Promise<Record<string, unknown>> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await file.stat({ bigint: true });
    if (!before.isFile() || before.nlink !== 1n || before.size < 1n || before.size > BigInt(MAX_DISTRIBUTION_METADATA_BYTES)) throw new Error("Pi distribution metadata is not a bounded private file");
    const bytes = await file.readFile();
    const after = await file.stat({ bigint: true });
    const named = await lstat(path, { bigint: true });
    if (bytes.length !== Number(before.size) || before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs || named.dev !== before.dev || named.ino !== before.ino || named.isSymbolicLink()) throw new Error("Pi distribution metadata changed while read");
    return record(JSON.parse(bytes.toString("utf8")));
  } finally { await file.close(); }
}

/**
 * Resolve only fixed runner package assets. The independently source-pinned
 * native closure supplies the snapshot and provider-group lifetime guardian.
 * Qualification status remains the caller's production admission gate.
 */
export async function verifyPiInstallation(profile: QualifiedAcpxProfile): Promise<VerifiedAcpxInstallation> {
  assertPiInstallationProfile(profile);
  const target = `${process.platform}-${process.arch}`;
  if (!Object.hasOwn(PI_DISTRIBUTION_CLOSURE_SHA256, target)) throw new Error("Pi distribution target is unsupported");
  const expectedClosure = PI_DISTRIBUTION_CLOSURE_SHA256[target as keyof typeof PI_DISTRIBUTION_CLOSURE_SHA256];
  const assets = join(resolveRunnerProviderAssetsRoot(import.meta.url, "pi"), target);
  const runtimeRoot = join(assets, "runtime");
  const assertDirectories = async (): Promise<void> => {
    for (const path of [assets, runtimeRoot]) {
      const stat = await lstat(path);
      if (!stat.isDirectory() || stat.isSymbolicLink() || await realpath(path) !== path) throw new Error("Pi distribution escaped its fixed asset directory");
    }
  };
  try { await assertDirectories(); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error("Pi runtime is not installed on this host; run paperclipai runtime setup pi before selecting Pi");
    throw error;
  }
  const metadataPath = join(assets, "pi-distribution.json");
  const metadata = await readDistributionMetadata(metadataPath);
  const targetMetadata = record(metadata.target);
  const pins = record(metadata.pins);
  if (metadata.schema !== "paperclip.pi-distribution.v1" || metadata.runtimeRoot !== "runtime" || metadata.nativeClosureSha256 !== expectedClosure || targetMetadata.platform !== process.platform || targetMetadata.architecture !== process.arch || targetMetadata.nodeVersion !== PI_NODE_VERSION || pins.nodeVersion !== PI_NODE_VERSION || pins.wrapper !== "0.0.33" || pins.runtime !== "1.0.0" || pins.sdk !== "0.26.0" || pins.zod !== "3.25.76") throw new Error("Pi distribution metadata does not match its trusted target pin");
  const manifest = record(metadata.manifest) as unknown as PiRuntimeManifest;
  for (const [key, value] of Object.entries(FIXED_PATHS)) {
    if (manifest[key as keyof typeof FIXED_PATHS] !== value) throw new Error("Pi distribution changed a fixed launch path");
  }
  const declaration = {
    distributionRoot: runtimeRoot,
    manifestPath: join(assets, "native-closure.json"),
    expectedClosureSha256: expectedClosure,
    executable: FIXED_PATHS.node,
    entrypoint: "pi-entry.cjs",
    fixedArguments: [],
  };
  // Both declarations must name exactly the same source-pinned bytes. Actual
  // content admission remains the descriptor-bound immutable snapshot below.
  const entries = await readNativeAcpxDistributionEntries(declaration);
  const layout = await verifyPiRuntimeLayoutForNativeSnapshot(runtimeRoot, manifest, { entries }, expectedClosure);
  if (layout.manifestDigest !== metadata.manifestDigest) throw new Error("Pi runtime manifest digest does not match its distribution");
  const native = await verifyNativeAcpxInstallation(declaration);
  return Object.freeze({
    commandDigest: profile.commandDigest,
    agentServerPackageJsonPath: join(runtimeRoot, "node_modules/pi-acp/package.json"),
    agentRuntimePackageJsonPath: join(runtimeRoot, "node_modules/@earendil-works/pi-coding-agent/package.json"),
    async openCommand() {
      await assertDirectories();
      // The native primitive reads every admitted file through held descriptors
      // into a new immutable snapshot. The bootstrap derives its own launch
      // environment from that snapshot, never these mutable installation paths.
      return native.openCommand();
    },
  });
}
