import { materializePiDistribution } from "./materialize-pi-distribution.mjs";
import profiles from "../acpx-profiles.json" with { type: "json" };
import { materializePinnedCursorDistribution } from "./materialize-cursor-distribution.mjs";
const CANDIDATES = new Set(["cursor", "copilot", "pi", "kimi", "antigravity"]);
const releasedKimi = () => profiles.profiles.kimi.qualificationStatus !== "pending";
// The flip to an ordinary provider is the profile's qualificationStatus alone.
const releasedAntigravity = () => profiles.profiles.antigravity.qualificationStatus !== "pending";
// Remote packs carry Antigravity only for the Daytona image target.
export const ANTIGRAVITY_PACK_TARGETS = Object.freeze(["linux-x64"]);
const ordinaryProviders = () => ["pi", "cursor", "copilot", ...(releasedKimi() ? ["kimi"] : []), ...(releasedAntigravity() ? ["antigravity"] : [])];
const ordinaryOnly = provider => provider === "copilot" || (provider === "kimi" && releasedKimi()) || (provider === "antigravity" && releasedAntigravity());

/** The manifest qualification the server admits for each materialized provider. */
export function providerPackQualification(provider) {
  return ["pi", "cursor", "copilot"].includes(provider) || ordinaryOnly(provider) ? "qualified" : "pending";
}

/** Only materialized providers enter the serialized manifest and its digest. */
export function providerPackManifestFields(providers, candidates) {
  const ordinary = ordinaryProviders().filter(provider => providers[provider]);
  const candidate = [...new Set(["pi", ...candidates])].filter(provider => !ordinaryOnly(provider) && providers[provider]);
  return {
    ...(ordinary.length ? { providers: Object.fromEntries(ordinary.map(provider => [provider, providers[provider]])) } : {}),
    ...(candidate.length ? { candidateProviders: Object.fromEntries(candidate.map(provider => [provider, providers[provider]])) } : {}),
  };
}

export function providerPackProviders(platform, architecture, candidates) {
  const target = `${platform}-${architecture}`;
  const nativeSupported = ["darwin-arm64", "darwin-x64", "linux-x64"].includes(target);
  const kimiSupported = ["darwin-arm64", "linux-x64"].includes(target);
  const antigravitySupported = ANTIGRAVITY_PACK_TARGETS.includes(target);
  if (candidates.includes("antigravity") && !antigravitySupported) {
    throw new Error(`Antigravity provider-pack assets are built only for ${ANTIGRAVITY_PACK_TARGETS.join(", ")}`);
  }
  return [...new Set([...(nativeSupported ? ["pi", "cursor", "copilot"] : []), ...(releasedKimi() && kimiSupported ? ["kimi"] : []),
    ...(releasedAntigravity() && antigravitySupported ? ["antigravity"] : []), ...candidates])];
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

// The ~274 MB public archive is the only network step of an Antigravity pack
// build. Repeat only a transport failure; an integrity failure is final.
const transientDownload = error => error?.name === "TimeoutError" || error?.name === "AbortError"
  || /Antigravity archive download failed: (?:408|429|5\d\d)|fetch failed|ECONNRESET|ETIMEDOUT|EAI_AGAIN|socket|terminated/i.test(String(error?.message));

/** The PATCHED closure (never the vendor closure) for this build host's target. */
export async function materializeAntigravityProviderPack({ outputRoot, platform = process.platform, architecture = process.arch,
  materialize, attempts = 3, retryDelayMs = 5_000 }) {
  if (!ANTIGRAVITY_PACK_TARGETS.includes(`${platform}-${architecture}`)) {
    throw new Error(`Antigravity provider-pack assets are built only for ${ANTIGRAVITY_PACK_TARGETS.join(", ")}`);
  }
  materialize ??= (await import("./materialize-antigravity-distribution.mjs")).materializePinnedAntigravityDistribution;
  let result;
  for (let attempt = 1; ; attempt++) {
    try { result = await materialize({ destination: outputRoot, platform, architecture }); break; }
    catch (error) {
      if (attempt >= attempts || !transientDownload(error)) throw error;
      process.stderr.write(`Antigravity archive download attempt ${attempt} failed; retrying\n`);
      await new Promise(resolve => setTimeout(resolve, retryDelayMs * attempt));
    }
  }
  const profile = profiles.profiles.antigravity;
  if (result?.version !== profile.agentServerVersion || !/^[a-f0-9]{64}$/.test(result.closureSha256 ?? "")
    || result.closureSha256 === result.vendorClosureSha256 || !result.patchVersion) {
    throw new Error("Antigravity provider pack requires this release's patched runtime closure");
  }
  return { version: result.version, profileDigest: profile.commandDigest, closureDigest: `sha256:${result.closureSha256}` };
}

/** Closed source-owned builder registry; provider branches add their exact pins. */
export async function materializeCandidateProviderPack({ provider, outputRoot }) {
  if (!CANDIDATES.has(provider)) throw new Error("Unknown candidate provider");
  if (provider === "kimi") {
    const { materializeKimiDistribution } = await import("./materialize-kimi-distribution.mjs");
    const result = await materializeKimiDistribution({ outputRoot });
    return { version: result.version, profileDigest: profiles.profiles.kimi.commandDigest, closureDigest: result.closureDigest };
  }
  if (provider === "antigravity") return materializeAntigravityProviderPack({ outputRoot });
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
