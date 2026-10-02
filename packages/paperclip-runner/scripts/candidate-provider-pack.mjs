const CANDIDATES = new Set(["cursor", "copilot", "pi"]);

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
  throw new Error(`The ${provider} candidate distribution builder is not included in this source revision`);
}
