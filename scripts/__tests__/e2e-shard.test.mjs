import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { loadShardDurations } from "../general-server-shard.mjs";
import { IGNORED_SPECS, listE2eSpecs, selectE2eShard } from "../e2e-shard.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const script = path.join(repoRoot, "scripts", "e2e-shard.mjs");
const durationsManifest = path.join(repoRoot, "scripts", "e2e-shard-durations.json");
const playwrightConfig = path.join(repoRoot, "tests", "e2e", "playwright.config.ts");
const prWorkflow = path.join(repoRoot, ".github", "workflows", "pr.yml");

const SHARD_COUNT = 3;

function runShard(args) {
  const result = spawnSync(process.execPath, [script, ...args], { cwd: repoRoot, encoding: "utf8" });
  assert.equal(result.status, 0, `expected success for ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim().split(/\s+/).filter(Boolean);
}

test("the e2e shards form a complete, non-overlapping partition", () => {
  const specs = listE2eSpecs();
  assert.ok(specs.length > 0, "expected a non-empty e2e spec set");

  const shards = Array.from({ length: SHARD_COUNT }, (_, index) =>
    runShard(["--shard-index", String(index), "--shard-count", String(SHARD_COUNT)]),
  );

  const combined = shards.flat();
  assert.equal(combined.length, specs.length, "every spec must land on exactly one shard");
  assert.deepEqual([...combined].sort(), [...specs].sort());
  for (const shard of shards) {
    assert.ok(shard.length > 0, "no shard may be empty — Playwright fails a run with no matching specs");
  }
});

test("the ignored spec list matches playwright.config.ts testIgnore", () => {
  const config = readFileSync(playwrightConfig, "utf8");
  const match = config.match(/testIgnore:\s*\[([^\]]*)\]/);
  assert.ok(match, "expected a testIgnore array in playwright.config.ts");
  const configured = [...match[1].matchAll(/"([^"]+)"/g)].map((entry) => entry[1]);
  assert.deepEqual([...configured].sort(), [...IGNORED_SPECS].sort());
});

test("the duration manifest only names specs that still exist", () => {
  const durations = loadShardDurations(durationsManifest);
  assert.ok(Object.keys(durations).length > 0, "expected a populated duration manifest");
  const specs = new Set(listE2eSpecs());
  for (const file of Object.keys(durations)) {
    assert.ok(specs.has(file), `duration manifest names a spec that no longer runs: ${file}`);
  }
});

test("the weighted partition keeps the shards close to balanced", () => {
  const durations = loadShardDurations(durationsManifest);
  const specs = listE2eSpecs();
  const weights = Array.from({ length: SHARD_COUNT }, (_, index) =>
    selectE2eShard(specs, index, SHARD_COUNT, durations).reduce((sum, file) => sum + (durations[file] ?? 0), 0),
  );

  const heaviest = Math.max(...weights);
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  // Round-robin/count-based sharding would strand the ~168s smoke-lab spec on
  // one runner alongside other specs. Assert the weighted split stays within
  // 15% of an even cut so a future spec-time regression surfaces here instead
  // of on the PR critical path. A single indivisible spec (smoke-lab) can
  // legitimately exceed the even cut on its own, so the bound is floored at
  // the largest per-spec weight — the best any file-level partition can do.
  const largestSpec = Math.max(...specs.map((file) => durations[file] ?? 0));
  const bound = Math.max((total / SHARD_COUNT) * 1.15, largestSpec);
  assert.ok(
    heaviest <= bound,
    `heaviest shard ${heaviest}ms exceeds the balance bound (${bound}ms)`,
  );
});

test("shard arguments are validated", () => {
  for (const args of [
    ["--shard-index", "2", "--shard-count", "2"],
    ["--shard-index", "-1", "--shard-count", "2"],
    ["--shard-index", "0", "--shard-count", "0"],
  ]) {
    const result = spawnSync(process.execPath, [script, ...args], { cwd: repoRoot, encoding: "utf8" });
    assert.notEqual(result.status, 0, `expected failure for ${args.join(" ")}`);
  }
});

test("pr.yml keeps a stable aggregate check named e2e over the shard matrix", () => {
  // Branch protection requires a check literally named `e2e`. The shards run
  // as `e2e shard (n/3)`, so the aggregate job below is what keeps the
  // required-check contract intact — same pattern as the `verify` aggregate.
  const workflow = readFileSync(prWorkflow, "utf8");
  const jobs = new Map();
  let current = null;
  for (const line of workflow.split("\n")) {
    const header = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(line);
    if (header) {
      current = header[1];
      jobs.set(current, []);
      continue;
    }
    if (current && /^\S/.test(line)) current = null;
    if (current) jobs.get(current).push(line);
  }
  for (const [id, lines] of jobs) jobs.set(id, lines.join("\n"));

  const aggregate = jobs.get("e2e");
  assert.ok(aggregate, "pr.yml must define an `e2e` job to satisfy branch protection");
  assert.match(aggregate, /^ {4}name: e2e$/m, "the aggregate job must be named exactly `e2e`");
  assert.match(aggregate, /^ {4}if: \$\{\{ always\(\) \}\}$/m, "the aggregate must run even when a shard fails");
  assert.match(aggregate, /^ {4}needs: \[e2e_shards\]$/m, "the aggregate must depend on the shard matrix");
  assert.match(
    aggregate,
    /test "\$E2E_SHARDS_RESULT" = "success"/,
    "the aggregate must fail unless every shard succeeded",
  );

  const shards = jobs.get("e2e_shards");
  assert.ok(shards, "pr.yml must define the `e2e_shards` matrix job");
  const matrixEntries = [
    ...shards.matchAll(
      /^ {10}- shard_index: (?<shardIndex>\d+)\n {12}shard_count: (?<shardCount>\d+)\n {12}shard_label: (?<shardLabel>\d+\/\d+)$/gm,
    ),
  ].map((match) => ({
    shardIndex: Number(match.groups.shardIndex),
    shardCount: Number(match.groups.shardCount),
    shardLabel: match.groups.shardLabel,
  }));

  assert.equal(matrixEntries.length, SHARD_COUNT, "the shard matrix must define exactly SHARD_COUNT entries");
  assert.deepEqual(
    matrixEntries.map((entry) => entry.shardIndex).sort((a, b) => a - b),
    Array.from({ length: SHARD_COUNT }, (_, index) => index),
    "the shard matrix must define each shard index exactly once",
  );
  for (const entry of matrixEntries) {
    assert.equal(entry.shardCount, SHARD_COUNT, "each shard matrix entry must use the same SHARD_COUNT");
    assert.equal(entry.shardLabel, `${entry.shardIndex + 1}/${SHARD_COUNT}`, "each shard label must match its index");
  }
});
