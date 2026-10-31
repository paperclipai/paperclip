import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

/**
 * How each ACPX provider's `commandDigest` attests its upstream release. Every
 * profile in acpx-profiles.json declares one kind here:
 *
 * - `installed-command`: installation hashes the upstream package's launch
 *   command and compares it with the digest (Claude, Codex).
 * - `launcher`: the SHA-256 of a launcher shipped verbatim (Grok).
 * - `closure`: upstream versions and the complete platform closure pins.
 * - `declaration`: a checked-in release declaration, hashed as canonical JSON.
 *
 * A digest changes only when the upstream release changes. It never binds
 * Paperclip source, the shared ACPX layer, absolute paths, the provider-pack
 * manifest digest or install layout: the profile's acpxVersion and the pack
 * contract digest bind ACPX and Runner source for every provider alike.
 * See rules/acpx-profile-identity.mdc.
 */
export const ACPX_RELEASE_ATTESTATIONS = Object.freeze({
  claude: { kind: "installed-command" },
  codex: { kind: "installed-command" },
  grok: { kind: "launcher", path: "src/providers/grok/launcher.cjs" },
  copilot: { kind: "closure", pins: { closure: ["copilot-closure-pins.ts", "COPILOT_CLOSURE_SHA256"] } },
  pi: { kind: "closure", pins: {
    nodeVersion: ["pi-node-pins.ts", "PI_NODE_VERSION"],
    closure: ["pi-closure-pins.ts", "PI_DISTRIBUTION_CLOSURE_SHA256"],
  } },
  cursor: { kind: "declaration", path: "cursor-contract.json", digestField: "commandDigest" },
  antigravity: { kind: "declaration", path: "antigravity-distributions.json" },
});

const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
const canonicalJson = value => value && typeof value === "object"
  ? Array.isArray(value) ? `[${value.map(canonicalJson).join(",")}]`
    : `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`
  : JSON.stringify(value);

/**
 * The release attestation for one provider, computed from a runner package
 * root, or null when installation verifies the digest instead.
 */
export async function acpxReleaseAttestation(agent, packageRoot) {
  const manifest = JSON.parse(readFileSync(resolve(packageRoot, "acpx-profiles.json"), "utf8"));
  const profile = manifest.profiles[agent];
  const attestation = Object.hasOwn(ACPX_RELEASE_ATTESTATIONS, agent) ? ACPX_RELEASE_ATTESTATIONS[agent] : undefined;
  if (!profile || !attestation) {
    throw new Error(`${agent} needs a release attestation: declare how its commandDigest attests the upstream release `
      + "in ACPX_RELEASE_ATTESTATIONS (scripts/acpx-release-attestations.mjs). See rules/acpx-profile-identity.mdc.");
  }
  switch (attestation.kind) {
    case "installed-command":
      return null;
    case "launcher":
      return { commandDigest: `sha256:${sha256(readFileSync(resolve(packageRoot, attestation.path)))}` };
    case "declaration": {
      const { [attestation.digestField]: _digest, ...declaration } = JSON.parse(readFileSync(resolve(packageRoot, attestation.path), "utf8"));
      return { commandDigest: `sha256:${sha256(canonicalJson(declaration))}`, declaration };
    }
    case "closure": {
      const declaration = {
        schema: "paperclip.acpx-release-attestation.v1", agent,
        agentProfileVersion: profile.agentProfileVersion,
        agentServerPackage: profile.agentServerPackage, agentServerVersion: profile.agentServerVersion,
        agentRuntimePackage: profile.agentRuntimePackage, agentRuntimeVersion: profile.agentRuntimeVersion,
      };
      for (const [field, [file, name]] of Object.entries(attestation.pins)) {
        // Key each import on content so a process never reuses pins from edited bytes.
        const path = resolve(packageRoot, "src/drivers/acpx", file);
        declaration[field] = (await import(`${pathToFileURL(path).href}?sha256=${sha256(readFileSync(path))}`))[name];
      }
      return { commandDigest: `sha256:${sha256(canonicalJson(declaration))}`, declaration };
    }
    default:
      throw new Error(`${agent} declares an unknown release attestation kind: ${attestation.kind}`);
  }
}
