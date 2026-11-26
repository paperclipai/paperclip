import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { after, test } from "node:test";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { inspectNativeCompletionSourceMetadata, inspectNativeCompletionBuildHydration, verifyNativeCompletionParentAnchor,
  inspectNativeCompletionRunnerd, NATIVE_COMPLETION_RUNNERD_PATH } from "./native-completion-git-source.mjs";

const roots = [];
after(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }); });
const temporary = () => { const root = mkdtempSync(join(tmpdir(), "native-source-metadata-")); roots.push(root); return root; };
const git = (root, args, input) => execFileSync("git", args, { cwd: root, input, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
const digest = bytes => createHash("sha256").update(bytes).digest("hex");
const archiveName = "runner-e2e-build-bundle.tar.gz", checksumName = `${archiveName}.sha256`;
function commit(root, tree, parents, message) {
  const raw = `tree ${tree}\n${parents.map(parent => `parent ${parent}\n`).join("")}author Fixture <fixture@example.invalid> 1 +0000\ncommitter Fixture <fixture@example.invalid> 1 +0000\n\n${message}\n`;
  return { raw, sha: git(root, ["hash-object", "-t", "commit", "-w", "--stdin"], raw) };
}
function fixture(shallow = false, parentCount = 1) {
  const source = temporary(); git(source, ["init", "--quiet"]);
  writeFileSync(join(source, "source.txt"), "Immutable admitted source\n");
  const blob = git(source, ["hash-object", "-w", "source.txt"]);
  const tree = git(source, ["mktree"], `100644 blob ${blob}\tsource.txt\n`);
  const base = commit(source, tree, [], "Admitted base"), anchor = commit(source, tree, [base.sha], "Admitted native parent");
  const other = commit(source, tree, [base.sha], "Different parent");
  const head = commit(source, tree, parentCount === 2 ? [anchor.sha, other.sha] : [anchor.sha], "Native-only repair");
  git(source, ["update-ref", "refs/heads/fixture", head.sha]); git(source, ["checkout", "--quiet", "--force", "fixture"]);
  let root = source;
  if (shallow) {
    root = join(temporary(), "checkout");
    git(source, ["clone", "--quiet", "--depth", "1", "--branch", "fixture", pathToFileURL(source).href, root]);
  }
  const input = { repositoryRoot: root, sourceFiles: ["source.txt"], baseSha: base.sha, variant: "candidate",
    shallowParentAnchors: { candidate: anchor.sha, historical: other.sha } };
  return { root, source, base, anchor, other, head, input };
}
function hydrate(root, bytes = Buffer.from("Exact downloaded build archive bytes")) {
  const directory = join(root, "runner-e2e-build"); mkdirSync(directory);
  writeFileSync(join(directory, archiveName), bytes);
  writeFileSync(join(directory, checksumName), `${digest(bytes)}  ${archiveName}\n`);
  return directory;
}
test("native hosted-source metadata retains full ancestry and clean sources", () => {
  const f = fixture(), result = inspectNativeCompletionSourceMetadata(f.input);
  assert.equal(result.layering, true); assert.equal(result.immutable, true); assert.deepEqual(result.sourceMetadataErrors, []);
  assert.equal(result.sourceMetadata.lineage.strategy, "full_ancestry");
});
test("native hosted-source metadata accepts an actual shallow clone with the exact raw parent anchor", () => {
  const f = fixture(true); hydrate(f.root);
  assert.equal(git(f.root, ["rev-parse", "--is-shallow-repository"]), "true");
  assert.throws(() => git(f.root, ["merge-base", "--is-ancestor", f.base.sha, "HEAD"]));
  const result = inspectNativeCompletionSourceMetadata(f.input);
  assert.equal(result.sha, f.head.sha); assert.equal(result.layering, true); assert.equal(result.immutable, true);
  assert.deepEqual(result.sourceMetadataErrors, []);
  assert.equal(result.sourceMetadata.lineage.strategy, "shallow_immediate_parent_anchor");
  assert.equal(result.sourceMetadata.lineage.anchor, f.anchor.sha);
  assert.equal(result.sourceMetadata.hydration.verified, true);
});
test("native hosted-source metadata requires the variant-specific shallow anchor", () => {
  const f = fixture(true), result = inspectNativeCompletionSourceMetadata({ ...f.input, variant: "historical" });
  assert.equal(result.layering, false); assert.ok(result.sourceMetadataErrors.some(error => error.includes("sole hash-verified immediate parent")));
});
test("native hosted-source metadata never substitutes an anchor for missing full-clone ancestry", () => {
  const f = fixture(), result = inspectNativeCompletionSourceMetadata({ ...f.input, baseSha: "f".repeat(40) });
  assert.equal(result.layering, false); assert.ok(result.sourceMetadataErrors.some(error => error.includes("full Git history")));
});
test("native hosted-source metadata rejects a shallow merge even with the admitted parent", () => {
  const f = fixture(true, 2), result = inspectNativeCompletionSourceMetadata(f.input);
  assert.equal(result.layering, false); assert.ok(result.sourceMetadataErrors.some(error => error.includes("sole hash-verified")));
});
test("native hosted-source metadata cryptographically binds all raw HEAD bytes and the sole parent", () => {
  const f = fixture();
  assert.equal(verifyNativeCompletionParentAnchor({ sha: f.head.sha, rawCommit: f.head.raw, anchor: f.anchor.sha }), true);
  for (const input of [
    { sha: "f".repeat(40), rawCommit: f.head.raw, anchor: f.anchor.sha },
    { sha: f.head.sha, rawCommit: `${f.head.raw}altered`, anchor: f.anchor.sha },
    { sha: f.head.sha, rawCommit: f.head.raw, anchor: f.other.sha },
    { sha: f.base.sha, rawCommit: f.base.raw, anchor: f.anchor.sha },
    { sha: null, rawCommit: f.head.raw, anchor: f.anchor.sha },
  ]) assert.equal(verifyNativeCompletionParentAnchor(input), false);
});
test("native hosted-source metadata rejects dirty tracked and untracked admitted source", () => {
  const f = fixture(); hydrate(f.root); writeFileSync(join(f.root, "source.txt"), "Changed admitted source\n");
  let result = inspectNativeCompletionSourceMetadata(f.input);
  assert.equal(result.immutable, false); assert.ok(result.sourceMetadataErrors.includes("tracked source differs from HEAD"));
  git(f.root, ["checkout", "HEAD", "--", "source.txt"]); writeFileSync(join(f.root, "extra-source.mjs"), "Unexpected code");
  result = inspectNativeCompletionSourceMetadata(f.input);
  assert.equal(result.immutable, false); assert.ok(result.sourceMetadataErrors.some(error => error.includes("extra-source.mjs")));
  assert.equal(inspectNativeCompletionSourceMetadata({ ...f.input, sourceFiles: ["extra-source.mjs"] }).immutable, false);
});
test("native hosted-source metadata verifies only the exact two downloaded regular files", () => {
  const f = fixture(), directory = hydrate(f.root), first = inspectNativeCompletionSourceMetadata(f.input);
  assert.equal(first.immutable, true); assert.equal(first.sourceMetadata.hydration.verified, true);
  assert.equal(inspectNativeCompletionSourceMetadata(f.input).sourceMetadataFingerprint, first.sourceMetadataFingerprint);
  writeFileSync(join(directory, archiveName), "Different verified archive");
  writeFileSync(join(directory, checksumName), `${digest("Different verified archive")}  ${archiveName}\n`);
  const changed = inspectNativeCompletionSourceMetadata(f.input);
  assert.equal(changed.immutable, true); assert.notEqual(changed.sourceMetadataFingerprint, first.sourceMetadataFingerprint);
});
const negatives = [
  ["missing checksum", (root, directory) => rmSync(join(directory, checksumName))],
  ["checksum mismatch", (root, directory) => writeFileSync(join(directory, archiveName), "Unverified replacement")],
  ["extra file", (root, directory) => writeFileSync(join(directory, "extra.mjs"), "Unexpected code")],
  ["extra nested directory", (root, directory) => mkdirSync(join(directory, "nested"))],
  ["malformed checksum", (root, directory) => writeFileSync(join(directory, checksumName), "malformed")],
  ["wrong checksum filename", (root, directory) => writeFileSync(join(directory, checksumName), `${"a".repeat(64)}  other.tar.gz\n`)],
  ["multiple checksum records", (root, directory) => writeFileSync(join(directory, checksumName), readFileSync(join(directory, checksumName), "utf8").repeat(2))],
  ["symlink archive", (root, directory) => { rmSync(join(directory, archiveName)); symlinkSync(join(root, "source.txt"), join(directory, archiveName)); }],
  ["symlink checksum", (root, directory) => { rmSync(join(directory, checksumName)); symlinkSync(join(root, "source.txt"), join(directory, checksumName)); }],
  ["symlink directory", (root, directory) => { rmSync(directory, { recursive: true }); symlinkSync(root, directory); }],
];
for (const [name, mutate] of negatives) test(`native hosted-source metadata rejects ${name} hydration`, () => {
  const f = fixture(), directory = hydrate(f.root); mutate(f.root, directory);
  const hydration = inspectNativeCompletionBuildHydration(f.root), result = inspectNativeCompletionSourceMetadata(f.input);
  assert.equal(hydration.verified, false); assert.ok(hydration.errors.length > 0);
  assert.equal(result.immutable, false); assert.ok(result.sourceMetadataErrors.some(error => error.includes("build hydration")));
});
test("native hosted-source metadata rejects unrelated dirty trees despite verified hydration", () => {
  const f = fixture(); hydrate(f.root); mkdirSync(join(f.root, "untrusted")); writeFileSync(join(f.root, "untrusted", "anything"), "extra");
  const result = inspectNativeCompletionSourceMetadata(f.input);
  assert.equal(result.immutable, false); assert.ok(result.sourceMetadataErrors.some(error => error.includes("untrusted/anything")));
});

function runnerdFixture() {
  const root = temporary(), binary = join(root, NATIVE_COMPLETION_RUNNERD_PATH);
  mkdirSync(join(binary, ".."), { recursive: true }); writeFileSync(binary, "Exact built runnerd fixture bytes"); chmodSync(binary, 0o755);
  const directory = join(root, "runner-e2e-build"); mkdirSync(directory);
  function pack(members = [NATIVE_COMPLETION_RUNNERD_PATH]) {
    execFileSync("tar", ["-czf", join(directory, archiveName), ...members], { cwd: root });
    writeFileSync(join(directory, checksumName), `${digest(readFileSync(join(directory, archiveName)))}  ${archiveName}\n`);
  }
  pack();
  const input = { repositoryRoot: root, sourceSha: "a".repeat(40), sourceFingerprint: "b".repeat(64), environment: {
    GITHUB_ACTIONS: "true", PAPERCLIP_RUNNER_E2E_SOURCE_SHA: "a".repeat(40), GITHUB_RUN_ID: "12345", GITHUB_RUN_ATTEMPT: "2" } };
  return { root, binary, directory, pack, input };
}
test("native hosted runnerd proof binds the actual selected debug executable to the trusted same-run archive", () => {
  const f = runnerdFixture(), proof = inspectNativeCompletionRunnerd(f.input);
  assert.equal(proof.passed, true); assert.equal(proof.mode, "trusted_hosted_archive");
  assert.equal(proof.selectedPath, NATIVE_COMPLETION_RUNNERD_PATH);
  assert.equal(proof.binarySha256, digest(readFileSync(f.binary)));
  assert.equal(proof.binaryBytes, readFileSync(f.binary).length); assert.equal(proof.archiveMemberBytes, proof.binaryBytes);
  assert.equal(proof.artifactName, `runner-e2e-build-${f.input.sourceSha}-12345-2`);
  assert.deepEqual(proof.errors, []);
  const local = inspectNativeCompletionRunnerd({ ...f.input, environment: {} });
  assert.equal(local.passed, true); assert.equal(local.mode, "fresh_local_build");
  assert.equal(local.archiveSha256, null); assert.equal(local.workflowRunId, null);
  assert.equal(local.binaryBytes, readFileSync(f.binary).length); assert.equal(local.archiveMemberBytes, null);
});
for (const [name, mutate] of [
  ["wrong trusted source SHA", f => { f.input.environment.PAPERCLIP_RUNNER_E2E_SOURCE_SHA = "c".repeat(40); }],
  ["missing workflow run", f => { delete f.input.environment.GITHUB_RUN_ID; }],
  ["malformed workflow attempt", f => { f.input.environment.GITHUB_RUN_ATTEMPT = "../2"; }],
  ["newline in workflow run", f => { f.input.environment.GITHUB_RUN_ID = "12345\n"; }],
  ["unverified archive", f => { writeFileSync(join(f.directory, archiveName), "Replacement"); }],
  ["different selected executable", f => { writeFileSync(f.binary, "Stale binary"); }],
  ["missing selected executable", f => { rmSync(f.binary); }],
  ["nonexecutable selected binary", f => { chmodSync(f.binary, 0o644); }],
  ["same-size different binary hash", f => { writeFileSync(f.binary, Buffer.alloc(readFileSync(f.binary).length, 0x58)); }],
  ["symlink selected executable", f => { const bytes = readFileSync(f.binary); rmSync(f.binary); writeFileSync(join(f.root, "other"), bytes); symlinkSync(join(f.root, "other"), f.binary); }],
  ["symlink executable ancestor", f => { const bytes = readFileSync(f.binary), directory = join(f.binary, ".."); rmSync(directory, { recursive: true }); mkdirSync(join(f.root, "other")); writeFileSync(join(f.root, "other", "paperclip-runnerd"), bytes); chmodSync(join(f.root, "other", "paperclip-runnerd"), 0o755); symlinkSync(join(f.root, "other"), directory); }],
  ["staged executable override", f => { const staged = join(f.root, "packages/paperclip-runner/dist/bin"); mkdirSync(staged, { recursive: true }); writeFileSync(join(staged, "paperclip-runnerd"), "Unexpected staged binary"); }],
  ["duplicate canonical archive members", f => { f.pack([NATIVE_COMPLETION_RUNNERD_PATH, NATIVE_COMPLETION_RUNNERD_PATH]); }],
  ["noncanonical archive member", f => { f.pack([`./${NATIVE_COMPLETION_RUNNERD_PATH}`]); }],
  ["missing archive member", f => { writeFileSync(join(f.root, "other"), "Other"); f.pack(["other"]); }],
  ["symlink archive member", f => { rmSync(f.binary); writeFileSync(join(f.root, "other"), "Other"); symlinkSync(join(f.root, "other"), f.binary); f.pack(); rmSync(f.binary); writeFileSync(f.binary, "Other"); chmodSync(f.binary, 0o755); }],
]) test(`native hosted runnerd proof rejects ${name}`, () => {
  const f = runnerdFixture(); mutate(f);
  const proof = inspectNativeCompletionRunnerd(f.input);
  assert.equal(proof.passed, false); assert.ok(proof.errors.length > 0);
});
