import { createHash } from "node:crypto";
import profiles from "../acpx-profiles.json" with { type: "json" };
import distributions from "../cursor-distributions.json" with { type: "json" };

const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(",")}]`
  : value && typeof value === "object" ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`
    : JSON.stringify(value);

/** Release assembly must reject a self-consistent pack built for another release. */
export function verifyReleaseProviderPack(identity, sourceRevision) {
  const payload = identity?.payload;
  if (identity?.schema !== "paperclip-runner/remote-provider-pack/v1" || !payload
    || payload.target?.platform !== "linux" || payload.target?.architecture !== "x64"
    || payload.runnerSourceRevision !== sourceRevision) throw new Error("Remote provider pack must match the release source and Linux x64 target");
  if (identity.digest !== `sha256:${createHash("sha256").update(canonical(payload)).digest("hex")}`) {
    throw new Error("Remote provider-pack payload digest mismatch");
  }
  if (payload.pins?.acpx !== profiles.acpxVersion
    || ["grok", "claude", "codex"].some(agent => payload.acpxProfileDigests?.[agent] !== profiles.profiles[agent].commandDigest)) {
    throw new Error("Remote provider-pack ACPX profiles do not match this release");
  }
  const current = profiles.profiles.cursor;
  for (const cursor of [payload.providers?.cursor, ...(Object.hasOwn(payload.candidateProviders ?? {}, "cursor") ? [payload.candidateProviders.cursor] : [])]) {
    if (!cursor || cursor.version !== current.agentServerVersion || cursor.profileDigest !== current.commandDigest
      || cursor.closureDigest !== `sha256:${distributions.platforms["linux-x64"].closureSha256}`
      || cursor.qualification !== "qualified" || cursor.path !== "provider-assets/cursor/linux-x64"
      || !/^sha256:[a-f0-9]{64}$/.test(cursor.sha256 ?? "")) {
      throw new Error("Remote provider-pack Cursor identity does not match this release");
    }
  }
  const copilot = payload.providers?.copilot;
  const copilotProfile = profiles.profiles.copilot;
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
