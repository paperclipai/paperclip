#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { imageExists, versionFor } from "./preview-artifacts.mjs";
import { verifyPublished } from "./cloud-migrator-artifacts.mjs";

const repository = "paperclipai/paperclip";
const workflow = ".github/workflows/cloud-migrator-artifacts.yml";

export async function migratorPublished(sha, fetchImpl, token) {
  let pending = false;
  const failures = [];
  for (let page = 1; page <= 10; page++) {
    const response = await fetchImpl(`https://api.github.com/repos/${repository}/actions/workflows/cloud-migrator-artifacts.yml/runs?branch=master&head_sha=${sha}&per_page=100&page=${page}`, {
      headers: { Accept: "application/vnd.github+json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      redirect: "error", signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`Migrator producer lookup failed: HTTP ${response.status}`);
    const body = await response.json();
    if (!Array.isArray(body.workflow_runs) || !Number.isSafeInteger(body.total_count) || body.total_count < 0 ||
        (page === 1 && (body.total_count === 0) !== (body.workflow_runs.length === 0))) throw new Error("Invalid migrator producer response.");
    if (body.total_count === 0) return false;
    for (const run of body.workflow_runs) {
      if (run.head_sha !== sha || run.head_branch !== "master" || run.path !== workflow ||
          run.head_repository?.id !== 1170821064 || run.head_repository.full_name !== repository ||
          !["push", "workflow_dispatch"].includes(run.event)) throw new Error("Migrator producer identity mismatch.");
      // Publication is immutable. A later failed manual run must not hide a
      // successful exact-source publisher; the signed bundle is checked next.
      if (run.status === "completed" && run.conclusion === "success") return true;
      if (run.status !== "completed") pending = true;
      else failures.push(`${run.id}: ${run.conclusion}`);
    }
    if (page * 100 >= body.total_count) {
      if (pending) return false;
      throw new Error(`Migrator producers failed: ${failures.join(", ")}.`);
    }
  }
  throw new Error("Too many migrator producer runs to establish publication.");
}

export function verifyManifestProvenance(bytes, sha, { exec = execFileSync } = {}) {
  versionFor(sha);
  const scratch = mkdtempSync(path.join(os.tmpdir(), "cloud-readiness-attestation-"));
  try {
    const file = path.join(scratch, "manifest.json");
    writeFileSync(file, bytes);
    exec("gh", ["attestation", "verify", file, "--repo", repository,
      "--source-digest", sha, "--source-ref", "refs/heads/master",
      "--cert-identity", `https://github.com/${repository}/${workflow}@refs/heads/master`,
      "--deny-self-hosted-runners"], { stdio: "inherit", timeout: 60_000 });
  } finally { rmSync(scratch, { recursive: true, force: true }); }
}

/** Read-only availability gate. Deployment still resolves and pins artifacts. */
export async function waitForCloudArtifacts(sha, {
  fetchImpl = fetch,
  token = process.env.GH_TOKEN,
  verifyProvenance = verifyManifestProvenance,
  now = () => performance.now(),
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  timeoutMs = 30 * 60_000,
  intervalMs = 20_000,
  log = console.log,
} = {}) {
  const version = versionFor(sha);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || !Number.isFinite(intervalMs) || intervalMs <= 0) {
    throw new Error("Cloud readiness requires positive finite timeout and poll interval.");
  }
  const deadline = now() + timeoutMs;
  let previous;
  let missing = ["image", "migrator"];
  while (now() < deadline) {
    // Recheck the image and exact-source publisher on the successful poll.
    // Only a missing/pending producer waits; failed publication fails closed.
    const results = await Promise.all([
      imageExists(sha, fetchImpl),
      migratorPublished(sha, fetchImpl, token),
    ]);
    missing = ["image", "migrator"].filter((_, index) => !results[index]);
    if (missing.length === 0) {
      // Verify the exact signed bytes and all pinned downloads after the
      // publisher succeeds. An inaccessible or corrupt artifact cannot pass.
      await verifyPublished(sha, fetchImpl, { verifyProvenance });
      log(`Cloud artifacts available for ${sha}: verified image and exact-source migrator ${version}.`);
      return { version: 1, sha, packageVersion: version };
    }
    const state = missing.join(", ");
    if (state !== previous) log(`Waiting for cloud artifacts for ${sha}: ${state}.`);
    previous = state;
    const remaining = deadline - now();
    if (remaining > 0) await sleep(Math.min(intervalMs, remaining));
  }
  throw new Error(`Cloud artifacts timed out for ${sha}; missing: ${missing.join(", ")}.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { await waitForCloudArtifacts(process.argv[2]); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
