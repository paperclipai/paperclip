import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { checkoutSources, packContractDigest } from "./contract-fingerprints.mjs";

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

test("incidental edits leave the digest unchanged", () => {
  const unchanged = [
    [`${R}/src/cli/acpx-runtime-sidecar.ts`, s => s.replace("function parseOpenParams(", "// note\n\n/* block */ function parseOpenParams(")],
    [`${R}/src/cli/acpx-runtime-sidecar.ts`, s => s.replace("const model = requiredText(value.model, \"model\");",
      "const requestedModel = requiredText(value.model, \"model\");\n  const model = requestedModel;")],
    [`${R}/src/contracts/completion-result.ts`, s => s.replace(/: \{ type: "string"/g, ":{type:\"string\"")],
    [`${R}/src/contracts/completion-result.ts`, s => s.replace(/\bwaitContinuationSchema\b/g, "renamedContinuationSchema")],
    [`${R}/src/contracts/completion-result.ts`, s => s.replace(/description: "/, "description: \"Edited. ")],
    [`${RUST}/configured_environment.rs`, s => `// header\n${s.replace("const RESERVED", "/// doc\nconst RESERVED")}`],
    [`${RUST}/acpx_provider_checkpoint.rs`, s => s.replace("pub struct AcpxSuspensionCheckpoint {",
      "pub struct AcpxSuspensionCheckpoint {\n    #[serde(skip)]\n    pub cache: Option<String>,")],
    [`${RUST}/acpx_provider_checkpoint.rs`, s => `${s}\n#[cfg(test)]\nmod extra {\n    #[derive(Serialize)]\n    struct T { a: u8 }\n}\n`],
    // Parser function names are private; only their accepted values count.
    [`${R}/src/cli/acpx-runtime-sidecar.ts`, s => s.replaceAll("parseOpenParams", "parseSessionOpenParams")],
    // A file compiled only through `#[cfg(test)] #[path = ..] mod ..;`.
    [`${RUST}/tests/provider_api_validation.rs`, s => s.replaceAll("PRIVATE_FIELD", "PRIVATE_FIXTURE_FIELD")],
    [`${R}/protocol/schemas/auth-credentials.schema.json`, s => s.replace(/"description": "/, "\"description\": \"Edited. ")],
  ];
  for (const [path, edit] of unchanged) assert.equal(digestWith(path, edit), baseline, `${path} edit is incidental`);
});

test("contract edits change the digest", () => {
  const changed = [
    // A new session.open field, the change an older pack sidecar rejects.
    [`${R}/src/cli/acpx-runtime-sidecar.ts`, s => s.replace("\"grokEffort\",", "\"grokEffort\", \"newField\",")],
    [`${R}/src/contracts/completion-result.ts`, s => s.replace("\"same_agent\"]", "\"same_agent\", \"other\"]")],
    [`${RUST}/configured_environment.rs`, s => s.replace("const RESERVED: &[&str] = &[", "const RESERVED: &[&str] = &[\"NEW_KEY\",")],
    [`${RUST}/acpx_provider_checkpoint.rs`, s => s.replace("pub struct AcpxSuspensionCheckpoint {",
      "pub struct AcpxSuspensionCheckpoint {\n    pub extra: Option<String>,")],
    [`${RUST}/acpx_sidecar_transport.rs`, s => s.replace(/keys\.push\("/, "keys.push(\"PAPERCLIP_NEW_SIDECAR_KEY\");\n        keys.push(\"")],
    // A property named `description` is a declaration, not an annotation.
    [`${R}/protocol/schemas/result.schema.json`, s => s.replace("\"description\": { \"type\": \"string\", \"minLength\": 1 }",
      "\"description\": { \"type\": \"string\", \"minLength\": 2 }")],
    [`${R}/src/contracts/completion-result.ts`, s => s.replace(/(\n\s+)(\w+): \{ type: "string", minLength: 1, description: "/,
      "$1$2: { type: \"string\", minLength: 2, description: \"")],
  ];
  for (const [path, edit] of changed) assert.notEqual(digestWith(path, edit), baseline, `${path} edit changes a contract`);
});

test("a build context without a registered source fails instead of producing another digest", () => {
  const empty = mkdtempSync(join(tmpdir(), "contract-fingerprints-"));
  try {
    assert.throws(() => packContractDigest(empty), /Registered contract (source|directory) is missing/);
  } finally {
    rmSync(empty, { recursive: true, force: true });
  }
});
