#!/usr/bin/env node
// Batched npm registry version queries for the release tooling.
//
// The release flow needs published-version data for every public workspace
// package. Querying them one `npm view` at a time is serial network latency
// that dominates the non-build time of `release.sh` (and the PR workflow's
// Canary Dry Run job). This helper runs the same `npm view` queries with
// bounded concurrency instead.
//
// Usage:
//   node scripts/release-registry-versions.mjs fetch <pkg...>
//     Prints a JSON object mapping each package name to its published
//     versions array. Packages that are missing from the registry (or fail
//     to resolve) map to [].
//
//   node scripts/release-registry-versions.mjs assert-absent <version> <pkg...>
//     Freshly checks that <version> is not published for any <pkg>. Exits 0
//     when absent everywhere; prints the offending package@version pairs to
//     stderr and exits 1 otherwise.

import { execFile } from "node:child_process";

const CONCURRENCY = Number(process.env.RELEASE_REGISTRY_CONCURRENCY || 10);
if (!Number.isInteger(CONCURRENCY) || CONCURRENCY < 1) {
  console.error("RELEASE_REGISTRY_CONCURRENCY must be a positive integer.");
  process.exit(2);
}

function npmView(args) {
  return new Promise((resolve) => {
    execFile("npm", ["view", ...args], { encoding: "utf8" }, (error, stdout) => {
      if (error) {
        resolve(null);
        return;
      }
      resolve(stdout.trim());
    });
  });
}

async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;

  async function worker() {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await fn(items[index]);
    }
  }

  const workers = [];
  for (let i = 0; i < Math.min(limit, items.length); i += 1) {
    workers.push(worker());
  }
  await Promise.all(workers);
  return results;
}

async function fetchVersions(packageNames) {
  const versionLists = await mapWithConcurrency(packageNames, CONCURRENCY, async (packageName) => {
    const raw = await npmView([packageName, "versions", "--json"]);
    if (!raw) return [];
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [parsed];
    } catch {
      return [];
    }
  });

  const map = {};
  packageNames.forEach((packageName, index) => {
    map[packageName] = versionLists[index];
  });
  return map;
}

async function assertAbsent(version, packageNames) {
  const resolved = await mapWithConcurrency(packageNames, CONCURRENCY, async (packageName) => {
    const raw = await npmView([`${packageName}@${version}`, "version"]);
    return raw === version ? packageName : null;
  });

  return resolved.filter((packageName) => packageName !== null);
}

const [mode, ...rest] = process.argv.slice(2);

if (mode === "fetch") {
  if (rest.length === 0) {
    console.error("usage: release-registry-versions.mjs fetch <pkg...>");
    process.exit(2);
  }
  const map = await fetchVersions(rest);
  process.stdout.write(`${JSON.stringify(map)}\n`);
} else if (mode === "assert-absent") {
  const [version, ...packageNames] = rest;
  if (!version || packageNames.length === 0) {
    console.error("usage: release-registry-versions.mjs assert-absent <version> <pkg...>");
    process.exit(2);
  }
  const existing = await assertAbsent(version, packageNames);
  if (existing.length > 0) {
    for (const packageName of existing) {
      console.error(`npm version ${packageName}@${version} already exists.`);
    }
    process.exit(1);
  }
} else {
  console.error("usage: release-registry-versions.mjs <fetch|assert-absent> ...");
  process.exit(2);
}
