import { KIMI_DISTRIBUTION_CLOSURE_SHA256 } from "../src/drivers/acpx/kimi-closure-pins.ts";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { ACPX_RELEASE_ATTESTATIONS, acpxReleaseAttestation } from "./acpx-release-attestations.mjs";

const root = new URL("../", import.meta.url);
const readJson = async path => JSON.parse(await readFile(new URL(path, root), "utf8"));
const manifest = await readJson("acpx-profiles.json");
const distributions = await readJson("cursor-distributions.json");
const antigravityDistributions = await readJson("antigravity-distributions.json");
const pkg = await readJson("package.json");
assert.equal(manifest.schema, "paperclip.acpx-profiles.v1");
assert.equal(manifest.acpxVersion, pkg.dependencies.acpx);
// Every profile's commandDigest attests its upstream release, so it changes only
// when that release changes. Installation verifies installed-command digests.
const check = process.argv.includes("--check");
const writes = new Map();
for (const agent of Object.keys(manifest.profiles)) {
  const attestation = await acpxReleaseAttestation(agent, fileURLToPath(root));
  if (!attestation) continue;
  // A release declaration may carry its own copy of the digest; keep it in step.
  const { path, digestField } = ACPX_RELEASE_ATTESTATIONS[agent];
  const declaration = digestField ? await readJson(path) : null;
  if (manifest.profiles[agent].commandDigest === attestation.commandDigest
    && (!declaration || declaration[digestField] === attestation.commandDigest)) continue;
  assert.ok(!check, `${agent} commandDigest no longer matches its upstream release attestation. `
    + "Run `pnpm --filter @paperclipai/paperclip-runner generate:acpx-profiles`; an upstream change keeps the profile version.");
  manifest.profiles[agent].commandDigest = attestation.commandDigest;
  writes.set("acpx-profiles.json", manifest);
  if (declaration) writes.set(path, { ...declaration, [digestField]: attestation.commandDigest });
}
for (const [path, value] of writes) await writeFile(new URL(path, root), `${JSON.stringify(value, null, 2)}\n`);
const contract = await readJson("cursor-contract.json");
const entries = Object.entries(manifest.profiles);
for (const [agent, profile] of entries) {
  assert.match(agent, /^[a-z]+$/);
  assert.ok(Number.isSafeInteger(profile.agentProfileVersion) && profile.agentProfileVersion > 0);
  for (const key of ["agentServerPackage", "agentServerVersion"]) assert.ok(typeof profile[key] === "string" && profile[key].length > 0);
  assert.equal(profile.agentRuntimePackage === null, profile.agentRuntimeVersion === null);
  assert.match(profile.commandDigest, /^sha256:[a-f0-9]{64}$/);
  assert.equal(typeof profile.requiresProviderPolicy, "boolean");
  assert.ok([undefined, "pending"].includes(profile.qualificationStatus));
  for (const [name, version] of [[profile.agentServerPackage, profile.agentServerVersion], [profile.agentRuntimePackage, profile.agentRuntimeVersion]]) {
    if (name && Object.hasOwn(pkg.dependencies, name)) assert.equal(version, pkg.dependencies[name], `${agent}: installed dependency drift`);
  }
}
// Release declarations must agree with the profiles they attest.
assert.equal(manifest.profiles.cursor.agentServerVersion, distributions.version);
assert.equal(manifest.profiles.cursor.agentServerVersion, contract.vendor);
assert.equal(manifest.profiles.cursor.agentProfileVersion, contract.profileVersion);
assert.equal(contract.commandDigest, manifest.profiles.cursor.commandDigest, "cursor-contract.json carries a stale commandDigest");
assert.equal(distributions.patchVersion, contract.nativePatch);
assert.equal(manifest.profiles.antigravity.agentServerVersion, antigravityDistributions.version);
for (const distribution of Object.values(distributions.platforms)) assert.match(distribution.closureSha256, /^[a-f0-9]{64}$/);

const quote = JSON.stringify;
const profiles = Object.fromEntries(entries.map(([agent, declaration]) => {
  const { requiresProviderPolicy, ...runtime } = declaration;
  return [agent, {
    driverKind: manifest.driverKind, protocolVersion: manifest.protocolVersion,
    acpxVersion: manifest.acpxVersion, agent, ...runtime,
    permissionPolicy: "interactive",
  }];
}));
const header = "Generated from acpx-profiles.json and cursor-distributions.json. Do not edit.";
const typescript = `// ${header}
export const QUALIFIED_ACPX_VERSION = ${quote(manifest.acpxVersion)} as const;
export const ACPX_DRIVER_KIND = ${quote(manifest.driverKind)} as const;
export const ACPX_DRIVER_PROTOCOL_VERSION = ${manifest.protocolVersion} as const;

export const QUALIFIED_ACPX_PROFILE_DATA = ${JSON.stringify(profiles, null, 2)} as const;

export const CURSOR_DISTRIBUTION_PINS = ${JSON.stringify(Object.fromEntries(Object.entries(distributions.platforms).map(([platform, { closureSha256, executable, entrypoint }]) => [platform, { closureSha256, executable, entrypoint }])), null, 2)} as const;

export const ANTIGRAVITY_DISTRIBUTION_PINS = ${JSON.stringify(Object.fromEntries(Object.entries(antigravityDistributions.platforms).filter(([, pin]) => pin.provisioning === "verified-closure").map(([platform, { closureSha256, executable, args }]) => [platform, { closureSha256, executable, args }])), null, 2)} as const;
`;
const option = value => value === null ? "None" : `Some(${quote(value)})`;
const rust = `// ${header}
pub(crate) const QUALIFIED_ACPX_VERSION: &str = ${quote(manifest.acpxVersion)};
pub(crate) const ACPX_DRIVER_KIND: &str = ${quote(manifest.driverKind)};

#[derive(Debug)]
pub(crate) struct AcpxReleaseProfile {
    pub agent_server_package: &'static str,
    pub agent_server_version: &'static str,
    pub agent_runtime_package: Option<&'static str>,
    pub agent_runtime_version: Option<&'static str>,
    pub command_digest: &'static str,
    pub requires_provider_policy: bool,
    pub qualification_pending: bool,
}

pub(crate) fn kimi_native_closure(platform: &str, architecture: &str) -> Option<&'static str> {
    match (platform, architecture) {
${Object.entries(KIMI_DISTRIBUTION_CLOSURE_SHA256).map(([target, digest]) => { const [platform, architecture] = target.split("-"); return `        (${quote(platform)}, ${quote(architecture)}) => {\n            Some(${quote(digest)})\n        }`; }).join("\n")}
        _ => None,
    }
}

pub(crate) fn acpx_release_profile(agent: &str) -> Option<AcpxReleaseProfile> {
    Some(match agent {
${entries.map(([agent, p]) => `        ${quote(agent)} => AcpxReleaseProfile {
            agent_server_package: ${quote(p.agentServerPackage)},
            agent_server_version: ${quote(p.agentServerVersion)},
            agent_runtime_package: ${option(p.agentRuntimePackage)},
            agent_runtime_version: ${option(p.agentRuntimeVersion)},
            command_digest:
                ${quote(p.commandDigest)},
            requires_provider_policy: ${p.requiresProviderPolicy},
            qualification_pending: ${p.qualificationStatus === "pending"},
        },`).join("\n")}
        _ => return None,
    })
}
`;

for (const [path, content] of [
  ["src/drivers/acpx/generated-profiles.ts", typescript],
  ["runner/crates/runner-core/src/generated_acpx_profiles.rs", rust],
]) {
  const url = new URL(path, root);
  if (check) {
    assert.equal(await readFile(url, "utf8"), content, `Stale ACPX profiles: ${fileURLToPath(url)}; run generate:acpx-profiles`);
  } else await writeFile(url, content);
}
console.log("TypeScript/Rust ACPX profiles match the release manifest.");
