#!/usr/bin/env node
// Layout contract of the Runner image (ghcr.io/paperclipai/paperclip-runner).
//
// The image is a plain file tree with no entrypoint. Consumers copy paths out
// of it; RUNNER_IMAGE_PATHS is the complete list of paths they may copy, and
// runner-image.json at the root records it together with the image identity.
// doc/runner-image-contract.md is the prose form of this file.
//
//   write  runs inside the image build, after the Runner's own build. It
//          places the Runner package's build output, its build stamp and the
//          source files consumers read, then writes runner-image.json. The
//          build has already put the provider pack, its archives and the
//          transport bundle at their layout paths.
//   check  verifies a built tree: every documented path, runner-image.json,
//          the build stamp, the provider pack's integrity and its transport
//          archives. The image build runs it, and CI runs it again on the
//          tree of each built image (scripts/runner-image-oci.mjs unpacks
//          it). No checked path may resolve outside the tree.
//          It also extracts the transport archives the way a sandbox does and
//          compares the result with the provider pack, so an archive set that
//          has the recorded bytes but not the pack's files does not pass.
//
// The image has two variants. `slim` is everything but the transport archives
// and their receipt; `full` adds those. `check` must be told which one it
// reads: a slim tree with archives fails, and so does a full tree without.
//
// Usage:
//   node scripts/runner-image-layout.mjs write --out DIR --workspace DIR --identity FILE
//     [--source-revision SHA] [--publication]
//   node scripts/runner-image-layout.mjs check DIR --variant slim|full [--allow-unstamped]
//     [--expect-inputs-digest HEX] [--expect-source-revision SHA] [--expect-architecture ARCH]
// An unknown flag, a repeated flag or a flag with an empty value is an error:
// an expectation that was not really given must not pass as one that held.
// --expect-inputs-digest also requires a publication build: only that build
// may say which published image it is.

import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import {
  chmodSync,
  createReadStream,
  mkdtempSync,
  readlinkSync,
  rmSync,
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  closeSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { pathToFileURL } from "node:url";
import { createZstdDecompress } from "node:zlib";
import {
  BUILD_INPUTS_SCHEMA,
  buildInputsStampPath,
  expectedBuildOutputs,
  findChangedBuildOutput,
} from "../packages/paperclip-runner/scripts/build-inputs.mjs";
import { sha256Tree } from "../packages/paperclip-runner/scripts/provider-pack-runtime-tree.mjs";

export const RUNNER_IMAGE_SCHEMA = "paperclip.runner-image.v1";
export const RUNNER_IMAGE_INPUTS_SCHEMA = "paperclip.runner-image-inputs.v1";
export const PROVIDER_PACK_SCHEMA = "paperclip-runner/remote-provider-pack/v1";
export const PROVIDER_PACK_ARCHIVE_SCHEMA = "paperclip-runner/provider-pack-archive/v2";

/** Every path a consumer may copy out of the image, relative to its root. */
export const RUNNER_IMAGE_PATHS = Object.freeze({
  manifest: "runner-image.json",
  runnerd: "paperclip-runnerd",
  providerPack: "provider-pack",
  providerPackManifest: "provider-pack/provider-pack.json",
  providerPackArchiveReceipt: "provider-pack.archive.json",
  providerPackArchives: "provider-pack.archives",
  runnerPackage: "runner-package",
  runnerPackageManifest: "runner-package/package.json",
  runnerDist: "runner-package/dist",
  runnerDistRunnerd: "runner-package/dist/bin/paperclip-runnerd",
  runnerBuildStamp: "runner-package/node_modules/.cache/paperclip-runner-build-inputs.json",
  grokProvisioner: "runner-package/scripts/provision-grok.mjs",
  grokPlatforms: "runner-package/src/providers/grok/platforms.json",
  runnerdCodexTransportContract: "runner-package/src/live/runnerd-codex-transport.ts",
  runnerdCodexTransportBundle: "bundles/runnerd-codex-transport.mjs",
  lockfile: "pnpm-lock.yaml",
});

/** The two variants of the image. `full` is `slim` plus the paths below. */
export const RUNNER_IMAGE_VARIANTS = Object.freeze(["slim", "full"]);
/** Names in RUNNER_IMAGE_PATHS that only the full image has: the pack's transport form. */
export const RUNNER_IMAGE_FULL_ONLY_PATHS = Object.freeze(["providerPackArchiveReceipt", "providerPackArchives"]);

const DIRECTORY_PATHS = new Set(["providerPack", "providerPackArchives", "runnerPackage", "runnerDist"]);
/** Paths that exist only when the build was given a source revision. */
const STAMPED_ONLY_PATHS = new Set([
  "providerPackManifest",
  "providerPackArchiveReceipt",
  "providerPackArchives",
  "runnerdCodexTransportBundle",
]);
const RUNNER_PACKAGE = "packages/paperclip-runner";
/**
 * Files `write` copies from the workspace, keyed by layout path. Everything
 * under runner-package keeps its path inside the Runner package, so the tree
 * can be laid over packages/paperclip-runner.
 */
const WORKSPACE_SOURCES = Object.freeze({
  runnerd: `${RUNNER_PACKAGE}/dist/bin/paperclip-runnerd`,
  runnerPackageManifest: `${RUNNER_PACKAGE}/package.json`,
  runnerBuildStamp: `${RUNNER_PACKAGE}/node_modules/.cache/paperclip-runner-build-inputs.json`,
  grokProvisioner: `${RUNNER_PACKAGE}/scripts/provision-grok.mjs`,
  grokPlatforms: `${RUNNER_PACKAGE}/src/providers/grok/platforms.json`,
  runnerdCodexTransportContract: `${RUNNER_PACKAGE}/src/live/runnerd-codex-transport.ts`,
  lockfile: "pnpm-lock.yaml",
});

/** OCI architecture name to the ELF machine and the Node architecture name of the pack. */
const ARCHITECTURES = Object.freeze({
  amd64: { elfMachine: 62, node: "x64" },
  arm64: { elfMachine: 183, node: "arm64" },
});

const HEX_64 = /^[0-9a-f]{64}$/;
const SHA256 = /^sha256:[0-9a-f]{64}$/;
const REVISION = /^[0-9a-f]{40}$/;
const VERSION = /^\d+\.\d+(?:\.\d+)?$/;

export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function sha256File(file) {
  const hash = createHash("sha256");
  const descriptor = openSync(file, "r");
  try {
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let read;
    while ((read = readSync(descriptor, buffer, 0, buffer.length, null)) > 0) hash.update(buffer.subarray(0, read));
  } finally {
    closeSync(descriptor);
  }
  return `sha256:${hash.digest("hex")}`;
}

function compareVersions(left, right) {
  const a = left.split(".").map(Number);
  const b = right.split(".").map(Number);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

const resolveIn = (root, relative) => path.join(root, ...relative.split("/"));

/**
 * Where `relative` under `base` really is. A path that leaves `base`, by
 * `..` or through a symbolic link, is "outside": hashing it would vouch for a
 * file the image does not contain.
 * @returns {{ state: "inside", path: string } | { state: "missing" } | { state: "outside" }}
 */
function locate(base, relative) {
  const candidate = path.resolve(base, relative);
  if (candidate !== base && !candidate.startsWith(`${base}${path.sep}`)) return { state: "outside" };
  let real;
  let realBase;
  try {
    realBase = realpathSync(base);
    real = realpathSync(candidate);
  } catch {
    return { state: "missing" };
  }
  if (real !== realBase && !real.startsWith(`${realBase}${path.sep}`)) return { state: "outside" };
  return { state: "inside", path: real };
}

function readJson(file, problems, label) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    problems.push(`${label} is not readable JSON (${error instanceof SyntaxError ? "invalid JSON" : (error?.code ?? "unreadable")})`);
    return null;
  }
}

/** The newest GLIBC symbol version the executable needs, read from its dynamic symbols. */
export function requiredGlibcVersion(file) {
  const result = spawnSync("objdump", ["-T", file], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`objdump could not read ${file}: ${String(result.stderr ?? result.error).trim()}`);
  const versions = [...result.stdout.matchAll(/GLIBC_(\d+(?:\.\d+)+)/g)].map((match) => match[1]);
  if (versions.length === 0) throw new Error(`${file} references no versioned glibc symbol`);
  return versions.sort(compareVersions).at(-1);
}

/** The platform and libc of the machine the image is being built on. */
export function detectBuildEnvironment(runnerd) {
  const architecture = Object.entries(ARCHITECTURES).find(([, value]) => value.node === process.arch)?.[0];
  const buildVersion = process.report?.getReport().header.glibcVersionRuntime;
  if (process.platform !== "linux" || !architecture || !buildVersion) {
    throw new Error("the Runner image is built on linux/amd64 or linux/arm64 with glibc");
  }
  const release = Object.fromEntries(readFileSync("/etc/os-release", "utf8").split("\n")
    .map((line) => /^([A-Z_]+)="?([^"]*)"?$/.exec(line)).filter(Boolean).map((match) => [match[1], match[2]]));
  return {
    platform: { os: "linux", architecture },
    libc: {
      baseline: `${release.ID}-${release.VERSION_CODENAME || release.VERSION_ID}`,
      buildVersion,
      runnerdRequires: requiredGlibcVersion(runnerd),
    },
  };
}

/**
 * Places the daemon, the Runner package's build output with its stamp, and the
 * source files consumers read, then writes runner-image.json. The provider
 * pack, its archives and the transport bundle are already at their layout
 * paths when the build has a source revision.
 * @param {{
 *   outRoot: string,
 *   workspaceRoot: string,
 *   identity: { schema: string, digest: string, buildInputs: { schema: string, digest: string } },
 *   platform: { os: string, architecture: string },
 *   libc: { baseline: string, buildVersion: string, runnerdRequires: string },
 *   sourceRevision?: string | null,
 *   publication?: boolean,
 * }} input
 */
export function writeRunnerImageManifest({
  outRoot,
  workspaceRoot,
  identity,
  platform,
  libc,
  sourceRevision = null,
  publication = false,
}) {
  if (platform?.os !== "linux" || !ARCHITECTURES[platform?.architecture]) {
    throw new Error(`Runner image supports linux/amd64 and linux/arm64, not ${JSON.stringify(platform)}`);
  }
  if (sourceRevision !== null && !REVISION.test(sourceRevision)) throw new Error("source revision must be a full Git SHA");
  if (publication && sourceRevision === null) throw new Error("a publication build needs a source revision");
  if (identity?.schema !== RUNNER_IMAGE_INPUTS_SCHEMA || !HEX_64.test(identity?.digest ?? "")
    || identity?.buildInputs?.schema !== BUILD_INPUTS_SCHEMA || !HEX_64.test(identity?.buildInputs?.digest ?? "")) {
    throw new Error("identity must be the output of scripts/runner-image-identity.mjs --json");
  }
  for (const key of ["buildVersion", "runnerdRequires"]) {
    if (!VERSION.test(libc?.[key] ?? "")) throw new Error(`libc ${key} must be a version number`);
  }
  if (typeof libc.baseline !== "string" || !/^[a-z0-9][a-z0-9.-]*$/.test(libc.baseline)) {
    throw new Error("libc baseline must name the distribution release the daemon was compiled on");
  }

  // The Runner's build records its stamp only when its inputs did not change
  // while it ran. Never write one here: a missing stamp means the build output
  // cannot be trusted to match the identity.
  const stampSource = resolveIn(workspaceRoot, WORKSPACE_SOURCES.runnerBuildStamp);
  if (!existsSync(stampSource)) {
    throw new Error("the Runner build recorded no build stamp; run `pnpm --filter @paperclipai/paperclip-runner build` first");
  }
  const stamp = JSON.parse(readFileSync(stampSource, "utf8"));
  if (stamp.digest !== identity.buildInputs.digest) {
    throw new Error(
      `the Runner was built from inputs ${stamp.digest}, but the image identity was computed from ${identity.buildInputs.digest}`,
    );
  }

  const place = (source, relative, mode) => {
    const target = resolveIn(outRoot, relative);
    mkdirSync(path.dirname(target), { recursive: true, mode: 0o755 });
    copyFileSync(source, target);
    chmodSync(target, mode);
  };
  mkdirSync(outRoot, { recursive: true, mode: 0o755 });
  // dist first: the stamp records the size of every file under it.
  cpSync(resolveIn(workspaceRoot, `${RUNNER_PACKAGE}/dist`), resolveIn(outRoot, RUNNER_IMAGE_PATHS.runnerDist), {
    recursive: true,
    verbatimSymlinks: true,
  });
  for (const [name, source] of Object.entries(WORKSPACE_SOURCES)) {
    place(resolveIn(workspaceRoot, source), RUNNER_IMAGE_PATHS[name], name === "runnerd" ? 0o755 : 0o644);
  }
  // An unstamped build has no pack. Keep the directory so the path still exists.
  mkdirSync(resolveIn(outRoot, RUNNER_IMAGE_PATHS.providerPack), { recursive: true, mode: 0o755 });

  const packManifestPath = resolveIn(outRoot, RUNNER_IMAGE_PATHS.providerPackManifest);
  const pack = existsSync(packManifestPath) ? JSON.parse(readFileSync(packManifestPath, "utf8")) : null;
  const sha256 = {};
  for (const [name, relative] of Object.entries(RUNNER_IMAGE_PATHS)) {
    if (name === "manifest" || DIRECTORY_PATHS.has(name)) continue;
    const absolute = resolveIn(outRoot, relative);
    if (existsSync(absolute)) sha256[name] = sha256File(absolute);
  }

  const manifest = {
    schema: RUNNER_IMAGE_SCHEMA,
    inputsDigest: { schema: RUNNER_IMAGE_INPUTS_SCHEMA, digest: identity.digest },
    buildInputsDigest: { schema: BUILD_INPUTS_SCHEMA, digest: identity.buildInputs.digest },
    sourceRevision,
    // Only a build made to be published may carry the image identity in its
    // pack. A Runner built inline by another image build is not that image.
    publication,
    platform: { os: platform.os, architecture: platform.architecture },
    libc: { family: "glibc", baseline: libc.baseline, buildVersion: libc.buildVersion, runnerdRequires: libc.runnerdRequires },
    providerPack: pack === null ? null : { digest: pack.digest, target: pack.payload?.target ?? null },
    paths: { ...RUNNER_IMAGE_PATHS },
    // This file is the same in both variants, so it names what only one has.
    fullImageOnly: [...RUNNER_IMAGE_FULL_ONLY_PATHS],
    sha256,
  };
  const manifestPath = resolveIn(outRoot, RUNNER_IMAGE_PATHS.manifest);
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  chmodSync(manifestPath, 0o644);
  return manifest;
}

/** Every entry under `root` that an unrelated user cannot read, up to `limit`. */
function unreadableEntries(root, limit = 5) {
  const found = [];
  const visit = (directory, prefix) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (found.length >= limit) return;
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const absolute = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      const mode = lstatSync(absolute).mode;
      if (entry.isDirectory()) {
        if ((mode & 0o005) !== 0o005) found.push(relative);
        else visit(absolute, relative);
      } else if ((mode & 0o004) === 0) {
        found.push(relative);
      }
    }
  };
  visit(root, "");
  return found;
}

function elfMachine(file) {
  const header = Buffer.alloc(20);
  const descriptor = openSync(file, "r");
  try {
    if (readSync(descriptor, header, 0, header.length, 0) < header.length) return null;
  } finally {
    closeSync(descriptor);
  }
  if (header.readUInt32BE(0) !== 0x7f454c46) return null;
  // EI_DATA 1 is little-endian, which both supported architectures use.
  return header[5] === 1 ? header.readUInt16LE(18) : null;
}

function checkManifestShape(manifest, problems, { allowUnstamped }) {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    problems.push("runner-image.json is not a JSON object");
    return false;
  }
  if (manifest.schema !== RUNNER_IMAGE_SCHEMA) problems.push(`runner-image.json schema is ${JSON.stringify(manifest.schema)}, not ${RUNNER_IMAGE_SCHEMA}`);
  const stamped = manifest.sourceRevision !== null && manifest.sourceRevision !== undefined;
  if (typeof manifest.publication !== "boolean") problems.push("publication must say whether this is a publication build");
  else if (manifest.publication && !stamped) problems.push("a publication build must have a source revision");
  if (stamped) {
    if (typeof manifest.sourceRevision !== "string" || !REVISION.test(manifest.sourceRevision)) problems.push("sourceRevision is not a full Git SHA");
  } else if (!allowUnstamped) {
    problems.push("the image has no source revision: it was built without PAPERCLIP_RUNNER_SOURCE_REVISION and has no provider pack");
  }
  for (const [key, schema] of [["inputsDigest", RUNNER_IMAGE_INPUTS_SCHEMA], ["buildInputsDigest", BUILD_INPUTS_SCHEMA]]) {
    const value = manifest[key];
    if (value?.schema !== schema || typeof value?.digest !== "string" || !HEX_64.test(value.digest)) {
      problems.push(`${key} must be { schema: ${schema}, digest: <64 hexadecimal characters> }`);
    }
  }
  if (manifest.platform?.os !== "linux" || !ARCHITECTURES[manifest.platform?.architecture]) {
    problems.push(`platform must be linux/amd64 or linux/arm64, not ${JSON.stringify(manifest.platform)}`);
  }
  const libc = manifest.libc;
  if (libc?.family !== "glibc" || typeof libc?.baseline !== "string" || !libc.baseline
    || !VERSION.test(libc?.buildVersion ?? "") || !VERSION.test(libc?.runnerdRequires ?? "")) {
    problems.push("libc must record the glibc family, the baseline release, its version and the version the daemon requires");
  } else if (compareVersions(libc.runnerdRequires, libc.buildVersion) > 0) {
    problems.push(`the daemon requires glibc ${libc.runnerdRequires}, newer than the ${libc.buildVersion} baseline it was compiled on`);
  }
  if (canonicalJson(manifest.paths ?? null) !== canonicalJson(RUNNER_IMAGE_PATHS)) {
    problems.push("paths does not match the documented layout (RUNNER_IMAGE_PATHS)");
  }
  if (canonicalJson(manifest.fullImageOnly ?? null) !== canonicalJson(RUNNER_IMAGE_FULL_ONLY_PATHS)) {
    problems.push("fullImageOnly does not name the paths only the full image has (RUNNER_IMAGE_FULL_ONLY_PATHS)");
  }
  if (!manifest.sha256 || typeof manifest.sha256 !== "object") problems.push("sha256 must map file paths to their digests");
  return stamped;
}

/**
 * The stamp the Runner's own build wrote. A build that reuses this dist
 * (server/scripts/prepare-runner-vendor.mjs) accepts it only when the stamp
 * names the same inputs and platform and every recorded output is intact.
 */
function checkBuildStamp(root, manifest, problems) {
  const packageRoot = resolveIn(root, RUNNER_IMAGE_PATHS.runnerPackage);
  if (buildInputsStampPath(packageRoot) !== resolveIn(root, RUNNER_IMAGE_PATHS.runnerBuildStamp)) {
    problems.push("the documented build stamp path is not where the Runner build looks for it");
    return;
  }
  const stamp = readJson(resolveIn(root, RUNNER_IMAGE_PATHS.runnerBuildStamp), problems, "the Runner build stamp");
  if (!stamp) return;
  if (stamp.schema !== BUILD_INPUTS_SCHEMA || !Array.isArray(stamp.outputs)) {
    problems.push(`the Runner build stamp schema is ${JSON.stringify(stamp.schema)}, not ${BUILD_INPUTS_SCHEMA}`);
    return;
  }
  if (stamp.digest !== manifest.buildInputsDigest.digest) problems.push("the Runner build stamp names other inputs than runner-image.json");
  const architecture = ARCHITECTURES[manifest.platform.architecture].node;
  if (stamp.platform !== "linux" || stamp.arch !== architecture) {
    problems.push(`the Runner build stamp was recorded on ${stamp.platform}/${stamp.arch}, not linux/${architecture}`);
  }
  const missing = expectedBuildOutputs(packageRoot, "linux").filter((file) => !existsSync(file));
  if (missing.length > 0) problems.push(`the Runner build output ${path.relative(packageRoot, missing[0])} is missing`);
  if (stamp.outputs.length === 0) problems.push("the Runner build stamp records no outputs");
  const changed = findChangedBuildOutput(packageRoot, stamp.outputs);
  if (changed) problems.push(`the Runner build output ${changed.path} is ${changed.state} since the build recorded its stamp`);
}

function checkProviderPack(root, manifest, problems) {
  const packRoot = resolveIn(root, RUNNER_IMAGE_PATHS.providerPack);
  const pack = readJson(resolveIn(root, RUNNER_IMAGE_PATHS.providerPackManifest), problems, "provider-pack.json");
  if (!pack) return null;
  const payload = pack.payload;
  if (pack.schema !== PROVIDER_PACK_SCHEMA || !payload || typeof payload !== "object") {
    problems.push("provider-pack.json is not a provider pack manifest");
    return null;
  }
  const digest = `sha256:${createHash("sha256").update(canonicalJson(payload)).digest("hex")}`;
  if (pack.digest !== digest) problems.push("provider-pack.json digest does not match its payload");
  if (manifest.providerPack?.digest !== pack.digest) problems.push("runner-image.json providerPack.digest does not match provider-pack.json");
  if (payload.runnerSourceRevision !== manifest.sourceRevision) {
    problems.push(`the provider pack was built from ${payload.runnerSourceRevision}, but the image source revision is ${manifest.sourceRevision}`);
  }
  if (manifest.publication) {
    if (payload.runnerInputsDigest !== manifest.inputsDigest?.digest) {
      problems.push("the provider pack runnerInputsDigest does not match the image inputs digest");
    }
  } else if (Object.hasOwn(payload, "runnerInputsDigest")) {
    problems.push("the provider pack records runnerInputsDigest, but this is not a publication build");
  }
  const architecture = ARCHITECTURES[manifest.platform?.architecture];
  if (payload.target?.platform !== "linux" || payload.target?.architecture !== architecture?.node) {
    problems.push(`the provider pack targets ${JSON.stringify(payload.target)}, not the image platform`);
  }
  const artifacts = payload.artifacts && typeof payload.artifacts === "object" ? Object.entries(payload.artifacts) : [];
  if (artifacts.length === 0) problems.push("provider-pack.json lists no artifacts");
  for (const [name, artifact] of artifacts) {
    if (typeof artifact?.path !== "string" || !SHA256.test(artifact?.sha256 ?? "")) {
      problems.push(`provider pack artifact ${name} has no path and digest`);
      continue;
    }
    const located = locate(packRoot, artifact.path);
    if (located.state === "outside") {
      problems.push(`provider pack artifact ${name} resolves outside the pack: ${artifact.path}`);
    } else if (located.state === "missing") {
      problems.push(`provider pack artifact ${name} is missing: ${artifact.path}`);
    } else if (!lstatSync(located.path).isFile() || sha256File(located.path) !== artifact.sha256) {
      problems.push(`provider pack artifact ${name} does not match its digest: ${artifact.path}`);
    }
  }
  // The two kinds of tree digest the manifest records, recomputed with the
  // pack builder's own function.
  const tree = (label, relative, expected) => {
    const located = typeof relative === "string" ? locate(packRoot, relative) : { state: "missing" };
    if (located.state === "outside") {
      problems.push(`${label} resolves outside the pack`);
    } else if (located.state === "missing" || !lstatSync(located.path).isDirectory() || readdirSync(located.path).length === 0) {
      problems.push(`${label} is missing`);
    } else if (!SHA256.test(expected ?? "") || sha256Tree(located.path) !== expected) {
      problems.push(`${label} does not match its tree digest`);
    }
  };
  tree("the provider pack dist tree", "dist", payload.distDigest);
  for (const group of ["providers", "candidateProviders"]) {
    for (const [name, provider] of Object.entries(payload[group] ?? {})) {
      tree(`the provider pack asset tree of ${name}`, provider?.path, provider?.sha256);
    }
  }
  const lock = payload.artifacts?.productionLock?.sha256;
  if (lock !== manifest.sha256?.lockfile) problems.push("the lockfile at the image root is not the one the provider pack was installed from");
  return pack;
}

function checkArchives(root, pack, problems) {
  const receipt = readJson(resolveIn(root, RUNNER_IMAGE_PATHS.providerPackArchiveReceipt), problems, "provider-pack.archive.json");
  if (!receipt) return;
  if (receipt.schema !== PROVIDER_PACK_ARCHIVE_SCHEMA || receipt.encoding !== "tar+zstd") {
    problems.push("provider-pack.archive.json is not a layered provider pack archive receipt");
    return;
  }
  if (receipt.providerPackDigest !== pack.digest) problems.push("the transport archives belong to another provider pack");
  const archives = resolveIn(root, RUNNER_IMAGE_PATHS.providerPackArchives);
  const packRoot = resolveIn(root, RUNNER_IMAGE_PATHS.providerPack);
  const verify = (name, expected) => {
    const located = locate(archives, name);
    if (located.state === "outside") problems.push(`transport archive ${name} resolves outside the image`);
    else if (located.state === "missing") problems.push(`transport archive ${name} is missing`);
    else if (!lstatSync(located.path).isFile() || lstatSync(located.path).size !== expected?.bytes
      || sha256File(located.path) !== `sha256:${expected?.sha256}`) {
      problems.push(`transport archive ${name} does not match its receipt`);
    }
  };
  verify("overlay.tar.zst", receipt.overlay);
  if (!Array.isArray(receipt.files)) {
    problems.push("provider-pack.archive.json lists no files");
    return;
  }
  for (const [index, file] of receipt.files.entries()) {
    verify(`${index}.tar.zst`, file?.archive);
    const located = typeof file?.path === "string" ? locate(packRoot, file.path) : { state: "missing" };
    if (located.state === "outside") {
      problems.push(`archived file ${file.path} resolves outside the pack`);
    } else if (located.state === "missing") {
      problems.push(`archived file ${file?.path} is missing from the provider pack`);
    } else if (!lstatSync(located.path).isFile() || lstatSync(located.path).size !== file.bytes
      || sha256File(located.path) !== `sha256:${file.sha256}`) {
      problems.push(`archived file ${file.path} does not match the provider pack`);
    }
  }
}

/**
 * The permission bits an entry has in the image when the transport archives
 * carry it with `mode`. The image build writes the archives first and then
 * runs `chmod -R a+rX` on the tree, as the application image does, so the pack
 * in the image is the archived pack plus that grant: read for everyone, and
 * search or execute for everyone where it is a directory or was executable.
 */
function modeAfterImageGrant(mode, isDirectory) {
  const permissions = mode & 0o7777;
  return permissions | 0o444 | (isDirectory || (permissions & 0o111) !== 0 ? 0o111 : 0);
}

/**
 * The tar command that extracts a transport archive stream into
 * `destination`. A sandbox runs GNU tar with exactly these options
 * (server/src/services/native-runtime/provider-pack-layers.ts), except that it
 * lets tar start `zstd`; here the stream arrives decompressed on stdin, so the
 * build needs no zstd program. bsdtar has no --delay-directory-restore; it is
 * accepted so the check also runs on a development machine, and the result
 * says which tar ran.
 */
function tarExtraction(destination) {
  const version = spawnSync("tar", ["--version"], { encoding: "utf8" });
  const banner = `${version.stdout ?? ""}${version.stderr ?? ""}`;
  if (version.status !== 0) return null;
  if (banner.includes("GNU tar")) {
    return {
      tar: "GNU tar",
      args: ["--ignore-zeros", "-xf", "-", "--no-same-owner", "--same-permissions", "--delay-directory-restore", "-C", destination],
    };
  }
  if (banner.includes("bsdtar")) {
    return { tar: "bsdtar", args: ["--ignore-zeros", "-xf", "-", "--no-same-owner", "-p", "-C", destination] };
  }
  return null;
}

/** Every entry under `root`, by path relative to it: its kind, permission bits, size and link target. */
function treeEntries(root) {
  /** @type {Map<string, { kind: string, mode: number, size: number, target: string | null }>} */
  const entries = new Map();
  const visit = (directory, prefix) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const absolute = path.join(directory, entry.name);
      const stat = lstatSync(absolute);
      const kind = stat.isSymbolicLink() ? "link" : stat.isDirectory() ? "directory" : stat.isFile() ? "file" : "other";
      entries.set(relative, { kind, mode: stat.mode & 0o7777, size: stat.size, target: kind === "link" ? readlinkSync(absolute) : null });
      if (kind === "directory") visit(absolute, relative);
    }
  };
  visit(root, "");
  return entries;
}

/** Up to five examples and the count, so one wrong archive does not print the whole pack. */
export function summarize(problems, label, items) {
  if (items.length === 0) return;
  const shown = items.slice(0, 5).join(", ");
  problems.push(`${label} (${items.length}): ${shown}${items.length > 5 ? ", ..." : ""}`);
}

/**
 * Compares what the transport archives extracted to with the provider pack:
 * the same paths, the same kind of entry at each, the same content for files,
 * the same target for links, and the same permission bits once the image
 * build's grant is applied to the extracted ones (see modeAfterImageGrant).
 * All twelve permission bits are compared for files and directories. A link's
 * own mode is not: it is not portable and nothing reads it.
 */
function compareExtractedPack(packRoot, extractedRoot, receipt, problems) {
  const pack = treeEntries(packRoot);
  const extracted = treeEntries(extractedRoot);
  const octal = (mode) => mode.toString(8).padStart(4, "0");
  const missing = [];
  const kinds = [];
  const contents = [];
  const targets = [];
  const modes = [];
  for (const [relative, expected] of pack) {
    const actual = extracted.get(relative);
    if (!actual) {
      missing.push(relative);
    } else if (actual.kind !== expected.kind || expected.kind === "other") {
      kinds.push(`${relative} (${actual.kind}, the pack has a ${expected.kind})`);
    } else if (expected.kind === "link") {
      if (actual.target !== expected.target) targets.push(`${relative} (-> ${actual.target}, the pack has -> ${expected.target})`);
    } else {
      if (expected.kind === "file" && (actual.size !== expected.size
        || sha256File(path.join(extractedRoot, ...relative.split("/"))) !== sha256File(path.join(packRoot, ...relative.split("/"))))) {
        contents.push(relative);
      }
      const granted = modeAfterImageGrant(actual.mode, expected.kind === "directory");
      if (granted !== expected.mode) modes.push(`${relative} (archived ${octal(actual.mode)}, the pack has ${octal(expected.mode)})`);
    }
  }
  const extra = [...extracted.keys()].filter((relative) => !pack.has(relative));
  summarize(problems, "the transport archives do not carry these provider pack entries", missing);
  summarize(problems, "the transport archives carry entries the provider pack does not have", extra);
  summarize(problems, "the transport archives carry another kind of entry", kinds);
  summarize(problems, "the transport archives carry other content", contents);
  summarize(problems, "the transport archives carry another link target", targets);
  summarize(problems, "the transport archives carry other permissions", modes);
  // The receipt's mode is what a sandbox sets on a large file it reuses from
  // an older pack instead of extracting it.
  const receiptModes = [];
  for (const file of receipt.files) {
    const actual = typeof file?.path === "string" ? extracted.get(file.path) : undefined;
    if (actual?.kind === "file" && (actual.mode & 0o777) !== file.mode) {
      receiptModes.push(`${file.path} (receipt ${octal(file.mode ?? 0)}, archived ${octal(actual.mode)})`);
    }
  }
  summarize(problems, "the receipt records other permissions than the transport archives carry", receiptModes);
}

/**
 * Extracts the transport archives the way a sandbox does when it holds no
 * older pack, and compares the result with the provider pack. Returns every
 * problem found, and which tar ran.
 *
 * A sandbox receives every numbered archive and then the overlay as one
 * stream and runs, under `umask 077`,
 *   tar --zstd --ignore-zeros -xf <stream> --no-same-owner --same-permissions
 *     --delay-directory-restore -C <pack root>
 * (server/src/services/native-runtime/provider-pack-layers.ts). This does the
 * same, in a temporary directory that it removes again. tar refuses a member
 * that would be written outside the destination, and that refusal fails the
 * check.
 * @param {string} root
 * @returns {Promise<{ problems: string[], tar: string | null }>}
 */
export async function checkProviderPackArchives(root) {
  /** @type {string[]} */
  const problems = [];
  const packRoot = resolveIn(root, RUNNER_IMAGE_PATHS.providerPack);
  const archives = resolveIn(root, RUNNER_IMAGE_PATHS.providerPackArchives);
  const receipt = readJson(resolveIn(root, RUNNER_IMAGE_PATHS.providerPackArchiveReceipt), problems, "provider-pack.archive.json");
  if (!receipt) return { problems, tar: null };
  if (receipt.schema !== PROVIDER_PACK_ARCHIVE_SCHEMA || !Array.isArray(receipt.files)) {
    return { problems: ["provider-pack.archive.json is not a layered provider pack archive receipt"], tar: null };
  }
  // The order a sandbox extracts in: the large files, then the overlay.
  const names = [...receipt.files.map((_file, index) => `${index}.tar.zst`), "overlay.tar.zst"];
  let listed = [];
  try {
    listed = readdirSync(archives);
  } catch {
    return { problems: [`${RUNNER_IMAGE_PATHS.providerPackArchives} is missing`], tar: null };
  }
  summarize(problems, "the receipt lists transport archives that are missing", names.filter((name) => !listed.includes(name)));
  summarize(problems, "provider-pack.archives holds files the receipt does not list", listed.filter((name) => !names.includes(name)));
  for (const name of names) {
    const located = locate(archives, name);
    if (located.state === "inside" && !lstatSync(located.path).isFile()) problems.push(`transport archive ${name} is not a regular file`);
    if (located.state === "outside") problems.push(`transport archive ${name} resolves outside the image`);
  }
  if (problems.length > 0) return { problems, tar: null };

  const destination = mkdtempSync(path.join(tmpdir(), "paperclip-runner-image-archives-"));
  try {
    const extraction = tarExtraction(destination);
    if (!extraction) {
      return { problems: ["the transport archives cannot be extracted here: `tar` is neither GNU tar nor bsdtar"], tar: null };
    }
    const child = spawn("sh", ["-c", 'umask 077; exec tar "$@"', "sh", ...extraction.args], { stdio: ["pipe", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      if (stderr.length < 4000) stderr += chunk;
    });
    // tar can exit before it has read everything; the exit status reports why.
    child.stdin.on("error", () => {});
    const exited = new Promise((resolve) => {
      child.on("error", () => resolve(null));
      child.on("close", (code) => resolve(code));
    });
    let tarGone = false;
    void exited.then(() => {
      tarGone = true;
    });
    /** @type {{ name: string, message: string } | null} */
    let undecodable = null;
    for (const name of names) {
      if (tarGone) break;
      // One decompressor for each archive: each is a zstd stream of its own,
      // and tar reads their tar streams one after the other.
      const decompress = createZstdDecompress();
      const decoded = pipeline(createReadStream(path.join(archives, name)), decompress);
      decoded.catch(() => {});
      try {
        for await (const chunk of decompress) {
          if (tarGone) break;
          if (!child.stdin.write(chunk)) await Promise.race([once(child.stdin, "drain"), exited]);
        }
        if (!tarGone) await decoded;
      } catch (error) {
        // Once tar is gone its exit status is the finding, not the stream
        // that was cut off behind it.
        if (!tarGone) undecodable = { name, message: error instanceof Error ? error.message : String(error) };
        break;
      }
    }
    if (undecodable) child.kill();
    child.stdin.end();
    const status = await exited;
    if (undecodable) {
      problems.push(`transport archive ${undecodable.name} is not a zstd archive (${undecodable.message})`);
    } else if (status !== 0) {
      problems.push(`${extraction.tar} could not extract the transport archives (exit ${status}): ${stderr.trim().slice(-1500) || "no message"}`);
    } else {
      compareExtractedPack(packRoot, destination, receipt, problems);
    }
    return { problems, tar: extraction.tar };
  } finally {
    // An archive can carry a directory its owner cannot write to.
    spawnSync("chmod", ["-R", "u+rwX", destination]);
    rmSync(destination, { recursive: true, force: true });
  }
}

/**
 * Verifies the tree at `root` against the layout contract. Returns every
 * problem found; an empty list means the tree is a valid Runner image.
 * It reads the transport archives' bytes but does not extract them:
 * checkProviderPackArchives does, and the `check` command runs both on a
 * full image. `variant` has no default: a slim image must not hold the
 * transport archives, and a full image must.
 * @param {string} root
 * @param {{
 *   variant: string,
 *   allowUnstamped?: boolean,
 *   expectInputsDigest?: string | null,
 *   expectSourceRevision?: string | null,
 *   expectArchitecture?: string | null,
 * }} options
 * @returns {string[]}
 */
export function checkRunnerImageLayout(root, {
  variant,
  allowUnstamped = false,
  expectInputsDigest = null,
  expectSourceRevision = null,
  expectArchitecture = null,
}) {
  if (!RUNNER_IMAGE_VARIANTS.includes(variant)) throw new Error("the check must be told the variant: slim or full");
  const problems = [];
  const manifestPath = resolveIn(root, RUNNER_IMAGE_PATHS.manifest);
  if (!existsSync(manifestPath)) return ["runner-image.json is missing"];
  const manifest = readJson(manifestPath, problems, "runner-image.json");
  if (manifest === null) return problems;
  const stamped = checkManifestShape(manifest, problems, { allowUnstamped });
  if (problems.length > 0) return problems;

  if (expectInputsDigest !== null && manifest.publication !== true) {
    problems.push("an inputs digest is expected, but this is not a publication build");
  }
  if (expectInputsDigest !== null && manifest.inputsDigest?.digest !== expectInputsDigest) {
    problems.push(`inputs digest is ${manifest.inputsDigest?.digest ?? "absent"}, expected ${expectInputsDigest}`);
  }
  if (expectSourceRevision !== null && manifest.sourceRevision !== expectSourceRevision) {
    problems.push(`source revision is ${manifest.sourceRevision ?? "absent"}, expected ${expectSourceRevision}`);
  }
  if (expectArchitecture !== null && manifest.platform.architecture !== expectArchitecture) {
    problems.push(`architecture is ${manifest.platform.architecture}, expected ${expectArchitecture}`);
  }

  for (const [name, relative] of Object.entries(RUNNER_IMAGE_PATHS)) {
    if (name === "manifest" || (!stamped && STAMPED_ONLY_PATHS.has(name))) continue;
    const absolute = resolveIn(root, relative);
    let stat;
    try {
      stat = lstatSync(absolute);
    } catch {
      if (variant === "slim" && RUNNER_IMAGE_FULL_ONLY_PATHS.includes(name)) continue;
      problems.push(`documented path ${relative} (${name}) is missing`);
      continue;
    }
    if (variant === "slim" && RUNNER_IMAGE_FULL_ONLY_PATHS.includes(name)) {
      problems.push(`${relative} (${name}) is in a slim image; only the full image has the transport archives`);
      continue;
    }
    if (locate(root, relative).state !== "inside") {
      problems.push(`documented path ${relative} (${name}) resolves outside the image`);
      continue;
    }
    if (DIRECTORY_PATHS.has(name)) {
      if (!stat.isDirectory()) problems.push(`${relative} (${name}) must be a directory`);
      continue;
    }
    if (!stat.isFile() || stat.size === 0) {
      problems.push(`${relative} (${name}) must be a non-empty regular file`);
      continue;
    }
    if (!SHA256.test(manifest.sha256[name] ?? "")) problems.push(`runner-image.json records no digest for ${relative} (${name})`);
    else if (sha256File(absolute) !== manifest.sha256[name]) problems.push(`${relative} (${name}) does not match the digest in runner-image.json`);
  }

  for (const name of ["runnerd", "runnerDistRunnerd"]) {
    const runnerd = resolveIn(root, RUNNER_IMAGE_PATHS[name]);
    if (!existsSync(runnerd)) continue;
    if ((lstatSync(runnerd).mode & 0o111) !== 0o111) problems.push(`${RUNNER_IMAGE_PATHS[name]} is not executable by every user`);
    if (elfMachine(runnerd) !== ARCHITECTURES[manifest.platform.architecture].elfMachine) {
      problems.push(`${RUNNER_IMAGE_PATHS[name]} is not a linux/${manifest.platform.architecture} executable`);
    }
  }
  if (manifest.sha256.runnerd !== manifest.sha256.runnerDistRunnerd) {
    problems.push("the daemon at the image root is not the one in the Runner build output");
  }
  if (existsSync(resolveIn(root, RUNNER_IMAGE_PATHS.runnerBuildStamp))) checkBuildStamp(root, manifest, problems);

  const unreadable = unreadableEntries(root);
  if (unreadable.length > 0) problems.push(`not readable by every user: ${unreadable.join(", ")}`);

  if (stamped) {
    const pack = checkProviderPack(root, manifest, problems);
    if (pack && variant === "full") checkArchives(root, pack, problems);
  } else if (manifest.providerPack !== null) {
    problems.push("an image without a source revision must not record a provider pack");
  }
  return problems;
}

const COMMAND_FLAGS = Object.freeze({
  write: { out: "value", workspace: "value", identity: "value", "source-revision": "value", publication: "boolean" },
  check: {
    variant: "value",
    "allow-unstamped": "boolean",
    "expect-inputs-digest": "value",
    "expect-source-revision": "value",
    "expect-architecture": "value",
  },
});

/**
 * Splits a command line into positional arguments and the flags the command
 * knows. Throws on an unknown or repeated flag and on a missing or empty value.
 * @param {string} command
 * @param {string[]} argv
 * @param {Record<string, string>} [known] the command's flags: "value" or "boolean"
 */
export function parseLayoutArguments(command, argv, known = COMMAND_FLAGS[command]) {
  /** @type {string[]} */
  const positional = [];
  /** @type {Record<string, string | true>} */
  const flags = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument.startsWith("--")) {
      positional.push(argument);
      continue;
    }
    const name = argument.slice(2);
    if (!Object.hasOwn(known, name)) throw new Error(`${command} does not take ${argument}`);
    if (Object.hasOwn(flags, name)) throw new Error(`${argument} is given twice`);
    if (known[name] === "boolean") {
      flags[name] = true;
      continue;
    }
    const value = argv[index += 1];
    if (value === undefined || value === "" || value.startsWith("--")) throw new Error(`${argument} needs a value`);
    flags[name] = value;
  }
  return { positional, flags };
}

function expectation(flags, name, pattern, description) {
  const value = flags[name];
  if (value === undefined) return null;
  if (typeof value !== "string" || !pattern.test(value)) throw new Error(`--${name} must be ${description}`);
  return value;
}

const invoked = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : null;
if (invoked === import.meta.url) {
  try {
    const [command, ...rest] = process.argv.slice(2);
    if (command !== "write" && command !== "check") {
      throw new Error("Usage: runner-image-layout.mjs write ... | check DIR --variant slim|full [...]");
    }
    const { positional, flags } = parseLayoutArguments(command, rest);
    if (command === "write") {
      if (positional.length > 0) throw new Error(`write takes no positional argument: ${positional[0]}`);
      for (const name of ["out", "workspace", "identity"]) {
        if (!flags[name]) throw new Error(`write needs --${name}`);
      }
      const workspaceRoot = path.resolve(String(flags.workspace));
      const manifest = writeRunnerImageManifest({
        outRoot: path.resolve(String(flags.out)),
        workspaceRoot,
        identity: JSON.parse(readFileSync(path.resolve(String(flags.identity)), "utf8")),
        ...detectBuildEnvironment(resolveIn(workspaceRoot, WORKSPACE_SOURCES.runnerd)),
        sourceRevision: expectation(flags, "source-revision", REVISION, "a full Git SHA"),
        publication: flags.publication === true,
      });
      process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
    } else {
      if (positional.length !== 1) throw new Error("check takes exactly one directory");
      const root = path.resolve(positional[0]);
      const variant = flags.variant;
      if (typeof variant !== "string" || !RUNNER_IMAGE_VARIANTS.includes(variant)) throw new Error("check needs --variant slim or --variant full");
      const problems = checkRunnerImageLayout(root, {
        variant,
        allowUnstamped: flags["allow-unstamped"] === true,
        expectInputsDigest: expectation(flags, "expect-inputs-digest", HEX_64, "64 hexadecimal characters"),
        expectSourceRevision: expectation(flags, "expect-source-revision", REVISION, "a full Git SHA"),
        expectArchitecture: expectation(flags, "expect-architecture", /^(?:amd64|arm64)$/, "amd64 or arm64"),
      });
      // A full tree without a source revision has no archives either; the
      // layout check above has already refused that tree unless it was allowed.
      let archives = variant === "slim"
        ? "A slim image has no transport archives."
        : "The tree has no provider pack, so there are no transport archives to extract.";
      if (variant === "full" && existsSync(resolveIn(root, RUNNER_IMAGE_PATHS.providerPackArchiveReceipt))) {
        const roundTrip = await checkProviderPackArchives(root);
        problems.push(...roundTrip.problems);
        archives = roundTrip.tar === "GNU tar"
          ? "The transport archives were extracted with GNU tar, as a sandbox extracts them, and match the provider pack."
          : `The transport archives were extracted with ${roundTrip.tar} and match the provider pack. A sandbox uses GNU tar; run this on Linux for that check.`;
      }
      if (problems.length > 0) {
        process.stderr.write(`Runner image layout check failed:\n${problems.map((problem) => `- ${problem}`).join("\n")}\n`);
        process.exit(1);
      }
      process.stdout.write(`Runner image layout check passed. ${archives}\n`);
    }
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}
