import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { join } from "node:path";
import { verifyNativeAcpxInstallation, type VerifiedAcpxInstallation } from "./installation-integrity.js";
import { KIMI_DISTRIBUTION_CLOSURE_SHA256, KIMI_DISTRIBUTION_LOCK_SHA256, KIMI_NODE_VERSION, KIMI_RUNTIME_VERSION } from "./kimi-closure-pins.js";
import { resolveRunnerProviderAssetsRoot } from "./provider-assets-root.js";
import { QUALIFIED_ACPX_PROFILES, type AcpxReleaseProfile } from "./qualified-profiles.js";

export function assertKimiInstallationProfile(profile: AcpxReleaseProfile): void {
  const trusted = QUALIFIED_ACPX_PROFILES.kimi;
  for (const key of ["agent", "driverKind", "protocolVersion", "acpxVersion", "agentProfileVersion", "agentServerPackage", "agentServerVersion", "agentRuntimePackage", "agentRuntimeVersion", "commandDigest", "permissionPolicy"] as const) {
    if (profile[key] !== trusted[key]) throw new Error("Kimi distribution profile differs from its trusted declaration");
  }
  if (profile.agentServerPackage !== "@moonshot-ai/kimi-code" || profile.agentServerVersion !== KIMI_RUNTIME_VERSION || profile.permissionPolicy !== "interactive") throw new Error("Kimi distribution profile has an unsupported runtime");
}

async function readMetadata(path: string): Promise<Record<string, unknown>> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await file.stat({ bigint: true });
    if (!before.isFile() || before.nlink !== 1n || before.size < 1n || before.size > 64n * 1024n) throw new Error("Kimi distribution metadata is not a bounded regular file");
    const bytes = await file.readFile();
    const after = await file.stat({ bigint: true });
    const named = await lstat(path, { bigint: true });
    if (bytes.length !== Number(before.size) || before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs || named.dev !== before.dev || named.ino !== before.ino || named.isSymbolicLink()) throw new Error("Kimi distribution metadata changed while read");
    const value: unknown = JSON.parse(bytes.toString("utf8"));
    if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("Kimi distribution metadata is invalid");
    return value as Record<string, unknown>;
  } finally { await file.close(); }
}

export async function verifyKimiInstallation(profile: AcpxReleaseProfile): Promise<VerifiedAcpxInstallation> {
  assertKimiInstallationProfile(profile);
  const target = `${process.platform}-${process.arch}`;
  if (!Object.hasOwn(KIMI_DISTRIBUTION_CLOSURE_SHA256, target)) throw new Error(`Kimi runtime target is unsupported: ${target}`);
  const expectedClosureSha256 = KIMI_DISTRIBUTION_CLOSURE_SHA256[target as keyof typeof KIMI_DISTRIBUTION_CLOSURE_SHA256];
  const assets = join(resolveRunnerProviderAssetsRoot(import.meta.url, "kimi"), target);
  const distributionRoot = join(assets, "runtime");
  const assertDirectories = async (): Promise<void> => {
    for (const path of [assets, distributionRoot]) {
      const stat = await lstat(path);
      if (!stat.isDirectory() || stat.isSymbolicLink() || await realpath(path) !== path) throw new Error("Kimi runtime escaped its fixed asset directory");
    }
  };
  try { await assertDirectories(); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error("Kimi runtime is not installed on this host; run paperclipai runtime setup kimi before selecting Kimi Code");
    throw error;
  }
  const metadata = await readMetadata(join(assets, "kimi-distribution.json"));
  const entrypoint = "node_modules/@moonshot-ai/kimi-code/dist/main.mjs";
  if (metadata.schema !== "paperclip.kimi-distribution.v1" || metadata.version !== KIMI_RUNTIME_VERSION || metadata.target !== target || metadata.nodeVersion !== KIMI_NODE_VERSION || metadata.runtimeRoot !== "runtime" || metadata.entrypoint !== entrypoint || metadata.lockSha256 !== KIMI_DISTRIBUTION_LOCK_SHA256 || metadata.nativeClosureSha256 !== expectedClosureSha256) throw new Error("Kimi distribution metadata differs from its source-owned pin");
  const native = await verifyNativeAcpxInstallation({
    distributionRoot,
    manifestPath: join(assets, "native-closure.json"),
    expectedClosureSha256,
    executable: "node/bin/node",
    entrypoint,
    fixedArguments: ["acp"],
  });
  return Object.freeze({
    commandDigest: profile.commandDigest,
    agentServerPackageJsonPath: join(distributionRoot, "node_modules/@moonshot-ai/kimi-code/package.json"),
    agentRuntimePackageJsonPath: null,
    async openCommand(options?: { signal?: AbortSignal }) {
      options?.signal?.throwIfAborted();
      await assertDirectories();
      return native.openCommand(options);
    },
  });
}
