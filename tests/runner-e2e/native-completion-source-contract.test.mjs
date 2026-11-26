import assert from "node:assert/strict";
import test from "node:test";
import {
  NATIVE_COMPLETION_SOURCE_CONTRACT as original, NATIVE_COMPLETION_SOURCE_FILES,
  nativeCompletionSourceFingerprint, nativeSourceSha256,
} from "./native-completion-source-contract.mjs";

function fixture(variant = "candidate") {
  const bytes = new Map(NATIVE_COMPLETION_SOURCE_FILES.map(file => [file, Buffer.from(`common:${file}`)]));
  const variantFiles = Object.keys(original.variants.candidate), fixed = Object.keys(original.fixedContext);
  const contract = { ...original, variants: Object.fromEntries(["candidate", "historical"].map(name => [name,
    Object.fromEntries(variantFiles.map(file => [file, nativeSourceSha256(Buffer.from(`${name}:${file}`))]))])),
    fixedContext: Object.fromEntries(fixed.map(file => [file, nativeSourceSha256(bytes.get(file))])) };
  for (const file of variantFiles) bytes.set(file, Buffer.from(`${variant}:${file}`));
  const read = file => { if (!bytes.has(file)) throw new Error("Missing source"); return bytes.get(file); };
  return { bytes, contract, read };
}
for (const variant of ["candidate", "historical"]) test(`native source contract accepts the complete ${variant} source map`, () => {
  const f = fixture(variant), result = nativeCompletionSourceFingerprint(f.read, f.contract);
  assert.equal(result.variant, variant); assert.deepEqual(result.sourceErrors, []);
  for (const key of ["fingerprint", "fixtureFingerprint", "manifestFingerprint"]) assert.match(result[key], /^[a-f0-9]{64}$/);
});
test("native source contract keeps fixtures identical across candidate and historical variants", () => {
  const a = fixture("candidate"), b = fixture("historical");
  const candidate = nativeCompletionSourceFingerprint(a.read, a.contract), historical = nativeCompletionSourceFingerprint(b.read, b.contract);
  assert.equal(candidate.fixtureFingerprint, historical.fixtureFingerprint);
  assert.equal(candidate.manifestFingerprint, historical.manifestFingerprint);
  assert.notEqual(candidate.fingerprint, historical.fingerprint);
});
for (const file of Object.keys(original.variants.candidate)) test(`native source contract rejects a mixed production/assertion source: ${file}`, () => {
  const f = fixture(); f.bytes.set(file, Buffer.from(`historical:${file}`));
  const result = nativeCompletionSourceFingerprint(f.read, f.contract);
  assert.equal(result.variant, null); assert.ok(result.sourceErrors.some(error => error.includes("mixed or unknown")));
});
for (const file of Object.keys(original.fixedContext)) test(`native source contract rejects changed master context: ${file}`, () => {
  const f = fixture(); f.bytes.set(file, Buffer.from("Reduced or replaced context"));
  const result = nativeCompletionSourceFingerprint(f.read, f.contract);
  assert.ok(result.sourceErrors.includes(`native-completion: changed master context ${file}`));
});
test("native source contract rejects missing files and changes its digest when a fixture changes", () => {
  const f = fixture(), before = nativeCompletionSourceFingerprint(f.read, f.contract);
  f.bytes.set("tests/runner-e2e/native-completion-cases.ts", Buffer.from("Changed behavior"));
  const changed = nativeCompletionSourceFingerprint(f.read, f.contract);
  assert.notEqual(before.fixtureFingerprint, changed.fixtureFingerprint);
  f.bytes.delete("tests/runner-e2e/native-completion-cases.ts");
  const missing = nativeCompletionSourceFingerprint(f.read, f.contract);
  assert.equal(missing.fingerprint, null); assert.ok(missing.sourceErrors.includes("tests/runner-e2e/native-completion-cases.ts"));
});
test("native source contract rejects an ambiguous identical variant map", () => {
  const f = fixture(); f.contract.variants.historical = f.contract.variants.candidate;
  assert.equal(nativeCompletionSourceFingerprint(f.read, f.contract).variant, null);
});
test("native source contract binds common Rust carrier source and the shared behavioral projection fixture", () => {
  const f = fixture(), before = nativeCompletionSourceFingerprint(f.read, f.contract);
  f.bytes.set("packages/paperclip-runner/runner/crates/runner-core/src/provider_events.rs", Buffer.from("Changed carrier"));
  const carrier = nativeCompletionSourceFingerprint(f.read, f.contract);
  assert.equal(carrier.variant, "candidate"); assert.notEqual(carrier.fingerprint, before.fingerprint);
  f.bytes.set("tests/runner-e2e/fixtures/native-completion/terminal-tool-carrier.json", Buffer.from("Changed projection"));
  const projection = nativeCompletionSourceFingerprint(f.read, f.contract);
  assert.notEqual(projection.fingerprint, carrier.fingerprint); assert.notEqual(projection.fixtureFingerprint, carrier.fixtureFingerprint);
});
test("native source contract binds exactly five production and six variant assertion files", () => {
  const files = Object.keys(original.variants.candidate);
  assert.equal(files.length, 11); assert.equal(files.filter(file => file.endsWith(".test.ts")).length, 6);
  assert.deepEqual(files, Object.keys(original.variants.historical));
  assert.ok(files.every(file => original.variants.candidate[file] !== original.variants.historical[file]));
  assert.equal(original.baseSha, "59c07ede72dc08b8aba149a01cc11e0b7a204621");
  assert.equal(original.archiveSha, "9138f570c341c251a5727c32d6615ce238bc8e03");
  assert.deepEqual(original.shallowParentAnchors, {
    candidate: "0a9c5a75164cd0b02115ff12273aadb6a86c9464",
    historical: "00a761b967f9f73b0f45069c0ba828fae277a76e",
  });
  assert.ok(!NATIVE_COMPLETION_SOURCE_FILES.some(file => file.includes("stock-harness") || file.endsWith("issue-documents.md")));
});
