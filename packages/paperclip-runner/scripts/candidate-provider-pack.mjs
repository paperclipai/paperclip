import { materializePiDistribution } from "./materialize-pi-distribution.mjs";
import profiles from "../acpx-profiles.json" with { type: "json" };
import { materializePinnedCursorDistribution } from "./materialize-cursor-distribution.mjs";
const CANDIDATES = new Set(["cursor", "copilot", "pi"]);

/** Only materialized providers enter the serialized manifest and its digest. */
export function providerPackManifestFields(providers, candidates) {
  return {
    ...(["pi", "cursor", "copilot"].some(provider => providers[provider]) ? { providers: Object.fromEntries(["pi", "cursor", "copilot"].filter(provider => providers[provider]).map(provider => [provider, providers[provider]])) } : {}),
    ...(["pi", ...candidates].some(provider => provider !== "copilot" && providers[provider]) ? { candidateProviders: Object.fromEntries([...new Set(["pi", ...candidates])].filter(provider => provider !== "copilot" && providers[provider]).map(provider => [provider, providers[provider]])) } : {}),
  };
}

export function providerPackProviders(platform, architecture, candidates) {
  const nativeSupported = ["darwin-arm64", "darwin-x64", "linux-x64"].includes(`${platform}-${architecture}`);
  return [...new Set([...(nativeSupported ? ["pi", "cursor", "copilot"] : []), ...candidates])];
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
  if (provider === "pi") return materializePiDistribution({ outputRoot });
  if (provider === "copilot") {
    const { buildPinnedCopilotDistribution } = await import("./build-copilot-distribution.mjs");
    return buildPinnedCopilotDistribution({ outputRoot });
  }
  if (provider === "cursor") {
    const result = await materializePinnedCursorDistribution({ destination: outputRoot });
    return { version: result.version,
      profileDigest: profiles.profiles.cursor.commandDigest,
      closureDigest: `sha256:${result.closureSha256}` };
  }
  throw new Error(`The ${provider} candidate distribution builder is not included in this source revision`);
}
