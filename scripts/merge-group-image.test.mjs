import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  archiveImageDigest, assertPipelineUnchanged, changedSince, createRecord, repositoryId, selectArtifact, selectVerifiedRun, verifyRecord, workflowPath,
} from "./merge-group-image.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sha = "a".repeat(40), tree = "b".repeat(40);
const digestOf = bytes => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

const run = overrides => ({ id: 10, head_sha: sha, event: "merge_group", path: workflowPath, status: "completed", conclusion: "success",
  head_branch: `gh-readonly-queue/master/pr-1-${"c".repeat(40)}`, repository: { id: repositoryId }, head_repository: { id: repositoryId }, ...overrides });

test("promotes only a successful merge-queue build of this repository for this exact commit", () => {
  assert.deepEqual(selectVerifiedRun({ sha, runs: [run()] }), { runId: 10 });
  assert.deepEqual(selectVerifiedRun({ sha, runs: [run({ id: 10 }), run({ id: 12 }), run({ id: 14, conclusion: "failure" })] }), { runId: 12 });
  for (const [label, candidate] of [
    ["another commit", run({ head_sha: "d".repeat(40) })],
    ["a pull request run", run({ event: "pull_request" })],
    ["a push run", run({ event: "push" })],
    ["another workflow", run({ path: ".github/workflows/docker.yml" })],
    ["a fork head repository", run({ head_repository: { id: 1 } })],
    ["another repository", run({ repository: { id: 1 } })],
    ["a queue for another branch", run({ head_branch: "gh-readonly-queue/release/pr-1-x" })],
    ["an ordinary branch", run({ head_branch: "master" })],
  ]) assert.match(selectVerifiedRun({ sha, runs: [candidate] }).reason, /no merge-queue image build/, label);
  for (const candidate of [run({ conclusion: "failure" }), run({ conclusion: "cancelled" }), run({ status: "in_progress", conclusion: null })]) {
    assert.match(selectVerifiedRun({ sha, runs: [candidate] }).reason, /did not succeed/);
  }
  assert.throws(() => selectVerifiedRun({ sha: "master", runs: [] }));
});

test("requires exactly one unexpired image artifact for the architecture", () => {
  const item = (id, name, expired = false) => ({ id, name, expired });
  assert.deepEqual(selectArtifact({ arch: "amd64", artifacts: [item(1, "merge-group-image-amd64"), item(2, "merge-group-image-arm64")] }), { artifactId: 1 });
  assert.match(selectArtifact({ arch: "amd64", artifacts: [item(1, "merge-group-image-amd64", true)] }).reason, /found 0/);
  assert.match(selectArtifact({ arch: "amd64", artifacts: [item(1, "merge-group-image-amd64"), item(2, "merge-group-image-amd64")] }).reason, /found 2/);
  assert.throws(() => selectArtifact({ arch: "riscv64", artifacts: [] }));
});

// An OCI layout as BuildKit writes it for one platform with provenance: the
// layout index names a per-platform index of the image and its attestation.
function layout({ arch = "amd64", provenance = true, tamper } = {}) {
  const blobs = new Map();
  const put = value => { const bytes = Buffer.from(JSON.stringify(value)); const digest = digestOf(bytes); blobs.set(digest, bytes); return { digest, size: bytes.length }; };
  const config = put({ architecture: arch, os: "linux", rootfs: { type: "layers", diff_ids: [] } });
  const manifest = put({ schemaVersion: 2, mediaType: "application/vnd.oci.image.manifest.v1+json",
    config: { mediaType: "application/vnd.oci.image.config.v1+json", ...config }, layers: [] });
  const attestation = put({ schemaVersion: 2, mediaType: "application/vnd.oci.image.manifest.v1+json", config: { ...config }, layers: [] });
  const top = provenance ? { mediaType: "application/vnd.oci.image.index.v1+json", ...put({ schemaVersion: 2, mediaType: "application/vnd.oci.image.index.v1+json", manifests: [
    { mediaType: "application/vnd.oci.image.manifest.v1+json", ...manifest, platform: { os: "linux", architecture: arch } },
    { mediaType: "application/vnd.oci.image.manifest.v1+json", ...attestation, platform: { os: "unknown", architecture: "unknown" } },
  ] }) } : { mediaType: "application/vnd.oci.image.manifest.v1+json", ...manifest };
  if (tamper) blobs.set(manifest.digest, Buffer.from("{}"));
  const entries = new Map([["index.json", Buffer.from(JSON.stringify({ schemaVersion: 2, manifests: [top] }))]]);
  for (const [digest, bytes] of blobs) entries.set(`blobs/sha256/${digest.slice(7)}`, bytes);
  return { entries, digest: top.digest };
}
const reader = entries => name => { assert.ok(entries.has(name), `missing ${name}`); return entries.get(name); };

test("reads the image digest from an OCI archive and checks its content-addressed blobs", () => {
  for (const provenance of [true, false]) {
    const { entries, digest } = layout({ provenance });
    assert.equal(archiveImageDigest({ readEntry: reader(entries), arch: "amd64" }), digest);
  }
  assert.throws(() => archiveImageDigest({ readEntry: reader(layout().entries), arch: "arm64" }), /amd64 image, not arm64/);
  assert.throws(() => archiveImageDigest({ readEntry: reader(layout({ tamper: true }).entries), arch: "amd64" }), /does not match its digest/);
  const two = layout().entries;
  two.set("index.json", Buffer.from(JSON.stringify({ manifests: [{ digest: `sha256:${"0".repeat(64)}` }, { digest: `sha256:${"1".repeat(64)}` }] })));
  assert.throws(() => archiveImageDigest({ readEntry: reader(two), arch: "amd64" }), /exactly one image/);
});

test("reads a real tar archive through the system tar", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "merge-group-image-"));
  try {
    const { entries, digest } = layout({ arch: "arm64" });
    for (const [name, bytes] of entries) { mkdirSync(path.dirname(path.join(directory, "layout", name)), { recursive: true }); writeFileSync(path.join(directory, "layout", name), bytes); }
    execFileSync("tar", ["-cf", path.join(directory, "image.tar"), "-C", path.join(directory, "layout"), "index.json", "blobs"]);
    const readEntry = name => execFileSync("tar", ["-xOf", path.join(directory, "image.tar"), name]);
    assert.equal(archiveImageDigest({ readEntry, arch: "arm64" }), digest);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("promotion proves commit, tree, architecture and archive digest", () => {
  const digest = `sha256:${"e".repeat(64)}`;
  const record = createRecord({ sha, tree, arch: "amd64", digest });
  assert.equal(verifyRecord({ record, sha, tree, arch: "amd64", archiveDigest: digest }), digest);
  for (const [change, pattern] of [
    [{ sha: "f".repeat(40) }, /different commit/],
    [{ tree: "f".repeat(40) }, /different tree/],
    [{ arch: "arm64" }, /different architecture/],
    [{ archiveDigest: `sha256:${"f".repeat(64)}` }, /not the image the merge-group build recorded/],
  ]) assert.throws(() => verifyRecord({ record, sha, tree, arch: "amd64", archiveDigest: digest, ...change }), pattern);
  assert.throws(() => verifyRecord({ record: { ...record, schema: "other" }, sha, tree, arch: "amd64", archiveDigest: digest }), /Unknown/);
  assert.throws(() => verifyRecord({ record: { ...record, repository: "fork/paperclip" }, sha, tree, arch: "amd64", archiveDigest: digest }));
  assert.throws(() => createRecord({ sha, tree: "HEAD", arch: "amd64", digest }));
});

test("a push that changes the merge-group pipeline is built from source, not promoted", () => {
  assert.doesNotThrow(() => assertPipelineUnchanged([]));
  assert.doesNotThrow(() => assertPipelineUnchanged(["Dockerfile", "server/src/index.ts", "scripts/standard-image-contract.mjs"]));
  for (const file of [".github/workflows/docker-merge-group.yml", ".github/workflows/docker.yml", "scripts/merge-group-image.mjs", "scripts/assert-orphan-reaping.sh"]) {
    assert.throws(() => assertPipelineUnchanged(["server/src/index.ts", file]), /changes the merge-group image pipeline/, file);
  }
});

test("the pipeline check covers every commit the push landed, not only the last", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "merge-group-push-"));
  const git = (...args) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", ...args],
    { cwd: directory, encoding: "utf8" }).trim();
  const commit = (file, text) => {
    mkdirSync(path.dirname(path.join(directory, file)), { recursive: true });
    writeFileSync(path.join(directory, file), text);
    git("add", "-A"); git("commit", "-q", "-m", file);
    return git("rev-parse", "HEAD");
  };
  try {
    git("init", "-q", "-b", "main");
    const before = commit("scripts/merge-group-image.mjs", "v1");
    // A merge group of two PRs lands in one push: the first edits the
    // pipeline, the second (the push's HEAD) only edits app code.
    commit("scripts/merge-group-image.mjs", "v2");
    commit("server/src/index.ts", "app");
    assert.deepEqual(changedSince(git("rev-parse", "HEAD~1"), directory), []);
    assert.deepEqual(changedSince(before, directory), ["scripts/merge-group-image.mjs"]);
    assert.throws(() => assertPipelineUnchanged(changedSince(before, directory)), /changes the merge-group image pipeline/);
    assert.throws(() => changedSince("HEAD~2", directory), /full `before` SHA/);
    git("checkout", "-q", "--orphan", "other"); const unrelated = commit("README.md", "x");
    git("checkout", "-q", "main");
    assert.throws(() => changedSince(unrelated, directory), "a non-ancestor `before` is refused");
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("the CLI refuses to record outside a merge group or promote outside a canonical master push", () => {
  const script = path.join(root, "scripts", "merge-group-image.mjs");
  const run = (command, env) => {
    try { execFileSync(process.execPath, [script, command, "--arch", "amd64", "--archive", "x", "--out", "y", "--dir", "z"],
      { env: { PATH: process.env.PATH, GITHUB_SHA: sha, ...env }, stdio: "pipe" }); return ""; }
    catch (error) { return String(error.stderr); }
  };
  assert.match(run("record", { GITHUB_EVENT_NAME: "push" }), /only by merge-group builds/);
  for (const env of [
    { GITHUB_EVENT_NAME: "merge_group", GITHUB_REPOSITORY: "paperclipai/paperclip", GITHUB_REF: "refs/heads/master" },
    { GITHUB_EVENT_NAME: "push", GITHUB_REPOSITORY: "fork/paperclip", GITHUB_REF: "refs/heads/master" },
    { GITHUB_EVENT_NAME: "push", GITHUB_REPOSITORY: "paperclipai/paperclip", GITHUB_REF: "refs/tags/v1" },
    { GITHUB_EVENT_NAME: "pull_request", GITHUB_REPOSITORY: "paperclipai/paperclip", GITHUB_REF: "refs/heads/master" },
  ]) for (const command of ["find", "verify"]) assert.match(run(command, env), /only for canonical master pushes/);
});

test("the merge-queue build has no publishing credentials or paid infrastructure", () => {
  const workflow = readFileSync(path.join(root, ".github", "workflows", "docker-merge-group.yml"), "utf8");
  const triggers = workflow.split("\non:\n")[1].split("\n\n")[0];
  assert.equal(triggers.trim(), "merge_group:", "only the merge queue triggers this build");
  assert.match(workflow, /^permissions: \{\}$/m);
  const permissions = [...workflow.matchAll(/^    permissions:\n((?: {6}.+\n)+)/gm)].map(match => match[1].trim());
  assert.ok(permissions.length > 0);
  for (const block of permissions) assert.equal(block, "contents: read");
  assert.doesNotMatch(workflow, /secrets\.|packages: write|id-token|attestations|docker\/login-action|cache-to:|push: true|environment:|runs-on\//);
  assert.doesNotMatch(workflow, /pull_request_target|workflow_run|workflow_dispatch/);
  assert.match(workflow, /persist-credentials: false/);
  assert.match(workflow, /github\.event\.merge_group\.base_ref == 'refs\/heads\/master'/);
  assert.match(workflow, /github\.repository_id == '1170821064'/);
  assert.match(workflow, /push: false/);
  assert.match(workflow, /scripts\/assert-orphan-reaping\.sh/);
  assert.ok(workflow.indexOf("assert-orphan-reaping.sh") < workflow.indexOf("merge-group-image.mjs record"),
    "the record is written only after the probe passes");
});

test("master promotes only after proof and otherwise builds exactly as before", () => {
  const workflow = readFileSync(path.join(root, ".github", "workflows", "docker.yml"), "utf8");
  const leg = workflow.split("\n  build-and-push:\n")[1].split("\n  publication_verification:\n")[0];
  const steps = leg.split(/\n(?=      - name: )/);
  const step = name => { const found = steps.find(item => item.startsWith(`      - name: ${name}\n`)); assert.ok(found, name); return found; };
  const order = name => steps.indexOf(step(name));
  assert.match(step("Find the merge-queue build of this commit"),
    /if: github.repository == 'paperclipai\/paperclip' && github.repository_id == '1170821064' && github.event_name == 'push' && github.ref == 'refs\/heads\/master'/);
  for (const name of ["Find the merge-queue build of this commit", "Download the merge-queue image", "Promote the merge-queue image"]) {
    assert.match(step(name), /continue-on-error: true/, `${name} must fall back to the build`);
  }
  const promote = step("Promote the merge-queue image");
  // Both helpers run master's copy from before the push, so a push cannot
  // weaken the checks it must pass.
  for (const name of ["Find the merge-queue build of this commit", "Promote the merge-queue image"]) {
    assert.match(step(name), /BEFORE: \$\{\{ github.event.before \}\}/);
    assert.match(step(name), /git show "\$BEFORE:scripts\/merge-group-image.mjs" > "\$trusted"/);
    assert.doesNotMatch(step(name), /node scripts\/merge-group-image\.mjs/);
  }
  assert.match(promote, /node "\$trusted" verify --arch "\$ARCH" --dir "\$DIRECTORY" --since "\$BEFORE"/);
  assert.ok(promote.indexOf('"$trusted" verify') < promote.indexOf("skopeo copy"));
  assert.ok(promote.indexOf("skopeo copy --all --preserve-digests") < promote.indexOf('echo "digest=$digest" >> "$GITHUB_OUTPUT"'),
    "the promoted digest becomes an output only after the exact bytes are pushed");
  assert.match(promote, /GITHUB_OUTPUT='' node "\$trusted" verify/);
  assert.ok(promote.indexOf("command -v skopeo") < promote.indexOf('"$trusted" verify'),
    "a runner without skopeo reports that promotion is unavailable before it tries");
  for (const name of ["Set up Docker Buildx", "Compute schema migration labels", "Docker meta", "Build and push by digest"]) {
    assert.match(step(name), /if: steps.promote.outputs.digest == ''/, `${name} runs whenever nothing was promoted`);
    assert.ok(order(name) > order("Promote the merge-queue image"));
  }
  assert.match(step("Select image digest"), /digest="\$\{PROMOTED:-\$BUILT\}"/);
  assert.ok(order("Select image digest") < order("Verify PID 1 reaps orphaned processes"));
  assert.match(step("Verify PID 1 reaps orphaned processes"), /IMAGE_DIGEST: \$\{\{ steps.image.outputs.digest \}\}/);
  assert.match(step("Export digest"), /digest="\$\{\{ steps.image.outputs.digest \}\}"/);
  assert.match(leg, /permissions:\n\s+contents: read\n\s+packages: write\n\s+actions: read/);
});
