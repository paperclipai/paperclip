import { materializePiDistribution } from "./materialize-pi-distribution.mjs";
import { materializePinnedCursorDistribution } from "./materialize-cursor-distribution.mjs";
const CANDIDATES = new Set(["cursor", "copilot", "pi"]);

/** Pi ships by default; the diagnostic option remains compatible with old callers. */
export function providerPackSelections(candidates) {
  if (candidates.some(provider => !CANDIDATES.has(provider)) || new Set(candidates).size !== candidates.length) {
    throw new Error("Unknown or duplicate candidate provider");
  }
  return [
    { provider: "pi", qualification: "qualified" },
    ...candidates.filter(provider => provider !== "pi").map(provider => ({ provider, qualification: "pending" })),
  ];
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
      profileDigest: "sha256:13207d7b6afcfe681d4fe9098655df056c2cf87e03f5141e961cd01c32c5bdd2",
      closureDigest: `sha256:${result.closureSha256}` };
  }
  throw new Error(`The ${provider} candidate distribution builder is not included in this source revision`);
}
