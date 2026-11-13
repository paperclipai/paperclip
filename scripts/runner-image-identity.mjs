#!/usr/bin/env node
// Identity of the Runner image (ghcr.io/paperclipai/paperclip-runner).
//
// The Runner image is built once for each distinct set of inputs and named
// `inputs-<digest>`. This script computes that digest. It covers:
//   - the context tree: every file under the paths the build copies from the
//     build context, by path, executable bit and content, and every symbolic
//     link by its target. Nothing under those paths is skipped;
//   - the whole Dockerfile. The recipe stages, the pinned base images and the
//     toolchain pins are text in it, so they need no separate treatment. Any
//     edit to the Dockerfile makes a new image;
//   - the target platforms.
//
// It does not cover the source revision, so a commit that changes none of the
// above reuses the image an earlier commit built. It does not cover the text
// of .dockerignore: those rules only decide which files the build receives,
// and the context tree is hashed from the files it received.
//
// The digest that counts is the one the image build computes for itself: the
// `runner-artifacts-identity-compute` stage runs this script on the files the
// build context supplies after .dockerignore. Run in a checkout, the script
// also reads the files .dockerignore drops and anything a local build left
// behind, so it prints another digest. For the real one:
//
//   docker buildx build --target runner-artifacts-identity --output type=local,dest=DIR .
//
// Usage: node scripts/runner-image-identity.mjs [--json]
// See doc/runner-image-contract.md.

import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync, readlinkSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { computeBuildInputsDigest } from "../packages/paperclip-runner/scripts/build-inputs.mjs";
import { RUNNER_IMAGE_INPUTS_SCHEMA } from "./runner-image-layout.mjs";

export { RUNNER_IMAGE_INPUTS_SCHEMA };
export const RUNNER_IMAGE_NAME = "ghcr.io/paperclipai/paperclip-runner";
export const RUNNER_IMAGE_DOCKERFILE = "Dockerfile";
export const RUNNER_IMAGE_PLATFORMS = Object.freeze(["linux/amd64", "linux/arm64"]);

/**
 * Every path the `runner-artifacts-context` stage may copy from the build
 * context. A test checks that the stage copies nothing else and that no other
 * Runner stage reads the build context.
 *
 * @paperclipai/shared owns the generated file. build:typescript only checks
 * the Runner's own copy against it, but it fails without it.
 */
export const RUNNER_IMAGE_CONTEXT_INPUTS = Object.freeze([
  ".npmrc",
  "package.json",
  "packages/paperclip-eval-kernel",
  "packages/paperclip-runner",
  "packages/shared/src/provider-failure.generated.ts",
  "patches",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "scripts/create-provider-pack-archive.mjs",
  "scripts/link-plugin-dev-sdk.mjs",
  "scripts/runner-image-identity.mjs",
  "scripts/runner-image-layout.mjs",
  "tsconfig.base.json",
]);

function fail(message) {
  throw new Error(`Runner image identity: ${message}`);
}

function record(hash, kind, ...fields) {
  hash.update(kind);
  for (const field of fields) {
    hash.update("\0");
    hash.update(field);
  }
  hash.update("\n");
}

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const compareNames = (left, right) => (left < right ? -1 : left > right ? 1 : 0);

/**
 * Digest of everything under the context inputs, as the tree at `repoRoot`
 * holds it. Each file is recorded by path, executable bit and content digest,
 * each symbolic link by its target, each directory by path. Entries are
 * ordered by code unit, so the result does not depend on locale.
 * @param {string} repoRoot
 */
export function computeContextTreeDigest(repoRoot) {
  const hash = createHash("sha256");
  let fileCount = 0;
  let byteCount = 0;
  const visit = (relative, top) => {
    const absolute = path.join(repoRoot, ...relative.split("/"));
    let stat;
    try {
      stat = lstatSync(absolute);
    } catch {
      fail(`the build reads ${relative}, which is missing from the build context`);
    }
    if (stat.isSymbolicLink()) {
      record(hash, "link", relative, readlinkSync(absolute));
    } else if (stat.isFile()) {
      const content = readFileSync(absolute);
      fileCount += 1;
      byteCount += content.length;
      record(hash, "file", relative, (stat.mode & 0o111) === 0 ? "-" : "x", sha256(content));
    } else if (stat.isDirectory()) {
      const entries = readdirSync(absolute).sort(compareNames);
      if (top && entries.length === 0) fail(`the build reads ${relative}, which is empty in the build context`);
      record(hash, "directory", relative);
      for (const name of entries) visit(`${relative}/${name}`, false);
    } else {
      fail(`the build reads ${relative}, which is not a file, a directory or a symbolic link`);
    }
  };
  for (const input of RUNNER_IMAGE_CONTEXT_INPUTS) visit(input, true);
  return { digest: hash.digest("hex"), fileCount, byteCount };
}

/**
 * The identity of the Runner image built from the tree at `repoRoot`.
 * The Runner build-inputs digest is reported because the Runner's build stamp
 * records it. It is not hashed again: the context tree covers its files.
 * @param {string} repoRoot
 */
export function computeRunnerImageIdentity(repoRoot) {
  const dockerfile = sha256(readFileSync(path.join(repoRoot, RUNNER_IMAGE_DOCKERFILE)));
  const context = computeContextTreeDigest(repoRoot);
  const buildInputs = computeBuildInputsDigest(repoRoot);

  const hash = createHash("sha256");
  record(hash, "schema", RUNNER_IMAGE_INPUTS_SCHEMA);
  record(hash, "context", context.digest);
  record(hash, "dockerfile", dockerfile);
  for (const platform of RUNNER_IMAGE_PLATFORMS) record(hash, "platform", platform);
  const digest = hash.digest("hex");

  return {
    schema: RUNNER_IMAGE_INPUTS_SCHEMA,
    digest,
    image: RUNNER_IMAGE_NAME,
    tag: `inputs-${digest}`,
    platforms: [...RUNNER_IMAGE_PLATFORMS],
    context: { inputs: [...RUNNER_IMAGE_CONTEXT_INPUTS], ...context },
    dockerfile: { path: RUNNER_IMAGE_DOCKERFILE, sha256: dockerfile },
    buildInputs: { schema: buildInputs.schema, digest: buildInputs.digest },
  };
}

const invoked = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : null;
if (invoked === import.meta.url) {
  const flags = process.argv.slice(2);
  if (flags.some((flag) => flag !== "--json")) {
    process.stderr.write("Usage: node scripts/runner-image-identity.mjs [--json]\n");
    process.exit(2);
  }
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  try {
    const identity = computeRunnerImageIdentity(repoRoot);
    process.stdout.write(flags.includes("--json") ? `${JSON.stringify(identity, null, 2)}\n` : `${identity.digest}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}
