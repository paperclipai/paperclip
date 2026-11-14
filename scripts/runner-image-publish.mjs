#!/usr/bin/env node
// Publication checks for the Runner image (.github/workflows/runner-image.yml).
//
// The build legs run without write access to the registry. Each one records
// the two variants it built and verified, slim and full; the publish job
// pushes exactly those bytes, names each variant under one multi-platform
// tag and attests both.
//
//   lock-state    whether pnpm-lock.yaml matches the manifests in an exported
//                 `runner-artifacts-context` tree: `current` or `behind`. It
//                 runs the image build's own frozen install as a lockfile-only,
//                 offline check. Any other failure is an error. pnpm can
//                 rewrite the lockfile of the tree it checks, so the command
//                 refuses a checkout
//   record        a build leg, after its checks passed: joins the OCI archives
//                 of the two variants into one OCI layout, in which their
//                 shared layers are stored once, and binds it to the image
//                 digests, the architecture, the inputs digest and the source
//                 revision
//   verify-legs   the publish job, before any push: accepts only one record per
//                 architecture, for this run's inputs digest and commit, whose
//                 layout still has the recorded bytes
//   publication-state  whether these inputs are published. The full tag
//                 `inputs-<digest>` is written last, so it alone says
//                 `published`; a slim tag without it is `incomplete` and the
//                 next publication replaces it. A full tag whose slim tag is
//                 missing or names another image is an error. --strict also
//                 fails on `unknown` instead of guessing
//   verify-index  the pushed tag names exactly the recorded images of one
//                 variant; the full index must also name its slim index
//
// Registry credentials come from RUNNER_IMAGE_REGISTRY_USERNAME and
// RUNNER_IMAGE_REGISTRY_PASSWORD when both are set; lookups are anonymous
// otherwise. An unknown flag, a repeated flag or a flag with an empty value is
// an error.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { appendFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { RUNNER_IMAGE_NAME, RUNNER_IMAGE_PLATFORMS } from "./runner-image-identity.mjs";
import { RUNNER_IMAGE_PATHS, RUNNER_IMAGE_VARIANTS } from "./runner-image-layout.mjs";
import { readOciArchive } from "./runner-image-oci.mjs";
import { assertIndexUsesVerifiedImages, standardImageDigest } from "./standard-image-contract.mjs";

export const RUNNER_IMAGE_RECORD_SCHEMA = "paperclip.runner-image-leg.v2";
/** On the full index: the digest of the slim index published with it. */
export const SLIM_DIGEST_ANNOTATION = "io.paperclip.runner.slim-digest";
/** The tag of each variant. The full tag is written last and marks a complete publication. */
export const runnerImageTags = (inputsDigest) => ({ slim: `inputs-${inputsDigest}-slim`, full: `inputs-${inputsDigest}` });
const ARCHITECTURES = RUNNER_IMAGE_PLATFORMS.map((platform) => platform.split("/")[1]);
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const HEX_64 = /^[0-9a-f]{64}$/;
const REVISION = /^[0-9a-f]{40}$/;
const MANIFEST_TYPES = [
  "application/vnd.oci.image.index.v1+json",
  "application/vnd.docker.distribution.manifest.list.v2+json",
  "application/vnd.oci.image.manifest.v1+json",
  "application/vnd.docker.distribution.manifest.v2+json",
].join(", ");

async function sha256File(file) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return `sha256:${hash.digest("hex")}`;
}

function tar(args, options = {}) {
  const result = spawnSync("tar", args, { maxBuffer: 64 * 1024 * 1024, ...options });
  assert.equal(result.status, 0, `tar ${args[0]} failed: ${String(result.stderr).trim().slice(-300)}`);
  return result.stdout;
}

/**
 * What a build leg hands to the publish job: one OCI layout with both
 * variants, named `slim` and `full`, and a record read from the tree the leg
 * verified. The layout stores the layers the variants share once.
 * @param {{
 *   architecture: string,
 *   archives: { slim: string, full: string },
 *   metadataFiles: { slim: string, full: string },
 *   tree: string,
 *   layout: string,
 * }} input
 */
export async function createLegRecord({ architecture, archives, metadataFiles, tree, layout }) {
  assert.ok(ARCHITECTURES.includes(architecture), `Unsupported architecture ${architecture}`);
  const manifest = JSON.parse(await readFile(path.join(tree, RUNNER_IMAGE_PATHS.manifest), "utf8"));
  assert.equal(manifest.platform?.architecture, architecture, "The verified tree is for another architecture");
  assert.match(manifest.inputsDigest?.digest ?? "", HEX_64);
  assert.match(manifest.sourceRevision ?? "", REVISION);
  assert.equal(manifest.publication, true, "Only a publication build can be recorded");
  /** @type {Record<string, { descriptor: { mediaType: string, digest: string, size: number }, layers: string[] }>} */
  const images = {};
  for (const variant of RUNNER_IMAGE_VARIANTS) {
    const image = readOciArchive(archives[variant]);
    images[variant] = { descriptor: image.descriptor, layers: image.layers.map((layer) => layer.digest) };
    const reported = JSON.parse(await readFile(metadataFiles[variant], "utf8"))["containerimage.digest"];
    assert.match(reported ?? "", DIGEST, `The ${variant} build reported no image digest`);
    assert.equal(images[variant].descriptor.digest, reported, `The ${variant} archive is not the image its build reported`);
  }
  // The same blobs in the same order: the full image is the slim image plus layers.
  assert.deepEqual(images.full.layers.slice(0, images.slim.layers.length), images.slim.layers,
    "The full image does not start with the layers of the slim image");
  assert.ok(images.full.layers.length > images.slim.layers.length, "The full image has no layer of its own");

  const directory = await mkdtemp(path.join(tmpdir(), "runner-image-layout-"));
  try {
    for (const variant of RUNNER_IMAGE_VARIANTS) tar(["-xf", archives[variant], "-C", directory]);
    await writeFile(path.join(directory, "index.json"), JSON.stringify({
      schemaVersion: 2,
      mediaType: "application/vnd.oci.image.index.v1+json",
      manifests: RUNNER_IMAGE_VARIANTS.map((variant) => ({
        ...images[variant].descriptor,
        annotations: { "org.opencontainers.image.ref.name": variant },
      })),
    }));
    tar(["-cf", layout, "-C", directory, "blobs", "index.json", "oci-layout"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
  // Read the layout back the way the publish job's push does: each image by
  // its name, with every blob it needs under its digest.
  for (const variant of RUNNER_IMAGE_VARIANTS) {
    const image = readOciArchive(layout, { ref: variant });
    assert.equal(image.descriptor.digest, images[variant].descriptor.digest, `The layout names another image as ${variant}`);
    await image.verifyBlobs();
  }
  return {
    schema: RUNNER_IMAGE_RECORD_SCHEMA,
    architecture,
    images: { slim: images.slim.descriptor.digest, full: images.full.descriptor.digest },
    inputsDigest: manifest.inputsDigest.digest,
    sourceRevision: manifest.sourceRevision,
    layoutSha256: await sha256File(layout),
  };
}

/**
 * The image digest of each variant and architecture, as `<variant>_<arch>`,
 * accepted only when every leg built this run's inputs at this run's commit
 * and its layout is unchanged.
 * @param {{ directory: string, inputsDigest: string, sourceRevision: string, layoutName?: string }} input
 * @returns {Promise<Record<string, string>>}
 */
export async function verifyLegRecords({ directory, inputsDigest, sourceRevision, layoutName = "images.oci.tar" }) {
  assert.match(inputsDigest ?? "", HEX_64);
  assert.match(sourceRevision ?? "", REVISION);
  /** @type {Record<string, string>} */
  const digests = {};
  for (const architecture of ARCHITECTURES) {
    const legDirectory = path.join(directory, architecture);
    const record = JSON.parse(await readFile(path.join(legDirectory, "record.json"), "utf8"));
    assert.equal(record.schema, RUNNER_IMAGE_RECORD_SCHEMA, `${architecture}: unknown record schema`);
    assert.equal(record.architecture, architecture, `${architecture}: the record is for another architecture`);
    assert.equal(record.inputsDigest, inputsDigest, `${architecture}: the image was built from other inputs`);
    assert.equal(record.sourceRevision, sourceRevision, `${architecture}: the image was built at another commit`);
    for (const variant of RUNNER_IMAGE_VARIANTS) {
      assert.match(record.images?.[variant] ?? "", DIGEST, `${architecture}: the record has no ${variant} image digest`);
      digests[`${variant}_${architecture}`] = record.images[variant];
    }
    assert.notEqual(record.images.slim, record.images.full, `${architecture}: the record names one image for both variants`);
    assert.equal(await sha256File(path.join(legDirectory, layoutName)), record.layoutSha256,
      `${architecture}: the image layout does not match its record`);
  }
  return digests;
}

function repositoryOf(image) {
  const match = /^ghcr\.io\/([a-z0-9][a-z0-9._/-]*)$/.exec(image);
  assert.ok(match, `Not a ghcr.io image name: ${image}`);
  return match[1];
}

async function request(url, headers, fetchImpl, sleep) {
  for (let attempt = 1; ; attempt += 1) {
    let response;
    try {
      response = await fetchImpl(url, { headers, redirect: "error", signal: AbortSignal.timeout(30_000) });
    } catch (error) {
      if (attempt === 5) throw error;
      await sleep(attempt * 1000);
      continue;
    }
    const transient = [408, 425, 429].includes(response.status) || response.status >= 500;
    if (!transient || attempt === 5) return response;
    await response.body?.cancel();
    await sleep(attempt * 1000);
  }
}

/**
 * Reads a manifest. `state` is `present` with the registry bytes, `absent`
 * when the registry says the manifest does not exist, and `unknown` for every
 * other answer: a refused token, a package that is private to this caller, or
 * a registry error that outlasted the retries.
 * @param {string} reference
 * @param {{
 *   image?: string,
 *   credentials?: { username: string, password: string } | null,
 *   fetchImpl?: (url: string, init: { headers: Record<string, string>, redirect: "error", signal: AbortSignal }) => Promise<Response>,
 *   sleep?: (ms: number) => Promise<unknown>,
 * }} [options]
 * @returns {Promise<{ state: "present", bytes: Buffer, digest: string } | { state: "absent" } | { state: "unknown", detail: string }>}
 */
export async function readRunnerImageManifest(reference, {
  image = RUNNER_IMAGE_NAME,
  credentials = null,
  fetchImpl = fetch,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  const repository = repositoryOf(image);
  /** @type {Record<string, string>} */
  const basic = credentials ? { authorization: `Basic ${Buffer.from(`${credentials.username}:${credentials.password}`).toString("base64")}` } : {};
  // A registry that cannot be reached, or that answers with something other
  // than a token, leaves the question open. It is not an answer.
  let token;
  try {
    const tokenResponse = await request(`https://ghcr.io/token?service=ghcr.io&scope=repository:${repository}:pull`, basic, fetchImpl, sleep);
    if (!tokenResponse.ok) {
      await tokenResponse.body?.cancel();
      return { state: "unknown", detail: `token request: HTTP ${tokenResponse.status}` };
    }
    ({ token } = await tokenResponse.json());
  } catch (error) {
    return { state: "unknown", detail: `token request failed: ${error instanceof Error ? error.message : String(error)}` };
  }
  if (typeof token !== "string" || !token) return { state: "unknown", detail: "token request returned no token" };
  let response;
  let bytes;
  try {
    response = await request(`https://ghcr.io/v2/${repository}/manifests/${reference}`,
      { authorization: `Bearer ${token}`, accept: MANIFEST_TYPES }, fetchImpl, sleep);
    if (response.status === 404) {
      await response.body?.cancel();
      return { state: "absent" };
    }
    if (!response.ok) {
      await response.body?.cancel();
      return { state: "unknown", detail: `manifest request: HTTP ${response.status}` };
    }
    bytes = Buffer.from(await response.arrayBuffer());
  } catch (error) {
    return { state: "unknown", detail: `manifest request failed: ${error instanceof Error ? error.message : String(error)}` };
  }
  assert.ok(bytes.length <= 1024 * 1024, "Registry manifest exceeds its size limit");
  const digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  const reported = response.headers.get("docker-content-digest");
  assert.ok(!reported || reported === digest, "Registry digest does not match the manifest bytes");
  return { state: "present", bytes, digest };
}

/**
 * The digest of the pushed index, accepted only when it names exactly the
 * recorded images. `slimDigest` is given for the full index, which must name
 * the slim index published with it, and for no other.
 * @param {Buffer} bytes
 * @param {Record<string, string>} legDigests one image digest for each architecture
 * @param {{ slimDigest?: string | null }} [options]
 */
export function verifyPublishedIndex(bytes, legDigests, { slimDigest = null } = {}) {
  assert.deepEqual(Object.keys(legDigests).sort(), [...ARCHITECTURES].sort(), "Expected one recorded image for each architecture");
  const digest = standardImageDigest(bytes);
  assertIndexUsesVerifiedImages(bytes, new Set(Object.values(legDigests)));
  const index = JSON.parse(bytes.toString("utf8"));
  // Exactly the two images, and nothing beside them: no attestation manifest,
  // no entry without a platform, no other operating system.
  assert.equal(index.manifests.length, ARCHITECTURES.length, `Expected exactly ${ARCHITECTURES.length} manifests in the index, found ${index.manifests.length}`);
  for (const entry of index.manifests) {
    const architecture = entry.platform?.architecture;
    // BuildKit records linux/arm64 with or without the variant `v8`; both are
    // the one arm64 platform. No other variant is one of the two platforms.
    const variant = entry.platform?.variant;
    assert.ok(entry.platform?.os === "linux" && ARCHITECTURES.includes(architecture)
      && (variant === undefined || (architecture === "arm64" && variant === "v8")),
      `The index names an unexpected platform: ${JSON.stringify(entry.platform ?? null)}`);
    assert.equal(entry.digest, legDigests[architecture], `linux/${architecture} is not the image its build leg recorded`);
  }
  assert.equal(index.annotations?.[SLIM_DIGEST_ANNOTATION] ?? null, slimDigest,
    slimDigest === null ? "Only the full index may name a slim index" : "The full index does not name the slim index published with it");
  return digest;
}

/**
 * Whether the images of these inputs are published. The publish job writes
 * the slim tag, then the full tag, so the full tag is the completion marker:
 *
 * - `absent`: neither tag exists;
 * - `incomplete`: only the slim tag exists. A publication stopped between the
 *   two tags. Nothing may use that slim image; the next publication replaces
 *   the tag with its own slim image before it writes the full tag;
 * - `published`: the full tag exists and names, by digest, the image the slim
 *   tag points at;
 * - `broken`: the full tag exists, but the slim tag is missing or points at
 *   another image. No run can repair that: the full tag is never moved;
 * - `unknown`: the registry gave no clear answer.
 * @param {string} inputsDigest
 * @param {(reference: string) => ReturnType<typeof readRunnerImageManifest>} read
 * @returns {Promise<{ state: "absent" | "incomplete" | "published" | "broken" | "unknown", detail: string, full?: string, slim?: string }>}
 */
export async function runnerPublicationState(inputsDigest, read) {
  assert.match(inputsDigest ?? "", HEX_64);
  const tags = runnerImageTags(inputsDigest);
  const full = await read(tags.full);
  if (full.state === "unknown") return { state: "unknown", detail: `${tags.full}: ${full.detail}` };
  const slim = await read(tags.slim);
  if (slim.state === "unknown") return { state: "unknown", detail: `${tags.slim}: ${slim.detail}` };
  if (full.state === "absent") {
    return slim.state === "absent"
      ? { state: "absent", detail: `${tags.full} does not exist` }
      : { state: "incomplete", detail: `${tags.slim} exists without ${tags.full}: an earlier publication did not finish`, slim: slim.digest };
  }
  let named = null;
  try {
    named = JSON.parse(full.bytes.toString("utf8")).annotations?.[SLIM_DIGEST_ANNOTATION] ?? null;
  } catch {
    // Not JSON: it names no slim image.
  }
  if (slim.state === "present" && slim.digest === named) {
    return { state: "published", detail: `${tags.full} and ${tags.slim} exist`, full: full.digest, slim: slim.digest };
  }
  return {
    state: "broken",
    detail: `${tags.full} exists and names the slim image ${named ?? "(none)"}, but ${tags.slim} ${slim.state === "present" ? `is ${slim.digest}` : "does not exist"}`,
    full: full.digest,
  };
}

/** pnpm reports a lockfile that the manifests have moved past with one of these codes. */
const LOCK_BEHIND_CODES = ["ERR_PNPM_OUTDATED_LOCKFILE", "ERR_PNPM_LOCKFILE_CONFIG_MISMATCH"];

/**
 * Whether pnpm-lock.yaml in an exported `runner-artifacts-context` tree
 * matches the manifests in that tree. This is the image build's frozen,
 * filtered install with --lockfile-only and --offline: it downloads nothing
 * and installs nothing. pnpm can still write `pnpm-lock.yaml` in that tree
 * again, so `context` must be a copy no build reads: the workflow gives it an
 * export of the build context, and a checkout is refused. `behind` means the
 * manifests the Runner build reads were changed after the lockfile was. Every
 * other failure throws.
 * @param {string} context
 * @param {{ run?: (command: string, args: string[], options: object) => { status: number | null, stdout: string, stderr: string, error?: Error } }} [options]
 * @returns {{ state: "current" | "behind", detail: string }}
 */
export function runnerLockState(context, { run = (command, args, options) => spawnSync(command, args, options) } = {}) {
  assert.ok(existsSync(path.join(context, "pnpm-lock.yaml")), `${context} has no pnpm-lock.yaml`);
  assert.ok(existsSync(path.join(context, "packages", "paperclip-runner", "package.json")), `${context} is not a Runner build context`);
  assert.ok(!existsSync(path.join(context, ".git")), `${context} is a checkout: pnpm can rewrite its pnpm-lock.yaml. Check an exported build context`);
  const result = run("pnpm", ["install", "--frozen-lockfile", "--lockfile-only", "--offline", "--ignore-scripts",
    "--filter", "@paperclipai/paperclip-runner..."], { cwd: context, encoding: "utf8" });
  if (result.error) throw result.error;
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  if (result.status === 0) return { state: "current", detail: "pnpm-lock.yaml matches the Runner's manifests" };
  const code = LOCK_BEHIND_CODES.find((candidate) => output.includes(candidate));
  if (code) {
    const line = output.split("\n").find((candidate) => candidate.includes(code)) ?? code;
    return { state: "behind", detail: line.trim().slice(0, 500) };
  }
  throw new Error(`The lockfile check failed for another reason (exit ${result.status}):\n${output.trim().slice(-2000)}`);
}

const COMMAND_FLAGS = Object.freeze({
  "lock-state": { context: "value" },
  record: {
    arch: "value", "slim-archive": "value", "slim-metadata": "value", "full-archive": "value", "full-metadata": "value",
    tree: "value", layout: "value", out: "value",
  },
  "verify-legs": { dir: "value", "inputs-digest": "value", "source-revision": "value" },
  "publication-state": { "inputs-digest": "value", strict: "boolean" },
  "verify-index": { dir: "value", variant: "value", expect: "value", "slim-digest": "value" },
});
const REQUIRED_FLAGS = Object.freeze({
  "lock-state": ["context"],
  record: ["arch", "slim-archive", "slim-metadata", "full-archive", "full-metadata", "tree", "layout", "out"],
  "verify-legs": ["dir", "inputs-digest", "source-revision"],
  "publication-state": ["inputs-digest"],
  "verify-index": ["dir", "variant"],
});

/**
 * Splits a command line into positional arguments and the flags the command
 * knows. Throws on an unknown command, an unknown or repeated flag, a missing
 * or empty value, and a missing required flag.
 * @param {string | undefined} command
 * @param {string[]} argv
 */
export function parsePublishArguments(command, argv) {
  if (!command || !Object.hasOwn(COMMAND_FLAGS, command)) {
    throw new Error("Usage: runner-image-publish.mjs lock-state|record|verify-legs|publication-state|verify-index ...");
  }
  const known = COMMAND_FLAGS[command];
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
  for (const name of REQUIRED_FLAGS[command]) {
    if (!Object.hasOwn(flags, name)) throw new Error(`${command} needs --${name}`);
  }
  const takesReference = command === "verify-index";
  if (positional.length !== (takesReference ? 1 : 0)) {
    throw new Error(takesReference ? `${command} takes exactly one tag or digest` : `${command} takes no positional argument`);
  }
  if (takesReference && !/^(?:[A-Za-z0-9_][A-Za-z0-9._-]{0,127}|sha256:[0-9a-f]{64})$/.test(positional[0])) {
    throw new Error(`${command}: not a tag or digest: ${positional[0]}`);
  }
  return { positional, flags };
}

/**
 * Runs one command. Returns the values it reports; throws when the command's
 * check does not hold.
 * @param {string[]} argv
 * @param {{ env?: NodeJS.ProcessEnv, read?: typeof readRunnerImageManifest, lockState?: typeof runnerLockState, log?: (line: string) => void }} [options]
 * @returns {Promise<Record<string, string | boolean>>}
 */
export async function runPublishCommand(argv, {
  env = process.env,
  read = readRunnerImageManifest,
  lockState = runnerLockState,
  log = console.log,
} = {}) {
  const [command, ...rest] = argv;
  const { positional, flags } = parsePublishArguments(command, rest);
  const value = (name) => /** @type {string} */ (flags[name]);
  if (command === "lock-state") {
    const result = lockState(path.resolve(value("context")));
    log(result.detail);
    return { state: result.state };
  }
  if (command === "record") {
    const record = await createLegRecord({
      architecture: value("arch"),
      archives: { slim: value("slim-archive"), full: value("full-archive") },
      metadataFiles: { slim: value("slim-metadata"), full: value("full-metadata") },
      tree: value("tree"),
      layout: value("layout"),
    });
    await writeFile(value("out"), `${JSON.stringify(record, null, 2)}\n`);
    return { slim: record.images.slim, full: record.images.full };
  }
  if (command === "verify-legs") {
    return verifyLegRecords({
      directory: value("dir"), inputsDigest: value("inputs-digest"), sourceRevision: value("source-revision"),
    });
  }
  const credentials = environmentCredentials(env);
  if (command === "publication-state") {
    const tags = runnerImageTags(value("inputs-digest"));
    const result = await runnerPublicationState(value("inputs-digest"), (reference) => read(reference, { credentials }));
    // Only an operator can repair this, so it fails every run that meets it.
    assert.notEqual(result.state, "broken", `${result.detail}. No run can repair this: the workflow never moves ${tags.full}. `
      + `Delete the package versions tagged ${tags.full} and ${tags.slim}, then re-run the workflow run of a master push with these inputs.`);
    if (result.state === "unknown") {
      const message = `Could not determine whether ${RUNNER_IMAGE_NAME}:${tags.full} is published (${result.detail}).`;
      // A create-only tag is never written on a guess.
      assert.ok(flags.strict !== true, message);
      log(`::notice title=Runner image lookup inconclusive::${message}`);
    }
    if (result.state === "incomplete") log(`::notice title=Runner image publication incomplete::${result.detail}.`);
    return {
      state: result.state,
      exists: result.state === "published",
      // What a publish job may do next: write the tags, slim first.
      publish: result.state === "absent" || result.state === "incomplete",
    };
  }
  const reference = positional[0];
  const variant = value("variant");
  assert.ok(RUNNER_IMAGE_VARIANTS.includes(variant), "--variant must be slim or full");
  if (Object.hasOwn(flags, "slim-digest")) assert.match(value("slim-digest"), DIGEST, "--slim-digest must be a sha256 digest");
  assert.equal(Object.hasOwn(flags, "slim-digest"), variant === "full", "--slim-digest is given for the full index, and only for it");
  const result = await read(reference, { credentials });
  assert.equal(result.state, "present", `${RUNNER_IMAGE_NAME}:${reference} is ${result.state}`);
  assert.ok(result.state === "present");
  const digest = verifyPublishedIndex(result.bytes, await legDigests(value("dir"), variant),
    { slimDigest: variant === "full" ? value("slim-digest") : null });
  if (Object.hasOwn(flags, "expect")) {
    assert.match(value("expect"), DIGEST, "--expect must be a sha256 digest");
    assert.equal(digest, value("expect"), `${reference} resolves to ${digest}, expected ${value("expect")}`);
  }
  return { digest };
}

async function output(values) {
  const lines = Object.entries(values).map(([key, value]) => `${key}=${value}`);
  for (const line of lines) console.log(line);
  if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `${lines.join("\n")}\n`);
}

export function environmentCredentials(env = process.env) {
  const username = env.RUNNER_IMAGE_REGISTRY_USERNAME;
  const password = env.RUNNER_IMAGE_REGISTRY_PASSWORD;
  return username && password ? { username, password } : null;
}

async function legDigests(directory, variant) {
  /** @type {Record<string, string>} */
  const digests = {};
  for (const architecture of ARCHITECTURES) {
    digests[architecture] = JSON.parse(await readFile(path.join(directory, architecture, "record.json"), "utf8")).images?.[variant];
  }
  return digests;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    await output(await runPublishCommand(process.argv.slice(2)));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
