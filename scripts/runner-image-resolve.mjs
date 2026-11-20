#!/usr/bin/env node
// Which Runner an image build uses: the published Runner image of this tree's
// inputs (ghcr.io/paperclipai/paperclip-runner), or the Runner the build makes
// itself, inline. See doc/runner-image-contract.md.
//
//   inputs --dir <directory>   exports the Runner build context of the
//            checkout, checks its lockfile and, when that is current, computes
//            the inputs digest in the build. Needs Docker and pnpm, reads no
//            credential. Run it on the committed files, before any lockfile
//            refresh. The directory must be new or empty
//   resolve --dir <directory>  looks up `inputs-<digest>` for the result of
//            `inputs` and reports `published`, with both variants pinned by
//            index digest, or `inline`. Runs no build
//
// Every answer short of a complete publication of exactly these inputs is
// `inline`: a refused, failed or unreachable lookup included. Registry
// credentials are those of runner-image-publish.mjs.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { RUNNER_IMAGE_NAME, RUNNER_IMAGE_PLATFORMS } from "./runner-image-identity.mjs";
import {
  environmentCredentials, readRunnerImageManifest, runnerImageTags, runnerLockState, runnerPublicationState,
} from "./runner-image-publish.mjs";

export const RUNNER_IMAGE_LABEL = "io.paperclip.runner.image";
export const RUNNER_INPUTS_DIGEST_LABEL = "io.paperclip.runner.inputs-digest";
export const RUNNER_EXPECT_INPUTS_DIGEST_ARGUMENT = "PAPERCLIP_RUNNER_EXPECT_INPUTS_DIGEST";
export const RUNNER_IMAGE_WAIT_MINUTES = 40;
export const RUNNER_IMAGE_WAIT = Object.freeze({
  limitMs: RUNNER_IMAGE_WAIT_MINUTES * 60_000, listingMs: 2 * 60_000, pollMs: 30_000, failures: 3,
});
export const RUNNER_IMAGE_WORKFLOW_PATH = ".github/workflows/runner-image.yml";
const REPOSITORY = "paperclipai/paperclip";
const REPOSITORY_ID = 1170821064;
const WAITS_FOR = Object.freeze(["absent", "incomplete"]);
const INPUTS_FILE = "runner-image-inputs.json";
const HEX_64 = /^[0-9a-f]{64}$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const REVISION = /^[0-9a-f]{40}$/;
const EXPECTS_INPUTS_DIGEST = new RegExp(`^ARG ${RUNNER_EXPECT_INPUTS_DIGEST_ARGUMENT}(?:=.*)?$`, "m");
const message = (error) => (error instanceof Error ? error.message : String(error));

/**
 * @param {{
 *   repoRoot: string,
 *   directory: string,
 *   run?: (command: string, args: string[], options: object) => { status: number | null, error?: Error },
 *   lockState?: typeof runnerLockState,
 * }} input
 * @returns {{ consumable: boolean, lock: "current" | "behind" | null, detail: string, inputsDigest: string | null }}
 */
export function readRunnerInputs({ repoRoot, directory, run = spawnSync, lockState = runnerLockState }) {
  assert.ok(!existsSync(directory) || readdirSync(directory).length === 0, `${directory} is not empty`);
  mkdirSync(directory, { recursive: true });
  const write = (inputs) => {
    writeFileSync(path.join(directory, INPUTS_FILE), `${JSON.stringify(inputs, null, 2)}\n`);
    return inputs;
  };
  if (!EXPECTS_INPUTS_DIGEST.test(readFileSync(path.join(repoRoot, "Dockerfile"), "utf8"))) {
    return write({
      consumable: false, lock: null, inputsDigest: null,
      detail: `the Dockerfile declares no ${RUNNER_EXPECT_INPUTS_DIGEST_ARGUMENT} argument, so its build cannot check a Runner it is given`,
    });
  }
  const build = (target, name) => {
    const destination = path.join(directory, name);
    // Build output goes to stderr: stdout carries only this command's result.
    const result = run("docker", ["buildx", "build", "--target", target, "--output", `type=local,dest=${destination}`, repoRoot],
      { stdio: ["ignore", 2, 2] });
    if (result.error) throw result.error;
    assert.equal(result.status, 0, `docker buildx build --target ${target} failed (exit ${result.status})`);
    return destination;
  };
  const lock = lockState(build("runner-artifacts-context", "context"));
  let inputsDigest = null;
  if (lock.state === "current") {
    const identity = path.join(build("runner-artifacts-identity", "identity"), "runner-image-identity.json");
    inputsDigest = JSON.parse(readFileSync(identity, "utf8")).digest;
    assert.match(inputsDigest ?? "", HEX_64, "The build computed no inputs digest");
  }
  return write({ consumable: true, lock: lock.state, detail: lock.detail, inputsDigest });
}

function indexProblem(bytes, inputsDigest) {
  const index = JSON.parse(bytes.toString("utf8"));
  const named = index.annotations?.[RUNNER_INPUTS_DIGEST_LABEL];
  if (named !== inputsDigest) return `the full index names the inputs ${named ?? "(none)"}`;
  for (const platform of RUNNER_IMAGE_PLATFORMS) {
    const [os, architecture] = platform.split("/");
    const found = Array.isArray(index.manifests) && index.manifests.some((entry) =>
      entry?.platform?.os === os && entry.platform.architecture === architecture && DIGEST.test(entry.digest ?? ""));
    if (!found) return `the full index has no ${platform} image`;
  }
  return null;
}

/**
 * @param {{ consumable: boolean, lock: "current" | "behind" | null, detail?: string, inputsDigest: string | null }} inputs
 * @param {{ read?: typeof readRunnerImageManifest, credentials?: { username: string, password: string } | null }} [options]
 */
export async function resolveRunnerImage({ consumable, lock, detail: inputsDetail, inputsDigest }, { read = readRunnerImageManifest, credentials = null } = {}) {
  const inline = (reason, detail) => ({
    mode: "inline", reason, detail, inputsDigest: inputsDigest ?? "", image: "", slimImage: "", buildContexts: [], labels: [], buildArgs: [],
  });
  if (consumable !== true) return inline("unsupported", inputsDetail ?? "the build of this tree cannot check a Runner it is given");
  assert.ok(lock === "current" || lock === "behind", "The lockfile state must be current or behind");
  if (lock === "behind") return inline("lock-behind", "pnpm-lock.yaml is behind the Runner's manifests, so no image is published for this tree");
  assert.match(inputsDigest ?? "", HEX_64, "A tree with a current lockfile needs an inputs digest");
  try {
    const { full: fullTag } = runnerImageTags(inputsDigest);
    let fullIndex = null;
    const publication = await runnerPublicationState(inputsDigest, async (reference) => {
      const result = await read(reference, { credentials });
      if (reference === fullTag && result.state === "present") fullIndex = result.bytes;
      return result;
    });
    if (publication.state !== "published") return inline(publication.state, publication.detail);
    const problem = indexProblem(fullIndex, inputsDigest);
    if (problem) return inline("mismatch", `${fullTag}: ${problem}`);
    const image = `${RUNNER_IMAGE_NAME}@${publication.full}`;
    const slimImage = `${RUNNER_IMAGE_NAME}@${publication.slim}`;
    return {
      mode: "published", reason: "published", detail: publication.detail, inputsDigest, image, slimImage,
      buildContexts: [`runner-artifacts=docker-image://${image}`, `runner-artifacts-slim=docker-image://${slimImage}`],
      labels: [`${RUNNER_IMAGE_LABEL}=${image}`, `${RUNNER_INPUTS_DIGEST_LABEL}=${inputsDigest}`],
      buildArgs: [`${RUNNER_EXPECT_INPUTS_DIGEST_ARGUMENT}=${inputsDigest}`],
    };
  } catch (error) {
    return inline("unknown", `the lookup failed: ${message(error)}`);
  }
}

export function runnerImageRuns(runs, sha) {
  return runs.filter((run) => run?.head_sha === sha && run.event === "push" && run.head_branch === "master"
    && run.path === RUNNER_IMAGE_WORKFLOW_PATH && run.repository?.id === REPOSITORY_ID && run.head_repository?.id === REPOSITORY_ID);
}

export async function listRunnerImageRuns(sha, { token = "", fetchImpl = fetch } = {}) {
  assert.match(sha ?? "", REVISION, "The commit must be a full SHA");
  assert.ok(token, "A token is needed to list workflow runs");
  const response = await fetchImpl(
    `https://api.github.com/repos/${REPOSITORY}/actions/workflows/runner-image.yml/runs?head_sha=${sha}&event=push&branch=master&per_page=30`,
    { redirect: "error", headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json" }, signal: AbortSignal.timeout(30_000) },
  );
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`GitHub API: HTTP ${response.status}`);
  }
  const body = await response.json();
  assert.ok(Array.isArray(body?.workflow_runs), "GitHub API returned no list of workflow runs");
  return body.workflow_runs;
}

export async function waitForRunnerImage({
  sha, listRuns, resolve, now = Date.now, sleep = (ms) => new Promise((done) => setTimeout(done, ms)), limits = RUNNER_IMAGE_WAIT,
}) {
  const started = now();
  const waited = () => `${Math.round((now() - started) / 60_000)} min`;
  let failures = 0;
  for (;;) {
    let runs = null;
    try {
      runs = runnerImageRuns(await listRuns(sha), sha);
      failures = 0;
    } catch (error) {
      failures += 1;
      if (failures >= limits.failures) {
        return { outcome: "unknown", detail: `could not list the Runner image runs of ${sha} (${message(error)})` };
      }
    }
    if (runs?.length === 0 && now() - started >= limits.listingMs) {
      return { outcome: "not-listed", detail: `no Runner image run of a master push of ${sha} was listed in ${waited()}` };
    }
    if (runs?.length > 0) {
      const named = runs.map((run) => `${run.html_url ?? run.id} (${run.status === "completed" ? run.conclusion : run.status})`).join(", ");
      if (runs.every((run) => run.status === "completed")) {
        return { outcome: "completed", detail: `waited ${waited()} for the Runner image run ${named}` };
      }
      const resolved = await resolve();
      if (resolved.mode === "published") return { outcome: "published", resolved, detail: `waited ${waited()} for the Runner image run ${named}` };
      const pushed = Math.min(started, ...runs.map((run) => Date.parse(run.created_at)).filter(Number.isFinite));
      if (now() - pushed >= limits.limitMs) {
        return {
          outcome: "limit",
          detail: `the Runner image run ${named} did not finish within ${Math.round(limits.limitMs / 60_000)} min of the push, after a wait of ${waited()}`,
        };
      }
    }
    await sleep(limits.pollMs);
  }
}

export async function resolveRunnerImageAfterWait({ resolve, wait }) {
  const first = await resolve();
  if (!WAITS_FOR.includes(first.reason)) return first;
  const waited = await wait(resolve);
  const last = waited.resolved ?? await resolve();
  return { ...last, detail: `${last.detail}; ${waited.detail}` };
}

/** @param {string[]} argv */
export function parseResolveArguments(argv) {
  const [command, flag, directory, ...rest] = argv;
  const wait = command === "resolve" && rest.length === 1 && rest[0] === "--wait";
  if (!["inputs", "resolve"].includes(command) || flag !== "--dir" || !directory || directory.startsWith("--") || (rest.length > 0 && !wait)) {
    throw new Error("Usage: runner-image-resolve.mjs inputs --dir <directory> | resolve --dir <directory> [--wait]");
  }
  return { command, directory: path.resolve(directory), wait };
}

/**
 * @param {string[]} argv
 * @param {{
 *   env?: NodeJS.ProcessEnv, repoRoot?: string, read?: typeof readRunnerImageManifest, readInputs?: typeof readRunnerInputs,
 *   log?: (line: string) => void, waitFor?: typeof waitForRunnerImage, fetchImpl?: typeof fetch,
 * }} [options]
 * @returns {Promise<Record<string, string>>}
 */
export async function runResolveCommand(argv, {
  env = process.env,
  repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."),
  read = readRunnerImageManifest,
  readInputs = readRunnerInputs,
  log = console.error,
  waitFor = waitForRunnerImage,
  fetchImpl = fetch,
} = {}) {
  const { command, directory, wait } = parseResolveArguments(argv);
  if (command === "inputs") {
    const inputs = readInputs({ repoRoot, directory });
    return { lock: inputs.lock ?? "", inputs_digest: inputs.inputsDigest ?? "" };
  }
  const inputs = JSON.parse(readFileSync(path.join(directory, INPUTS_FILE), "utf8"));
  const resolve = () => resolveRunnerImage(inputs, { read, credentials: environmentCredentials(env) });
  const sha = env.GITHUB_SHA;
  const token = env.GITHUB_TOKEN;
  const resolved = wait
    ? await resolveRunnerImageAfterWait({
      resolve,
      wait: async () => {
        if (!REVISION.test(sha ?? "") || !token) return { outcome: "unknown", detail: "no commit or no token to find its Runner image run with" };
        try {
          return await waitFor({ sha, resolve, listRuns: (commit) => listRunnerImageRuns(commit, { token, fetchImpl }) });
        } catch (error) {
          return { outcome: "unknown", detail: `the wait failed: ${message(error)}` };
        }
      },
    })
    : await resolve();
  log(`Runner image: ${resolved.mode} (${resolved.reason}: ${resolved.detail})`);
  if (resolved.mode === "inline") {
    log(`::notice title=Runner built inline::This image build makes its own Runner (${resolved.reason}: ${resolved.detail}).`);
  }
  if (env.GITHUB_STEP_SUMMARY) {
    appendFileSync(env.GITHUB_STEP_SUMMARY, [
      `Runner for an image build of this tree: **${resolved.mode}** (\`${resolved.reason}\`: ${resolved.detail})`,
      `- inputs digest: ${resolved.inputsDigest ? `\`${resolved.inputsDigest}\`` : "not computed"}`,
      ...(resolved.mode === "published" ? [`- full image: \`${resolved.image}\``, `- slim image: \`${resolved.slimImage}\``] : []),
      "",
    ].join("\n"));
  }
  return {
    mode: resolved.mode,
    reason: resolved.reason,
    inputs_digest: resolved.inputsDigest,
    image: resolved.image,
    slim_image: resolved.slimImage,
    build_contexts: resolved.buildContexts.join("\n"),
    labels: resolved.labels.join("\n"),
    build_args: resolved.buildArgs.join("\n"),
  };
}

/** @param {Record<string, string>} values written as $GITHUB_OUTPUT takes them, a value of several lines included */
export function formatOutputs(values) {
  return Object.entries(values).map(([name, value]) => {
    if (!value.includes("\n")) return `${name}=${value}`;
    const delimiter = `end-${randomUUID()}`;
    return `${name}<<${delimiter}\n${value}\n${delimiter}`;
  }).join("\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const text = formatOutputs(await runResolveCommand(process.argv.slice(2)));
    console.log(text);
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${text}\n`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
