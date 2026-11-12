// Build-before-merge image handoff between the merge queue and master.
//
// A `merge_group` run of docker-merge-group.yml builds the production image for
// the exact merge-group commit with no registry credentials, probes it, and
// uploads an OCI archive plus a record of what it built. When the merge queue
// then fast-forwards master to that commit, docker.yml may push those exact
// bytes instead of rebuilding them. Anything that does not prove the match
// returns no promotion, and docker.yml falls back to its normal build.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFile, readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

export const repository = "paperclipai/paperclip";
export const repositoryId = 1170821064;
export const workflowPath = ".github/workflows/docker-merge-group.yml";
export const recordSchema = "paperclip/merge-group-image/v1";
export const artifactName = arch => `merge-group-image-${arch}`;

const architectures = ["amd64", "arm64"];
const indexTypes = ["application/vnd.oci.image.index.v1+json", "application/vnd.docker.distribution.manifest.list.v2+json"];
const manifestTypes = ["application/vnd.oci.image.manifest.v1+json", "application/vnd.docker.distribution.manifest.v2+json"];
const fullSha = /^[a-f0-9]{40}$/;
const digestPattern = /^sha256:[a-f0-9]{64}$/;
const sha256 = bytes => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

/**
 * Choose the merge-queue build a master push may promote. Only a completed,
 * successful run of this repository's merge-group workflow, on a merge-queue
 * branch for master, for exactly this commit, qualifies.
 *
 * The commit must match, not only the tree: the image stamps the commit SHA
 * (PAPERCLIP_BUILD_COMMIT, build-info.json, the provider pack revision). The
 * merge queue lands the commit it tested for every merge method, squash
 * included, by fast-forwarding master to it; a push that did not come through
 * the queue has no matching run and builds from source.
 */
export function selectVerifiedRun({ sha, runs }) {
  assert.match(sha ?? "", fullSha);
  const eligible = runs.filter(run => run.head_sha === sha && run.event === "merge_group" && run.path === workflowPath &&
    run.repository?.id === repositoryId && run.head_repository?.id === repositoryId &&
    typeof run.head_branch === "string" && run.head_branch.startsWith("gh-readonly-queue/master/"));
  if (eligible.length === 0) return { reason: "no merge-queue image build exists for this commit" };
  const passed = eligible.filter(run => run.status === "completed" && run.conclusion === "success").sort((a, b) => b.id - a.id);
  if (passed.length === 0) return { reason: "the merge-queue image build for this commit did not succeed" };
  return { runId: passed[0].id };
}

/** The run's unexpired image artifact for one architecture, if there is exactly one. */
export function selectArtifact({ artifacts, arch }) {
  assert.ok(architectures.includes(arch));
  const matches = artifacts.filter(item => item.name === artifactName(arch) && !item.expired);
  return matches.length === 1 ? { artifactId: matches[0].id } : { reason: `expected one unexpired ${artifactName(arch)} artifact, found ${matches.length}` };
}

/**
 * The digest of the image an OCI archive holds, checked against the archive's
 * own content-addressed blobs. `readEntry` returns the bytes of a tar entry.
 */
export function archiveImageDigest({ readEntry, arch }) {
  assert.ok(architectures.includes(arch));
  const layout = JSON.parse(readEntry("index.json").toString("utf8"));
  assert.equal(layout.manifests?.length, 1, "The OCI archive must hold exactly one image");
  const top = layout.manifests[0];
  assert.match(top.digest ?? "", digestPattern);
  const blob = name => {
    const bytes = readEntry(`blobs/sha256/${name.slice("sha256:".length)}`);
    assert.equal(sha256(bytes), name, `Archive blob ${name} does not match its digest`);
    return JSON.parse(bytes.toString("utf8"));
  };
  const image = blob(top.digest);
  const platformImages = indexTypes.includes(image.mediaType)
    ? (image.manifests ?? []).filter(item => item.platform?.os === "linux")
    : [{ digest: top.digest, platform: undefined }];
  assert.equal(platformImages.length, 1, "The OCI archive must hold exactly one Linux image");
  const manifest = platformImages[0].digest === top.digest ? image : blob(platformImages[0].digest);
  assert.ok(manifestTypes.includes(manifest.mediaType), "The OCI archive does not hold an image manifest");
  const config = blob(manifest.config.digest);
  assert.equal(config.os, "linux");
  assert.equal(config.architecture, arch, `The OCI archive holds a ${config.architecture} image, not ${arch}`);
  return top.digest;
}

/** What the merge-group build attests about the archive it uploads. */
export function createRecord({ sha, tree, arch, digest }) {
  assert.match(sha ?? "", fullSha);
  assert.match(tree ?? "", fullSha);
  assert.ok(architectures.includes(arch));
  assert.match(digest ?? "", digestPattern);
  return { schema: recordSchema, repository, sha, tree, arch, digest };
}

/**
 * Prove the archive is the build of the tree this master push publishes. The
 * commit SHA covers its tree; the tree is compared too, so a record can never
 * vouch for different content under a reused name.
 */
export function verifyRecord({ record, sha, tree, arch, archiveDigest }) {
  assert.equal(record?.schema, recordSchema, "Unknown merge-group image record");
  assert.equal(record.repository, repository);
  assert.equal(record.sha, sha, "The merge-group build is for a different commit");
  assert.equal(record.tree, tree, "The merge-group build is for a different tree");
  assert.equal(record.arch, arch, "The merge-group build is for a different architecture");
  assert.match(record.digest ?? "", digestPattern);
  assert.equal(archiveDigest, record.digest, "The archive is not the image the merge-group build recorded");
  return record.digest;
}

/**
 * Files that produce, promote or vouch for a merge-group image. The merge-group
 * run uses the queued commits' own copies, so a push that changes any of them
 * is built from source on master instead: promotion then trusts only a
 * pipeline that master already ran before this push. docker.yml runs this
 * check from the copy of this script in the push's `before` commit, so a push
 * cannot remove the check it is subject to.
 */
export const pipelineFiles = [workflowPath, ".github/workflows/docker.yml", "scripts/merge-group-image.mjs", "scripts/assert-orphan-reaping.sh"];

export function assertPipelineUnchanged(changedFiles) {
  const changed = changedFiles.filter(file => pipelineFiles.includes(file));
  assert.equal(changed.length, 0, `This push changes the merge-group image pipeline (${changed.join(", ")})`);
}

/** Pipeline files changed by everything this push landed: `since` (the push's `before`) to HEAD. */
export function changedSince(since, cwd = process.cwd()) {
  assert.match(since ?? "", fullSha, "--since must be the push's full `before` SHA");
  // Throws unless `since` is an ancestor: a push is a fast-forward of master.
  execFileSync("git", ["merge-base", "--is-ancestor", since, "HEAD"], { cwd, stdio: "ignore" });
  return execFileSync("git", ["diff", "--name-only", since, "HEAD", "--", ...pipelineFiles], { cwd, encoding: "utf8" }).split("\n").filter(Boolean);
}
const tarReader = archive => entry => execFileSync("tar", ["-xOf", archive, entry], { maxBuffer: 16 * 1024 * 1024 });
const gitTree = () => execFileSync("git", ["rev-parse", "HEAD^{tree}"], { encoding: "utf8" }).trim();
const option = name => {
  const index = process.argv.indexOf(`--${name}`);
  const value = index > 0 ? process.argv[index + 1] : undefined;
  assert.ok(value, `--${name} is required`);
  return value;
};
const output = async (key, value) => {
  if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `${key}=${value}\n`);
  console.log(`${key}=${value}`);
};

async function main(command) {
  const sha = process.env.GITHUB_SHA;
  const arch = option("arch");
  if (command === "record") {
    // Runs in the credential-free merge-group build.
    assert.equal(process.env.GITHUB_EVENT_NAME, "merge_group", "Records are written only by merge-group builds");
    const digest = archiveImageDigest({ readEntry: tarReader(option("archive")), arch });
    await writeFile(option("out"), `${JSON.stringify(createRecord({ sha, tree: gitTree(), arch, digest }), null, 2)}\n`);
    return output("digest", digest);
  }
  assert.ok(process.env.GITHUB_REPOSITORY === repository && process.env.GITHUB_REF === "refs/heads/master" &&
    process.env.GITHUB_EVENT_NAME === "push", "Promotion runs only for canonical master pushes");
  if (command === "find") {
    const token = process.env.GITHUB_TOKEN;
    assert.ok(token, "GITHUB_TOKEN is required");
    const api = async path => {
      const response = await fetch(`https://api.github.com/repos/${repository}${path}`, { redirect: "error",
        headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" }, signal: AbortSignal.timeout(30_000) });
      assert.ok(response.ok, `GitHub API ${path}: HTTP ${response.status}`);
      return response.json();
    };
    const { workflow_runs: runs } = await api(`/actions/workflows/docker-merge-group.yml/runs?event=merge_group&head_sha=${sha}&per_page=20`);
    const run = selectVerifiedRun({ sha, runs });
    if (!run.runId) { console.log(`No promotion: ${run.reason}. Building from source.`); return; }
    const { artifacts } = await api(`/actions/runs/${run.runId}/artifacts?per_page=100`);
    const artifact = selectArtifact({ artifacts, arch });
    if (!artifact.artifactId) { console.log(`No promotion: ${artifact.reason}. Building from source.`); return; }
    return output("run_id", run.runId);
  }
  if (command === "verify") {
    const directory = option("dir");
    assertPipelineUnchanged(changedSince(option("since")));
    const record = JSON.parse(await readFile(`${directory}/record.json`, "utf8"));
    const archiveDigest = archiveImageDigest({ readEntry: tarReader(`${directory}/image.tar`), arch });
    return output("digest", verifyRecord({ record, sha, tree: gitTree(), arch, archiveDigest }));
  }
  throw new Error(`Unknown command: ${command}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main(process.argv[2]);
