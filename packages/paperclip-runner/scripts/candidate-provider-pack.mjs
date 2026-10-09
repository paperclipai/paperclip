import profiles from "../acpx-profiles.json" with { type: "json" };
import { materializePinnedCursorDistribution } from "./materialize-cursor-distribution.mjs";
import { cp, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const CANDIDATES = new Set(["cursor", "copilot", "pi", "hermes"]);

/** Only materialized providers enter the serialized manifest and its digest. */
export function providerPackManifestFields(providers, candidates) {
  return {
    ...(providers.cursor ? { providers: { cursor: providers.cursor } } : {}),
    ...(candidates.length ? { candidateProviders: Object.fromEntries(candidates.map(provider => [provider, providers[provider]])) } : {}),
  };
}

export function providerPackProviders(platform, architecture, candidates) {
  const cursorSupported = ["darwin-arm64", "darwin-x64", "linux-x64"].includes(`${platform}-${architecture}`);
  return [...new Set([...(cursorSupported ? ["cursor"] : []), ...candidates])];
}

export function parseProviderPackArguments(args) {
  let output;
  const candidates = [];
  for (const value of args.filter(value => value !== "--")) {
    if (value.startsWith("--candidate-providers=")) {
      for (const provider of value.slice("--candidate-providers=".length).split(",").filter(Boolean)) {
        if (!CANDIDATES.has(provider) || candidates.includes(provider)) throw new Error("Unknown or duplicate candidate provider");
        candidates.push(provider);
      }
    } else if (value.startsWith("--") || output !== undefined) throw new Error("Invalid provider-pack arguments");
    else output = value;
  }
  return { output, candidates };
}

/** Closed source-owned builder registry; provider branches add their exact pins. */
export async function materializeCandidateProviderPack({ provider, outputRoot }) {
  if (!CANDIDATES.has(provider)) throw new Error("Unknown candidate provider");
  if (provider === "cursor") {
    const result = await materializePinnedCursorDistribution({ destination: outputRoot });
    return { version: result.version,
      profileDigest: profiles.profiles.cursor.commandDigest,
      closureDigest: `sha256:${result.closureSha256}` };
  }
  if (provider === "hermes") {
    const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
    const { resolveQualifiedAcpxProfile } = await import("../dist/drivers/acpx/qualified-profiles.js");
    const { HERMES_CLOSURES } = await import("../dist/drivers/acpx/hermes-installation.js");
    const profile = resolveQualifiedAcpxProfile("hermes", "distribution-verification");
    const platform = `${process.platform}-${process.arch}`;
    if (!HERMES_CLOSURES[platform]) throw new Error(`Hermes has no reviewed distribution for ${platform}`);
    await mkdir(dirname(outputRoot), { recursive: true });
    await cp(resolve(root, "provider-assets/hermes", platform), outputRoot, { recursive: true, errorOnExist: true, force: false });
    const { verifyNativeAcpxInstallation } = await import("../dist/drivers/acpx/installation-integrity.js");
    const installation = await verifyNativeAcpxInstallation({ distributionRoot: outputRoot,
      manifestPath: resolve(outputRoot, "manifest.json"), expectedClosureSha256: HERMES_CLOSURES[platform],
      executable: "python/bin/python3.12", pythonEntrypoint: "entry.py", fixedArguments: [] });
    const lease = await installation.openCommand();
    // Packaging verifies all bytes without executing tools. The actual execution
    // host must pass its sandbox probe before any credential is staged.
    await lease.close();
    return { version: "v2026.9.24", profileDigest: profile.commandDigest, closureDigest: `sha256:${HERMES_CLOSURES[platform]}` };
  }
  throw new Error(`The ${provider} candidate distribution builder is not included in this source revision`);
}
