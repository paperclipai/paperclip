#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import { imageExists, packageExists, versionFor } from "./preview-artifacts.mjs";

/** Read-only availability gate. Deployment still resolves and pins artifacts. */
export async function waitForCloudArtifacts(sha, {
  fetchImpl = fetch,
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
  let missing = ["image", "shared", "db"];
  while (now() < deadline) {
    // Recheck every artifact on the successful poll. Only an explicit 404
    // means publication is pending; identity errors and upstream outages fail.
    const results = await Promise.all([
      imageExists(sha, fetchImpl),
      packageExists("@paperclipai/shared", sha, fetchImpl),
      packageExists("@paperclipai/db", sha, fetchImpl),
    ]);
    missing = ["image", "shared", "db"].filter((_, index) => !results[index]);
    if (missing.length === 0) {
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
