import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  defaultSuiteWeight,
  loadShardDurations,
  partitionGeneralServerSuites,
} from "../general-server-shard.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const script = path.join(repoRoot, "scripts", "run-vitest-stable.mjs");
const durationsManifest = path.join(repoRoot, "scripts", "general-server-shard-durations.json");

function dryRun(args) {
  const result = spawnSync(process.execPath, [script, ...args, "--dry-run"], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  return result;
}

function dryRunJson(args) {
  const result = dryRun(args);
  assert.equal(result.status, 0, `expected success for ${args.join(" ")}: ${result.stderr}`);
  return JSON.parse(result.stdout);
}

const SHARD_COUNT = 3;

test("the general-server shards form a complete, non-overlapping partition", () => {
  const shards = Array.from({ length: SHARD_COUNT }, (_, index) =>
    dryRunJson(["--mode", "general", "--group", "general-server", "--shard-index", String(index), "--shard-count", String(SHARD_COUNT)]),
  );

  const total = shards[0].generalServerSuiteCount;
  assert.ok(total > 0, "expected a non-empty general-server suite set");

  const seen = new Set();
  let selectedTotal = 0;
  for (const shard of shards) {
    assert.equal(shard.generalServerSuiteCount, total, "suite count must be stable across shards");
    for (const file of shard.selectedGeneralServerSuites) {
      assert.ok(!seen.has(file), `suite assigned to more than one shard: ${file}`);
      seen.add(file);
      selectedTotal += 1;
    }
  }

  // Every suite runs exactly once: union covers the whole set with no overlap.
  assert.equal(selectedTotal, total, "every suite must be selected exactly once");
  assert.equal(seen.size, total, "union of shards must cover the whole suite set");
});

test("a route/authz suite never leaks into the general-server shards", () => {
  const shard = dryRunJson(["--mode", "general", "--group", "general-server", "--shard-index", "0", "--shard-count", SHARD_COUNT.toString()]);
  for (const file of shard.selectedGeneralServerSuites) {
    assert.ok(
      !/[^/]*(?:route|routes|authz)[^/]*\.test\.ts$/.test(file),
      `route/authz suite must stay in the serialized lane, not general-server: ${file}`,
    );
  }
});

test("shard flags are rejected for the parallel workspace groups", () => {
  const result = dryRun(["--mode", "general", "--group", "general-workspaces-a", "--shard-index", "0", "--shard-count", "3"]);
  assert.notEqual(result.status, 0, "workspace groups must not accept shard flags");
});

test("duration-aware partition balances skewed weights better than round-robin", () => {
  // Round-robin puts all three heavy suites on shard 0 (indexes 0, 3, 6).
  const files = ["a", "b", "c", "d", "e", "f", "g", "h", "i"];
  const durations = { a: 30000, d: 30000, g: 30000, b: 100, c: 100, e: 100, f: 100, h: 100, i: 100 };

  const shards = partitionGeneralServerSuites(files, 3, durations);
  const totals = shards.map((shard) => shard.totalWeight);
  const maxTotal = Math.max(...totals);
  const minTotal = Math.min(...totals);
  assert.ok(
    maxTotal - minTotal <= 200,
    `expected near-even shard weights, got ${totals.join(", ")}`,
  );
  assert.equal(
    shards.flatMap((shard) => shard.files).sort().join(","),
    files.join(","),
    "partition must cover every file exactly once",
  );
});

test("the partition is deterministic for identical inputs", () => {
  const files = Array.from({ length: 50 }, (_, index) => `suite-${index}.test.ts`);
  const durations = Object.fromEntries(files.map((file, index) => [file, (index * 37) % 5000]));

  const first = partitionGeneralServerSuites(files, 3, durations);
  const second = partitionGeneralServerSuites(files, 3, durations);
  assert.deepEqual(first, second, "same inputs must always produce the same partition");
});

test("suites missing from the manifest get the median weight", () => {
  assert.equal(defaultSuiteWeight({ a: 100, b: 300, c: 900 }), 300);
  assert.equal(defaultSuiteWeight({ a: 100, b: 300, c: 500, d: 900 }), 400);
  assert.equal(defaultSuiteWeight({}), 1000, "empty manifest falls back to a fixed weight");
});

test("a missing or malformed manifest degrades to uniform weights", () => {
  assert.deepEqual(loadShardDurations(path.join(repoRoot, "scripts", "no-such-manifest.json")), {});

  const files = ["a", "b", "c", "d"];
  const shards = partitionGeneralServerSuites(files, 2, {});
  assert.equal(shards[0].files.length + shards[1].files.length, files.length);
  assert.equal(Math.abs(shards[0].files.length - shards[1].files.length), 0);
});

test("the checked-in manifest loads and covers most of the current suite set", () => {
  const durations = loadShardDurations(durationsManifest);
  assert.ok(Object.keys(durations).length > 0, "manifest must parse to a non-empty duration map");

  const shard = dryRunJson(["--mode", "general", "--group", "general-server", "--shard-index", "0", "--shard-count", "1"]);
  const currentFiles = shard.selectedGeneralServerSuites;
  const known = currentFiles.filter((file) => durations[file] !== undefined).length;
  assert.ok(
    known / currentFiles.length >= 0.5,
    `manifest is stale: only ${known} of ${currentFiles.length} suites have recorded durations — regenerate it from a recent PR run (see the manifest's $comment)`,
  );
});

test("the real shard partition is duration-balanced", () => {
  const durations = loadShardDurations(durationsManifest);
  const fallback = defaultSuiteWeight(durations);
  const shards = Array.from({ length: SHARD_COUNT }, (_, index) =>
    dryRunJson(["--mode", "general", "--group", "general-server", "--shard-index", String(index), "--shard-count", String(SHARD_COUNT)]),
  );

  const totals = shards.map((shard) =>
    shard.selectedGeneralServerSuites.reduce((sum, file) => sum + (durations[file] ?? fallback), 0),
  );
  const maxTotal = Math.max(...totals);
  const minTotal = Math.min(...totals);
  // LPT keeps the spread within the heaviest single suite; use that as the bound.
  const heaviest = Math.max(...Object.values(durations));
  assert.ok(
    maxTotal - minTotal <= heaviest,
    `shard weight spread ${maxTotal - minTotal}ms exceeds heaviest suite ${heaviest}ms: ${totals.join(", ")}`,
  );
});
