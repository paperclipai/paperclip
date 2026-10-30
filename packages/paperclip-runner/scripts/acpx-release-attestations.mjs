import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

// Copilot, Grok and Pi profile identities attest upstream releases, like Claude,
// Codex, Cursor and Antigravity. They bind upstream versions and the bytes a
// repackager copies verbatim: complete platform closures and Grok's launcher.
// Never bind Paperclip source, the shared ACPX layer, absolute paths, the
// provider-pack manifest digest or install layout. The profile's acpxVersion and
// the pack contract digest bind ACPX and Runner source for every harness alike.
export const ATTESTED_ACPX_AGENTS = Object.freeze(["copilot", "grok", "pi"]);

const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
const canonicalJson = value => value && typeof value === "object"
  ? Array.isArray(value) ? `[${value.map(canonicalJson).join(",")}]`
    : `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`
  : JSON.stringify(value);

/** The release attestation for one provider, computed from a runner package root. */
export async function acpxReleaseAttestation(agent, packageRoot) {
  const manifest = JSON.parse(readFileSync(resolve(packageRoot, "acpx-profiles.json"), "utf8"));
  const profile = manifest.profiles[agent];
  if (!ATTESTED_ACPX_AGENTS.includes(agent) || !profile) throw new Error(`No upstream release attestation for ${agent}`);
  // Grok keeps its physical byte-digest contract: admission hashes the launcher.
  if (agent === "grok") {
    return { commandDigest: `sha256:${sha256(readFileSync(resolve(packageRoot, "src/providers/grok/launcher.cjs")))}` };
  }
  // Key each import on content so a process never reuses pins from edited bytes.
  const pins = async file => {
    const path = resolve(packageRoot, "src/drivers/acpx", file);
    return import(`${pathToFileURL(path).href}?sha256=${sha256(readFileSync(path))}`);
  };
  const declaration = {
    schema: "paperclip.acpx-release-attestation.v1", agent,
    agentProfileVersion: profile.agentProfileVersion,
    agentServerPackage: profile.agentServerPackage, agentServerVersion: profile.agentServerVersion,
    agentRuntimePackage: profile.agentRuntimePackage, agentRuntimeVersion: profile.agentRuntimeVersion,
    ...agent === "copilot"
      ? { closure: (await pins("copilot-closure-pins.ts")).COPILOT_CLOSURE_SHA256 }
      : { nodeVersion: (await pins("pi-node-pins.ts")).PI_NODE_VERSION, closure: (await pins("pi-closure-pins.ts")).PI_DISTRIBUTION_CLOSURE_SHA256 },
  };
  return { commandDigest: `sha256:${sha256(canonicalJson(declaration))}`, declaration };
}
