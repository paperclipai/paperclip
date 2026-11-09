// Duration-balanced partitions of the Runner package Vitest inventory. The PR
// workflow runs one partition per job (`--package-lane=K/N`) so the package
// tests no longer serialize behind two workers in a single job. Vitest owns
// the inventory: it is listed from vitest.config.ts, never re-globbed here.
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadShardDurations, partitionGeneralServerSuites } from "../../../scripts/general-server-shard.mjs";

export const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const laneDurationsPath = resolve(packageRoot, "scripts/vitest-lane-durations.json");
// Manifest keys are repository-relative, matching the server shard manifests.
export const repoPrefix = "packages/paperclip-runner/";

const toPosix = (value) => value.replaceAll("\\", "/");

// Package-relative test files exactly as vitest.config.ts includes them.
export function listPackageVitestFiles({ env = process.env } = {}) {
  const vitestBin = resolve(dirname(createRequire(resolve(packageRoot, "package.json")).resolve("vitest/package.json")), "vitest.mjs");
  // Listing must not register a CI profile invocation: it runs no tests.
  const listEnv = { ...env, PAPERCLIP_CI_PROFILE: "" };
  // `--json` takes an optional output path: keep it last so it prints to stdout.
  const result = spawnSync(process.execPath, [vitestBin, "list", "--filesOnly", "--json"], {
    cwd: packageRoot,
    encoding: "utf8",
    env: listEnv,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(`vitest list failed (${result.status ?? result.signal}): ${result.stderr || result.stdout}`);
  }
  const start = result.stdout.indexOf("[");
  const entries = JSON.parse(result.stdout.slice(start));
  const files = [...new Set(entries.map((entry) => {
    const file = typeof entry === "string" ? entry : entry.file;
    return toPosix(isAbsolute(file) ? relative(packageRoot, file) : file);
  }))].sort((a, b) => a.localeCompare(b));
  if (files.length === 0 || files.some((file) => file.startsWith("../"))) {
    throw new Error(`vitest list returned an unexpected inventory: ${JSON.stringify(files.slice(0, 5))}`);
  }
  return files;
}

// Vitest treats each CLI filter as a case-insensitive substring of the file's
// root-relative path. A file whose path ends another file's path (src/x.test.ts
// within devtools/browser/src/x.test.ts) therefore also selects the longer one.
export function filesMatchedByFilters(filters, inventory) {
  const lowered = filters.map((filter) => filter.toLowerCase());
  return inventory.filter((file) => lowered.some((filter) => file.toLowerCase().includes(filter)));
}

// Splits the package inventory into `laneCount` lanes, heaviest file first,
// with the deterministic partitioner the general server shards use. Every
// runner computes the identical partition from the same checkout, so the
// lanes are a complete, non-overlapping cover of the inventory.
export function planPackageLanes(files, laneCount, durations = loadShardDurations(laneDurationsPath)) {
  if (!Number.isSafeInteger(laneCount) || laneCount < 1) throw new Error(`Invalid package lane count: ${laneCount}`);
  return partitionGeneralServerSuites(files.map((file) => repoPrefix + file), laneCount, durations).map((lane) => ({
    files: lane.files.map((file) => file.slice(repoPrefix.length)),
    estimatedMs: lane.totalWeight,
  }));
}
