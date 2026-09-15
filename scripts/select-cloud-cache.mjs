#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export function cloudCacheCandidates(image, commits) {
  if (!/^ghcr\.io\/[a-z0-9._-]+\/[a-z0-9._-]+$/.test(image ?? "")) {
    throw new Error("Expected a GHCR owner/repository cache image.");
  }
  if (!Array.isArray(commits) || commits.length === 0 || commits.some((sha) => !/^[a-f0-9]{40}$/.test(sha))) {
    throw new Error("Cloud cache ancestry requires full commit SHAs.");
  }
  return [
    ...[...new Set(commits)].slice(0, 10).map((sha) => `${image}:buildcache-cloud-${sha}`),
    `${image}:buildcache-cloud`,
  ];
}

export async function selectCloudCache(image, commits, {
  exists = registryCacheExists,
  log = console.log,
} = {}) {
  for (const ref of cloudCacheCandidates(image, commits)) {
    try {
      if (!await exists(ref)) continue;
      log(`Using cloud cache: ${ref}`);
      return `type=registry,ref=${ref}`;
    } catch {
      // Cache availability must not turn an otherwise valid build into a
      // failure. A later ancestor may still be available during a rollout.
      log(`Could not inspect cloud cache ${ref}; trying the next ancestor.`);
    }
  }
  log("No cloud cache is available; this build will populate one.");
  return "";
}

function registryCacheExists(ref) {
  try {
    // Use the preceding Docker login, including for private registry caches.
    // Inspect metadata only: no layer download and no image execution.
    execFileSync("docker", ["buildx", "imagetools", "inspect", "--raw", ref], {
      timeout: 10_000,
      maxBuffer: 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return true;
  } catch (error) {
    if (/manifest unknown|not found|NAME_UNKNOWN/i.test(String(error.stderr ?? ""))) return false;
    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (!process.env.GITHUB_OUTPUT) throw new Error("GITHUB_OUTPUT is required.");
    const commits = execFileSync("git", ["rev-list", "--first-parent", "--max-count=10", "HEAD"], {
      encoding: "utf8",
    }).trim().split("\n");
    const source = await selectCloudCache(process.env.CACHE_IMAGE, commits, { exists: registryCacheExists });
    appendFileSync(process.env.GITHUB_OUTPUT, `source=${source}\n`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
