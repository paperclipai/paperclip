import { createHash } from "node:crypto";
import profiles from "../acpx-profiles.json" with { type: "json" };
import distributions from "../cursor-distributions.json" with { type: "json" };

const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(",")}]`
  : value && typeof value === "object" ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`
    : JSON.stringify(value);

/** Release assembly must reject a self-consistent pack built for another release. */
export function verifyReleaseProviderPack(identity, sourceRevision, target = "linux-x64", expected = { profiles, distributions }) {
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
  return identity;
}
