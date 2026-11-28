import { createHash } from "node:crypto";
import profiles from "../acpx-profiles.json" with { type: "json" };
import distributions from "../cursor-distributions.json" with { type: "json" };
import antigravityDistributions from "../antigravity-distributions.json" with { type: "json" };
import { KIMI_DISTRIBUTION_CLOSURE_SHA256 as kimiClosures } from "../src/drivers/acpx/kimi-closure-pins.ts";

const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(",")}]`
  : value && typeof value === "object" ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`
    : JSON.stringify(value);

/** Release assembly must reject a self-consistent pack built for another release. */
export function verifyReleaseProviderPack(identity, sourceRevision, target = "linux-x64", expected = { profiles, distributions, kimiClosures, antigravityDistributions }) {
  const { profiles: releaseProfiles, distributions: releaseDistributions } = expected;
  const payload = identity?.payload;
  if (identity?.schema !== "paperclip-runner/remote-provider-pack/v1" || !payload
    || !["linux-x64", "linux-arm64"].includes(target)
    || payload.target?.platform !== "linux" || `linux-${payload.target?.architecture}` !== target
    || payload.runnerSourceRevision !== sourceRevision) throw new Error(`Remote provider pack must match the release source and ${target === "linux-x64" ? "Linux x64" : target} target`);
  if (identity.digest !== `sha256:${createHash("sha256").update(canonical(payload)).digest("hex")}`) {
    throw new Error("Remote provider-pack payload digest mismatch");
  }
  if (payload.pins?.acpx !== releaseProfiles.acpxVersion
    || ["grok", "claude", "codex"].some(agent => payload.acpxProfileDigests?.[agent] !== releaseProfiles.profiles[agent].commandDigest)) {
    throw new Error("Remote provider-pack ACPX profiles do not match this release");
  }
  if (target === "linux-arm64") {
    if (Object.keys(payload.providers ?? {}).length || Object.keys(payload.candidateProviders ?? {}).length) {
      throw new Error("Linux ARM64 pack must not expand other providers qualification");
    }
    return identity;
  }
  const current = releaseProfiles.profiles.cursor;
  for (const cursor of [payload.providers?.cursor, ...(Object.hasOwn(payload.candidateProviders ?? {}, "cursor") ? [payload.candidateProviders.cursor] : [])]) {
    if (!cursor || cursor.version !== current.agentServerVersion || cursor.profileDigest !== current.commandDigest
      || cursor.closureDigest !== `sha256:${releaseDistributions.platforms["linux-x64"].closureSha256}`
      || cursor.qualification !== "qualified" || cursor.path !== "provider-assets/cursor/linux-x64"
      || !/^sha256:[a-f0-9]{64}$/.test(cursor.sha256 ?? "")) {
      throw new Error("Remote provider-pack Cursor identity does not match this release");
    }
  }
  const copilot = payload.providers?.copilot;
  const copilotProfile = releaseProfiles.profiles.copilot;
  if (Object.hasOwn(payload.candidateProviders ?? {}, "copilot") || !copilot
    || copilot.version !== copilotProfile.agentServerVersion || copilot.profileDigest !== copilotProfile.commandDigest
    || copilot.closureDigest !== "sha256:a3d8f4367cfa1694d79e3f8b7930b6fbfe42a229c272b375b11951d631db8d07"
    || copilot.qualification !== "qualified" || copilot.path !== "provider-assets/copilot/linux-x64"
    || Object.keys(copilot).sort().join(",") !== "closureDigest,path,profileDigest,qualification,sha256,version"
    || !/^sha256:[a-f0-9]{64}$/.test(copilot.sha256 ?? "")) {
    throw new Error("Remote provider-pack Copilot identity does not match this release");
  }
  const kimiProfile = releaseProfiles.profiles.kimi;
  if (kimiProfile && kimiProfile.qualificationStatus !== "pending") {
    const releaseKimiClosures = expected.kimiClosures
      ?? (kimiProfile.commandDigest === profiles.profiles.kimi.commandDigest ? kimiClosures : undefined);
    const kimi = payload.providers?.kimi;
    if (Object.hasOwn(payload.candidateProviders ?? {}, "kimi") || !kimi
      || kimi.version !== kimiProfile.agentServerVersion || kimi.profileDigest !== kimiProfile.commandDigest
      || !/^[a-f0-9]{64}$/.test(releaseKimiClosures?.["linux-x64"] ?? "")
      || kimi.closureDigest !== `sha256:${releaseKimiClosures["linux-x64"]}`
      || kimi.qualification !== "qualified" || kimi.path !== "provider-assets/kimi/linux-x64"
      || Object.keys(kimi).sort().join(",") !== "closureDigest,path,profileDigest,qualification,sha256,version"
      || !/^sha256:[a-f0-9]{64}$/.test(kimi.sha256 ?? "")) {
      throw new Error("Remote provider-pack Kimi identity does not match this release");
    }
  }
  const antigravityProfile = releaseProfiles.profiles.antigravity;
  verifyReleaseAntigravity(payload, antigravityProfile, expected.antigravityDistributions
    ?? (antigravityProfile?.commandDigest === profiles.profiles.antigravity.commandDigest ? antigravityDistributions : undefined));
  return identity;
}

/** A released profile requires exactly one ordinary entry; a pending one at
 * most one candidate. Either way the closure is the release's frozen PATCHED
 * Linux closure, never the vendor closure. */
function verifyReleaseAntigravity(payload, profile, frozen) {
  const ordinary = payload.providers?.antigravity, candidate = payload.candidateProviders?.antigravity;
  const mismatch = () => { throw new Error("Remote provider-pack Antigravity identity does not match this release"); };
  if (!profile) return ordinary || candidate ? mismatch() : undefined;
  const pending = profile.qualificationStatus === "pending";
  const entry = pending ? candidate : ordinary;
  if ((pending ? ordinary : candidate) || (!pending && !entry)) mismatch();
  if (!entry) return;
  const platform = frozen?.platforms?.["linux-x64"];
  if (frozen?.schema !== "paperclip.antigravity_distribution.v1" || frozen.version !== profile.agentServerVersion
    || platform?.provisioning !== "verified-closure" || !/^[a-f0-9]{64}$/.test(platform.closureSha256 ?? "")
    || platform.closureSha256 === platform.vendorClosureSha256
    || entry.version !== profile.agentServerVersion || entry.profileDigest !== profile.commandDigest
    || entry.closureDigest !== `sha256:${platform.closureSha256}`
    || entry.qualification !== (pending ? "pending" : "qualified") || entry.path !== "provider-assets/antigravity/linux-x64"
    || Object.keys(entry).sort().join(",") !== "closureDigest,path,profileDigest,qualification,sha256,version"
    || !/^sha256:[a-f0-9]{64}$/.test(entry.sha256 ?? "")) mismatch();
}
