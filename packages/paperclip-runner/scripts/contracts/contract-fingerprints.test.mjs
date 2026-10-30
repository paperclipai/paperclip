import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { checkoutSources, fingerprintContracts, packContractDigest } from "./contract-fingerprints.mjs";

const root = resolve(fileURLToPath(new URL("../../../..", import.meta.url)));
const sources = checkoutSources(root);
const R = "packages/paperclip-runner";
const RUST = `${R}/runner/crates/runner-core/src`;
const baseline = packContractDigest(root);

/** Digest of the checkout with one file's text rewritten in memory. */
function digestWith(path, edit) {
  const original = sources.read(path);
  assert.ok(original, `${path} exists`);
  const edited = edit(original);
  assert.ok(edited !== original, `edit applies to ${path}`);
  return packContractDigest(root, { read: p => p === path ? edited : sources.read(p), list: sources.list });
}

test("the digest is a stable sha256 of the checkout", () => {
  assert.match(baseline, /^sha256:[a-f0-9]{64}$/);
  assert.equal(packContractDigest(root), baseline);
});

const SIDECAR_SCHEMA = `${R}/protocol/provider-schemas/acpx-sidecar.schema.json`;

test("incidental edits leave the digest unchanged", () => {
  const unchanged = [
    [SIDECAR_SCHEMA, s => s.replace(/"description": "/, "\"description\": \"Edited. ")],
    [SIDECAR_SCHEMA, s => s.replace(/\n {6}"/g, "\n        \"")],
    [`${R}/protocol/schemas/auth-credentials.schema.json`, s => s.replace(/"description": "/, "\"description\": \"Edited. ")],
    // TypeScript is generated from or enforced by the schemas; it is not read.
    [`${R}/src/cli/acpx-runtime-sidecar.ts`, s => s.replaceAll("parseOpenParams", "parseSessionOpenParams")],
    [`${RUST}/configured_environment.rs`, s => `// header\n${s.replace("const RESERVED", "/// doc\nconst RESERVED")}`],
    [`${RUST}/acpx_provider_checkpoint.rs`, s => s.replace("pub struct AcpxSuspensionCheckpoint {",
      "pub struct AcpxSuspensionCheckpoint {\n    #[serde(skip)]\n    pub cache: Option<String>,")],
    [`${RUST}/acpx_provider_checkpoint.rs`, s => `${s}\n#[cfg(test)]\nmod extra {\n    #[derive(Serialize)]\n    struct T { a: u8 }\n}\n`],
    // Rust type names never reach JSON; renaming a serde type keeps its shape.
    [`${RUST}/acpx_provider_checkpoint.rs`, s => s.replaceAll("AcpxSuspensionCheckpoint", "AcpxSavedSuspension")],
    // Renaming the Rust constant that carries an env key keeps the key itself.
    [`${RUST}/process_supervisor.rs`, s => s.replaceAll("VERIFIED_RUNTIME_EXECUTABLE_ENV", "RUNTIME_EXECUTABLE_HANDOFF_ENV")],
    // A file compiled only through `#[cfg(test)] #[path = ..] mod ..;`.
    [`${RUST}/tests/provider_api_validation.rs`, s => s.replaceAll("PRIVATE_FIELD", "PRIVATE_FIXTURE_FIELD")],
  ];
  for (const [path, edit] of unchanged) assert.equal(digestWith(path, edit), baseline, `${path} edit is incidental`);
});

test("contract edits change the digest", () => {
  const changed = [
    // A new session.open field, the change an older pack sidecar rejects.
    [SIDECAR_SCHEMA, s => s.replace("\"grokEffort\": true,", "\"grokEffort\": true,\n        \"newField\": true,")],
    // A property named `description` is a declaration, not an annotation.
    [`${R}/protocol/schemas/result.schema.json`, s => s.replace("\"description\": { \"type\": \"string\", \"minLength\": 1 }",
      "\"description\": { \"type\": \"string\", \"minLength\": 2 }")],
    // A nested runtime context field, which the pack's strict parser rejects.
    [`${R}/protocol/provider-schemas/runtime-context.schema.json`, s => s.replace("\"aggregateDigest\": { \"$ref\": \"#/$defs/sha256Hex\" }",
      "\"aggregateDigest\": { \"$ref\": \"#/$defs/sha256Hex\" },\n        \"newContextField\": true")],
    [SIDECAR_SCHEMA, s => s.replace("\"readOnly\": { \"type\": \"boolean\" }", "\"readOnly\": { \"type\": \"boolean\" },\n        \"newPolicyField\": { \"type\": \"boolean\" }")],
    [`${RUST}/configured_environment.rs`, s => s.replace("const RESERVED: &[&str] = &[", "const RESERVED: &[&str] = &[\"NEW_KEY\",")],
    [`${RUST}/acpx_provider_checkpoint.rs`, s => s.replace("pub struct AcpxSuspensionCheckpoint {",
      "pub struct AcpxSuspensionCheckpoint {\n    pub extra: Option<String>,")],
    [`${RUST}/acpx_sidecar_transport.rs`, s => s.replace(/keys\.push\("/, "keys.push(\"PAPERCLIP_NEW_SIDECAR_KEY\");\n        keys.push(\"")],
    // Field names serialize (here through rename_all = "camelCase").
    [`${RUST}/acpx_provider_checkpoint.rs`, s => s.replace("pub struct AcpxSuspensionCheckpoint {\n    schema: String,\n    run_id: String,",
      "pub struct AcpxSuspensionCheckpoint {\n    schema: String,\n    turn_run_id: String,")],
    // An env key passed through a constant: the verified executable handoff.
    [`${RUST}/process_supervisor.rs`, s => s.replace("\"PAPERCLIP_VERIFIED_RUNTIME_EXECUTABLE\"", "\"PAPERCLIP_RUNTIME_EXECUTABLE_PATH\"")],
  ];
  for (const [path, edit] of changed) assert.notEqual(digestWith(path, edit), baseline, `${path} edit changes a contract`);
});

test("variant names stay part of the shape even when they match a type name", () => {
  const path = `${RUST}/acpx_provider_checkpoint.rs`;
  const withEnum = original => `${original}\n#[derive(Serialize)]\nenum ProbeShape {\n    AcpxSuspensionCheckpoint(AcpxSuspensionCheckpoint),\n}\n`;
  const renamedVariant = original => `${original}\n#[derive(Serialize)]\nenum ProbeShape {\n    Checkpoint(AcpxSuspensionCheckpoint),\n}\n`;
  assert.notEqual(digestWith(path, withEnum), digestWith(path, renamedVariant));
});

test("a field that names a differently shaped type changes the digest", () => {
  const path = `${RUST}/acpx_provider_checkpoint.rs`;
  // AcpxProviderSessionIdentity, defined in another file, lets permissionMode be absent.
  assert.notEqual(digestWith(path, s => s.replace("    identity: PersistedAcpxProviderSessionIdentity,\n}",
    "    identity: AcpxProviderSessionIdentity,\n}")), baseline);
  // Renaming the referenced type keeps its shape and the digest.
  assert.equal(digestWith(path, s => s.replaceAll("PersistedAcpxProviderSessionIdentity", "SavedProviderSessionIdentity")), baseline);
  // A change inside the referenced type also reaches the field that names it.
  const nested = original => `${original}\n#[derive(Serialize)]\nstruct ProbeInner {\n    a: u8,\n}\n#[derive(Serialize)]\nstruct ProbeOuter {\n    inner: ProbeInner,\n}\n`;
  const fingerprints = edit => {
    const edited = edit(sources.read(path));
    return fingerprintContracts(p => p === path ? edited : sources.read(p), sources.list);
  };
  const before = fingerprints(nested), after = fingerprints(s => nested(s).replace("a: u8", "a: u16"));
  const outer = contracts => contracts["rust.acpx_provider_checkpoint"].value[0].find(shape => shape.includes("inner:"));
  assert.notEqual(outer(before), outer(after));
});

test("recursive serde types resolve", () => {
  const path = `${RUST}/acpx_provider_checkpoint.rs`;
  const recursive = name => original => `${original}\n#[derive(Serialize)]\nstruct ${name} {\n    children: Vec<${name}>,\n}\n`;
  assert.equal(digestWith(path, recursive("ProbeTree")), digestWith(path, recursive("ProbeNode")));
});

test("a build context without a registered source fails instead of producing another digest", () => {
  const empty = mkdtempSync(join(tmpdir(), "contract-fingerprints-"));
  try {
    assert.throws(() => packContractDigest(empty), /Registered contract (source|directory) is missing/);
  } finally {
    rmSync(empty, { recursive: true, force: true });
  }
});
