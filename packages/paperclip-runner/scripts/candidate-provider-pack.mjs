import profiles from "../acpx-profiles.json" with { type: "json" };
import { materializePinnedCursorDistribution } from "./materialize-cursor-distribution.mjs";
const CANDIDATES = new Set(["cursor", "copilot", "pi"]);

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
  throw new Error(`The ${provider} candidate distribution builder is not included in this source revision`);
}
