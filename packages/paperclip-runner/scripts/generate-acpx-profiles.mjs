import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const root = new URL("../", import.meta.url);
const readJson = async path => JSON.parse(await readFile(new URL(path, root), "utf8"));
const manifest = await readJson("acpx-profiles.json");
const distributions = await readJson("cursor-distributions.json");
const contract = await readJson("cursor-contract.json");
const pkg = await readJson("package.json");
assert.equal(manifest.schema, "paperclip.acpx-profiles.v1");
assert.equal(manifest.acpxVersion, pkg.dependencies.acpx);
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
// The Cursor contract is an immutable release attestation, not another runtime
// lookup table. Refuse generation if a release declaration disagrees with it.
assert.equal(manifest.profiles.cursor.agentServerVersion, distributions.version);
assert.equal(manifest.profiles.cursor.agentServerVersion, contract.vendor);
assert.equal(manifest.profiles.cursor.agentProfileVersion, contract.profileVersion);
assert.equal(manifest.profiles.cursor.commandDigest, contract.commandDigest);
assert.equal(distributions.patchVersion, contract.nativePatch);
const canonicalJson = value => value && typeof value === "object"
  ? Array.isArray(value) ? `[${value.map(canonicalJson).join(",")}]`
    : `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`
  : JSON.stringify(value);
const { commandDigest, ...attestation } = contract;
assert.equal(commandDigest, `sha256:${createHash("sha256").update(canonicalJson(attestation)).digest("hex")}`);
assert.equal(contract.acpxPatchSha256, createHash("sha256")
  .update(await readFile(new URL("../../patches/acpx@0.13.1.patch", root))).digest("hex"));
for (const [agent, path] of [["pi", "test-fixtures/pi-acp/profile-v22-identity.json"], ["copilot", "test/fixtures/copilot-profile-v38-identity.json"]]) {
  const identity = await readJson(path);
  assert.equal(manifest.profiles[agent].agentProfileVersion, identity.declaration.agentProfileVersion);
  assert.equal(manifest.profiles[agent].commandDigest, identity.commandDigest);
  const serialized = agent === "pi" ? canonicalJson(identity.declaration)
    : JSON.stringify(Object.fromEntries(Object.entries(identity.declaration).sort(([a], [b]) => a.localeCompare(b))));
  assert.equal(identity.commandDigest, `sha256:${createHash("sha256").update(serialized).digest("hex")}`);
  assert.equal(identity.declaration.acpxPatchSha256, contract.acpxPatchSha256);
}
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
  if (process.argv.includes("--check")) {
    assert.equal(await readFile(url, "utf8"), content, `Stale ACPX profiles: ${fileURLToPath(url)}; run generate:acpx-profiles`);
  } else await writeFile(url, content);
}
console.log("TypeScript/Rust ACPX profiles match the release manifest.");
