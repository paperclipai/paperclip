import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  defaultSuiteWeight,
  loadShardDurations,
  partitionGeneralServerSuites,
} from "../general-server-shard.mjs";

import { assertManifestSource } from "../ci/pr-run-durations.mjs";
import { assertSelectedTests, partitionTestLines } from "../test-line-shard.mjs";
import { chatManifestData } from "../ci/refresh-chat-shard-durations.mjs";
import { defaultServerParallelWorkers } from "../ci/vitest-workers.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const script = path.join(repoRoot, "scripts", "run-vitest-stable.mjs");
const durationsManifest = path.join(repoRoot, "scripts", "general-server-shard-durations.json");
const serializedDurationsManifest = path.join(
  repoRoot,
  "scripts",
  "serialized-shard-durations.json",
);

// Membership of general-server-without-chat depends on GITHUB_WORKFLOW (see
// prWorkflowName in run-vitest-stable.mjs), so strip the ambient value and
// make every test pin the caller it mirrors explicitly — these tests
// themselves run inside a workflow on CI.
function workflowEnv(envOverrides = {}) {
  const env = { ...process.env, ...envOverrides };
  for (const key of [
    "GITHUB_WORKFLOW",
    "PAPERCLIP_CI_FULL",
    "PAPERCLIP_CI_EXCLUDE_NIGHTLY",
    "PAPERCLIP_CI_NIGHTLY_SUITES_FILE",
    "PAPERCLIP_VITEST_MAX_WORKERS",
    "PAPERCLIP_VITEST_CPU_COUNT",
    "PAPERCLIP_TEST_POSTGRES_ADMIN_URL",
  ]) {
    if (!(key in envOverrides)) {
      delete env[key];
    }
  }
  return env;
}

function dryRun(args, envOverrides = {}) {
  const result = spawnSync(process.execPath, [script, ...args, "--dry-run"], {
    cwd: repoRoot,
    encoding: "utf8",
    env: workflowEnv(envOverrides),
  });
  return result;
}

function dryRunJson(args, envOverrides = {}) {
  const result = dryRun(args, envOverrides);
  assert.equal(result.status, 0, `expected success for ${args.join(" ")}: ${result.stderr}`);
  return JSON.parse(result.stdout);
}

const SHARD_COUNT = 12;
const SERIALIZED_SHARD_COUNT = 9;

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
      assert.ok(
        !(file.startsWith("server/src/__tests__/") && /[^/]*(?:route|routes|authz)[^/]*\.test\.ts$/.test(file)),
        `route/authz suite must stay in the serialized lane, not general-server: ${file}`,
      );
      assert.ok(!seen.has(file), `suite assigned to more than one shard: ${file}`);
      seen.add(file);
      selectedTotal += 1;
    }
  }

  // Every suite runs exactly once: union covers the whole set with no overlap.
  assert.equal(selectedTotal, total, "every suite must be selected exactly once");
  assert.equal(seen.size, total, "union of shards must cover the whole suite set");
});

test("general shards retain scripts and route-named suites outside the serialized directory", () => {
  const general = dryRunJson(["--mode", "general", "--group", "general-server", "--shard-index", "0", "--shard-count", "1"]);
  for (const file of [
    "server/scripts/verify-runner-vendor-dependencies.test.mjs",
    "server/src/services/openrouter-models.test.ts",
    "server/src/routes/setup-token-route.test.ts",
  ]) assert.ok(general.selectedGeneralServerSuites.includes(file), `missing configured server suite: ${file}`);
});

test("shard flags are rejected for the general-workspaces-c group", () => {
  const result = dryRun(["--mode", "general", "--group", "general-workspaces-c", "--shard-index", "0", "--shard-count", "3"]);
  assert.notEqual(result.status, 0, "general-workspaces-c must not accept shard flags");
});

test("workspace lanes cover every non-server project in the root Vitest configuration", () => {
  const config = readFileSync(path.join(repoRoot, "vitest.config.ts"), "utf8");
  const roots = [...config.matchAll(/^\s+"([^"]+)",?\s*$/gm)].map(match => match[1]);
  assert.ok(roots.includes("server"), "expected the explicit root Vitest project list");
  const expected = roots.filter(root => root !== "server")
    .map(root => JSON.parse(readFileSync(path.join(repoRoot, root, "package.json"), "utf8")).name).sort();
  const actual = ["general-workspaces-a", "general-workspaces-b", "general-workspaces-c"]
    .flatMap(group => dryRunJson(["--mode", "general", "--group", group]).workspaceProjects).sort();
  assert.deepEqual(actual, expected, "no configured project may be silently omitted or run twice");
});

// Collects every `- group:` matrix entry in a workflow with the keys it sets.
// Comment and blank lines are dropped first, and an entry ends only when the
// indentation returns to the item level, so a comment between two keys cannot
// hide a shard setting from the assertions below.
function matrixEntries(text) {
  const entries = [];
  let current = null;
  for (const line of text.split("\n")) {
    if (/^\s*(#|$)/.test(line)) continue;
    const indent = line.match(/^ */)[0].length;
    const item = line.match(/^ *- group: (\S+)/);
    if (item) {
      current = { group: item[1], indent, keys: ["group"] };
      entries.push(current);
      continue;
    }
    if (!current) continue;
    if (indent <= current.indent) { current = null; continue; }
    const key = line.match(/^ *([A-Za-z_]+):/);
    if (key) current.keys.push(key[1]);
  }
  return entries;
}

test("matrixEntries sees shard keys that sit behind comments or later in the entry", () => {
  const entries = matrixEntries([
    "        include:",
    "          - group: general-workspaces-b",
    "            group_label: workspaces-b",
    "            # a comment between keys must not hide the shard setting",
    "            shard_index: 0",
    "",
    "            shard_count: 3",
    "          - group: general-workspaces-c",
    "            group_label: workspaces-c",
    "      steps:",
    "        - name: unrelated",
    "          shard_index: 9",
  ].join("\n"));
  assert.deepEqual(entries.map(entry => entry.group), ["general-workspaces-b", "general-workspaces-c"]);
  assert.deepEqual(entries[0].keys, ["group", "group_label", "shard_index", "shard_count"]);
  assert.deepEqual(entries[1].keys, ["group", "group_label"], "keys after the matrix must not leak into the last entry");
});

test("workspaces-c runs the db project alone and workspaces-b no longer carries it", () => {
  // The db project was 168-250s of the 436-513s workspaces-b vitest time
  // (PR runs 38084171761, 38083084276 and 38083020834, 2026-10-10), so it
  // runs in its own lane. The PR and release matrices both carry that lane.
  const workspacesC = dryRunJson(["--mode", "general", "--group", "general-workspaces-c"]);
  assert.deepEqual(workspacesC.workspaceProjects, ["@paperclipai/db"]);
  assert.equal(workspacesC.workspacesVitestShard, null);
  const workspacesB = dryRunJson(["--mode", "general", "--group", "general-workspaces-b"]);
  assert.ok(!workspacesB.workspaceProjects.includes("@paperclipai/db"), "db must not run twice");
  assert.ok(workspacesB.workspaceProjects.length > 0, "workspaces-b must still run its other projects");
  for (const workflow of ["pr-trusted.yml", "release-verify.yml"]) {
    const entries = workflow === "pr-trusted.yml"
      ? JSON.parse(readFileSync(path.join(repoRoot, ".github/ci-task-matrix.json"), "utf8")).general_tests
        .map((entry) => ({ ...entry, keys: Object.keys(entry) }))
      : matrixEntries(readFileSync(path.join(repoRoot, ".github", "workflows", workflow), "utf8"));
    // The parser must demonstrably see shard keys in this workflow, otherwise
    // the unsharded assertions below could pass for the wrong reason.
    const sharded = entries.filter(entry => entry.group === "general-workspaces-a");
    assert.ok(sharded.length > 0 && sharded.every(entry => entry.keys.includes("shard_index") && entry.keys.includes("shard_count")),
      `${workflow} must carry the sharded workspaces-a entries`);
    const workspacesCEntries = entries.filter(entry => entry.group === "general-workspaces-c");
    assert.equal(workspacesCEntries.length, 1, `${workflow} must run general-workspaces-c exactly once`);
    assert.ok(workspacesCEntries[0].keys.includes("group_label"), `${workflow} must label the general-workspaces-c job`);
    assert.deepEqual(workspacesCEntries[0].keys.filter(key => key.startsWith("shard_")), [], `${workflow} must run general-workspaces-c unsharded`);

    const workspacesBEntries = entries.filter(entry => entry.group === "general-workspaces-b");
    assert.ok(workspacesBEntries.length >= 1, `${workflow} must run general-workspaces-b`);
    assert.ok(workspacesBEntries.every(entry => entry.keys.includes("group_label")), `${workflow} must label every general-workspaces-b job`);
    if (workspacesBEntries.length === 1) {
      assert.deepEqual(workspacesBEntries[0].keys.filter(key => key.startsWith("shard_")), [], `${workflow} single general-workspaces-b entry must be unsharded`);
    } else {
      assert.ok(workspacesBEntries.every(entry => entry.keys.includes("shard_index") && entry.keys.includes("shard_count")),
        `${workflow} multi-shard general-workspaces-b entries must declare shard_index and shard_count`);
    }
  }
});

test("workspaces-a shards map to Vitest native --shard slices over a stable project list", () => {
  const shards = [0, 1].map((index) =>
    dryRunJson([
      "--mode", "general", "--group", "general-workspaces-a",
      "--shard-index", String(index), "--shard-count", "2",
    ]),
  );

  assert.deepEqual(
    shards.map((shard) => shard.workspacesVitestShard),
    ["1/2", "2/2"],
    "each matrix job must pass its own --shard slice to vitest",
  );
  // Vitest's --shard partitions each project's file list deterministically, so
  // an identical project list across jobs is what guarantees complete,
  // non-overlapping coverage of the lane.
  assert.deepEqual(shards[0].workspaceProjects, shards[1].workspaceProjects);
  assert.ok(shards[0].workspaceProjects.length > 0, "workspaces-a must run at least one project");

  const unsharded = dryRunJson(["--mode", "general", "--group", "general-workspaces-a"]);
  assert.deepEqual(
    unsharded.workspaceProjects,
    shards[0].workspaceProjects,
    "sharding must not change which projects the lane covers",
  );
  assert.equal(unsharded.workspacesVitestShard, null);
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

test("the split chat integration suites keep measured durations for duration-aware sharding", () => {
  const chat = dryRunJson(["--mode", "general", "--group", "general-chat"]);
  assert.ok(chat.selectedChatSuites.length > 1, "expected multiple split chat integration suites");
  const generalDurations = loadShardDurations(durationsManifest);
  const chatDurations = loadShardDurations(path.join(repoRoot, "scripts", "chat-shard-durations.json"));
  for (const suite of chat.selectedChatSuites) {
    assert.ok(
      Number.isFinite(chatDurations[suite]),
      `missing chat-shard-durations entry for ${suite}`,
    );
    assert.ok(
      Number.isFinite(generalDurations[suite]),
      `missing general-server-shard-durations entry for ${suite}`,
    );
  }
});

test("the checked-in serialized manifest loads and covers most of the current suite set", () => {
  const durations = loadShardDurations(serializedDurationsManifest);
  assert.ok(Object.keys(durations).length > 0, "manifest must parse to a non-empty duration map");

  const shard = dryRunJson(["--mode", "serialized", "--shard-index", "0", "--shard-count", "1"]);
  const currentFiles = shard.selectedSerializedSuites;
  const known = currentFiles.filter((file) => durations[file] !== undefined).length;
  assert.ok(
    known / currentFiles.length >= 0.5,
    `manifest is stale: only ${known} of ${currentFiles.length} suites have recorded durations — regenerate it from a recent PR run (see the manifest's $comment)`,
  );
});

test("the real serialized shard partition is complete, non-overlapping and duration-balanced", () => {
  const durations = loadShardDurations(serializedDurationsManifest);
  const fallback = defaultSuiteWeight(durations);
  const shards = Array.from({ length: SERIALIZED_SHARD_COUNT }, (_, index) =>
    dryRunJson(["--mode", "serialized", "--shard-index", String(index), "--shard-count", String(SERIALIZED_SHARD_COUNT)]),
  );

  const total = shards[0].serializedSuiteCount;
  const selected = shards.flatMap((shard) => shard.selectedSerializedSuites);
  assert.equal(selected.length, total, "every serialized suite must be selected exactly once");
  assert.equal(new Set(selected).size, total, "serialized shards must not overlap");

  const totals = shards.map((shard) =>
    shard.selectedSerializedSuites.reduce((sum, file) => sum + (durations[file] ?? fallback), 0),
  );
  const maxTotal = Math.max(...totals);
  const minTotal = Math.min(...totals);
  // LPT keeps the spread within the heaviest single suite; use that as the bound.
  const heaviest = Math.max(...Object.values(durations));
  assert.ok(
    maxTotal - minTotal <= heaviest,
    `serialized shard weight spread ${maxTotal - minTotal}ms exceeds heaviest suite ${heaviest}ms: ${totals.join(", ")}`,
  );
});

const allChatSuites = dryRunJson(["--mode", "general", "--group", "general-chat"]).selectedChatSuites;
const chatSuiteSet = new Set(allChatSuites);
const nativeRunnerSuitePath =
  "server/src/services/native-runtime/native-codex-runner.integration.test.ts";
const ingressRetrySuitePath = "server/src/services/native-runtime/native-ingress-bootstrap-retry.integration.test.ts";
const usageDeliverySuitePath = "server/src/services/native-runtime/native-usage-delivery.integration.test.ts";
const warmCheckpointOwnershipSuitePath = "server/src/services/native-runtime/native-warm-checkpoint-ownership.integration.test.ts";
const warmSuccessorRunnerReleaseSuitePath = "server/src/services/native-runtime/native-warm-successor-runner-release.integration.test.ts";
const pluginWarmOwnerSuitePath = "server/src/services/native-runtime/plugin-runner-task-warm.integration.test.ts";
const pluginReleaseResumeSuitePaths = [
  "server/src/services/native-runtime/plugin-runner-release-resume-cached.integration.test.ts",
  "server/src/services/native-runtime/plugin-runner-release-resume-adopted.integration.test.ts",
];
const pluginEvictionSuitePaths = [
  "server/src/services/native-runtime/plugin-runner-eviction-codex-retired.integration.test.ts",
  "server/src/services/native-runtime/plugin-runner-eviction-codex-abrupt.integration.test.ts",
  "server/src/services/native-runtime/plugin-runner-eviction-claude-retired.integration.test.ts",
  "server/src/services/native-runtime/plugin-runner-eviction-claude-abrupt.integration.test.ts",
];
const dotRunnerSuitePath = "server/src/__tests__/dot-runner.test.ts";
const restartRecoverySuitePath =
  "server/src/services/native-runtime/native-runner-restart-recovery.integration.test.ts";
const cutTurnStartRetrySuitePath = "server/src/services/native-runtime/native-cut-turn-start-retry.integration.test.ts";
const restartWaitSuites = ["lease-renewal", "preparation", "checkpoint-cost", "diskless-direct", "diskless-prepared-task"]
  .map(name => `server/src/services/native-runtime/native-runner-restart-${name}.integration.test.ts`);

// Mirrors pr-trusted.yml (12 shards, called by pr.yml so GITHUB_WORKFLOW is
// "PR"): the chat suite runs in its dedicated lanes and the cargo-dependent
// native-runner suite in the Rust-cached final Verify Paperclip Runner vitest
// shard, so together the three cover the full server group exactly.
test("12 PR without-chat shards plus the dedicated chat and native-runner lanes cover the original server group exactly", () => {
  const durations = loadShardDurations(durationsManifest);
  const fallback = defaultSuiteWeight(durations);
  const prEnv = { GITHUB_WORKFLOW: "PR" };
  const full = dryRunJson(["--mode", "general", "--group", "general-server", "--shard-index", "0", "--shard-count", "1"], prEnv);
  const shards = Array.from({ length: 12 }, (_, index) => dryRunJson([
    "--mode", "general", "--group", "general-server-without-chat",
    "--shard-index", String(index), "--shard-count", "12",
  ], prEnv));
  const totals = shards.map((shard) =>
    shard.selectedGeneralServerSuites.reduce((sum, file) => sum + (durations[file] ?? fallback), 0),
  );
  const maxTotal = Math.max(...totals);
  const minTotal = Math.min(...totals);
  // LPT keeps the spread within the heaviest single suite; use that as the
  // bound. The chat and native-runner suites run in their own lanes, so
  // exclude them here.
  const nativeRunner =
    "server/src/services/native-runtime/native-codex-runner.integration.test.ts";
  const heaviest = Math.max(
    ...Object.entries(durations)
      .filter(([file]) => !chatSuiteSet.has(file) && file !== nativeRunner)
      .map(([, ms]) => ms),
  );
  assert.ok(
    maxTotal - minTotal <= heaviest,
    `shard weight spread ${maxTotal - minTotal}ms exceeds heaviest suite ${heaviest}ms: ${totals.join(", ")}`,
  );

  const files = shards.flatMap((shard) => shard.selectedGeneralServerSuites);
  for (const chatFile of allChatSuites) {
    assert.ok(!files.includes(chatFile), `chat suite must stay in general-chat: ${chatFile}`);
  }
  assert.ok(!files.includes(nativeRunnerSuitePath));
  assert.ok(!files.includes(ingressRetrySuitePath));
  assert.ok(!files.includes("server/src/services/native-runtime/native-ingress-bootstrap-retry-opencode.integration.test.ts"));
  assert.ok(!files.includes(dotRunnerSuitePath));
  assert.ok(!files.includes(restartRecoverySuitePath));
  assert.ok(!files.includes(cutTurnStartRetrySuitePath));
  assert.ok(!files.includes(usageDeliverySuitePath));
  assert.ok(!files.includes(warmCheckpointOwnershipSuitePath));
  assert.ok(!files.includes(warmSuccessorRunnerReleaseSuitePath));
  assert.ok(!files.includes(pluginWarmOwnerSuitePath));
  for (const suitePath of [...pluginReleaseResumeSuitePaths, ...pluginEvictionSuitePaths]) {
    assert.ok(!files.includes(suitePath));
  }
  const excludedNightly = shards[0].excludedNightlySuites ?? [];
  for (const shard of shards) {
    assert.deepEqual(shard.excludedNightlySuites ?? [], excludedNightly, "nightly exclusions must agree across shards");
  }
  assert.deepEqual([...files, ...excludedNightly, ...allChatSuites, nativeRunnerSuitePath, ingressRetrySuitePath, "server/src/services/native-runtime/native-ingress-bootstrap-retry-opencode.integration.test.ts", dotRunnerSuitePath, restartRecoverySuitePath, ...restartWaitSuites, cutTurnStartRetrySuitePath, usageDeliverySuitePath, warmCheckpointOwnershipSuitePath, warmSuccessorRunnerReleaseSuitePath, pluginWarmOwnerSuitePath, ...pluginReleaseResumeSuitePaths, ...pluginEvictionSuitePaths, "server/src/services/native-runtime/plugin-runner-probe.test.ts"].sort(), full.selectedGeneralServerSuites.sort());
  assert.equal(new Set(files).size, files.length);
  const defaultRun = dryRunJson([], prEnv);
  assert.ok(defaultRun.generalServerSuiteCount === full.generalServerSuiteCount);
});

// The legacy group and local default must remain complete when a caller has
// not selected a separate native lane.
for (const [caller, envOverrides] of [["Release", { GITHUB_WORKFLOW: "Release" }], ["no ambient workflow", {}]]) {
  test(`10 without-chat shards under ${caller} keep the native-runner suite and cover the server group with chat alone`, () => {
    const full = dryRunJson(["--mode", "general", "--group", "general-server", "--shard-index", "0", "--shard-count", "1"], envOverrides);
    const shards = Array.from({ length: 10 }, (_, index) => dryRunJson([
      "--mode", "general", "--group", "general-server-without-chat",
      "--shard-index", String(index), "--shard-count", "10",
    ], envOverrides));
    const files = shards.flatMap((shard) => shard.selectedGeneralServerSuites);
    for (const chatFile of allChatSuites) {
      assert.ok(!files.includes(chatFile));
    }
    assert.ok(files.includes(nativeRunnerSuitePath));
    assert.ok(files.includes(dotRunnerSuitePath));
    assert.ok(files.includes(restartRecoverySuitePath));
    assert.ok(files.includes(warmCheckpointOwnershipSuitePath));
    assert.ok(files.includes(warmSuccessorRunnerReleaseSuitePath));
    assert.ok(files.includes(pluginWarmOwnerSuitePath));
    for (const suitePath of [...pluginReleaseResumeSuitePaths, ...pluginEvictionSuitePaths]) {
      assert.ok(files.includes(suitePath));
    }
    assert.deepEqual([...files, ...allChatSuites].sort(), full.selectedGeneralServerSuites.sort());
    assert.equal(new Set(files).size, files.length);
  });
}

// Release verification selects its dedicated lane explicitly. Do not infer it
// from the caller name: previews and future workflow callers need the same cover.
for (const caller of ["Release", "Cloud readiness", "another caller"]) {
  test(`release server, chat, and native lanes cover every server suite once under ${caller}`, () => {
    const env = { GITHUB_WORKFLOW: caller };
    const full = dryRunJson(["--mode", "general", "--group", "general-server", "--shard-index", "0", "--shard-count", "1"], env);
    const files = Array.from({ length: 10 }, (_, index) => dryRunJson([
      "--mode", "general", "--group", "general-server-without-chat-or-native-runner",
      "--shard-index", String(index), "--shard-count", "10",
    ], env)).flatMap((shard) => shard.selectedGeneralServerSuites);
    const native = dryRunJson(["--mode", "general", "--group", "general-server-native-runner"], env);
    const combined = [...files, ...allChatSuites, ...native.selectedGeneralServerSuites];
    assert.equal(new Set(combined).size, combined.length, "lanes must not overlap");
    assert.deepEqual(combined.sort(), full.selectedGeneralServerSuites.sort());
  });
}

test("the native-runner lane runs exactly the cargo-dependent suites", () => {
  const lane = dryRunJson(["--mode", "general", "--group", "general-server-native-runner"]);
  assert.deepEqual(lane.selectedGeneralServerSuites, [
    "server/src/services/native-runtime/plugin-runner-probe.test.ts",
    "server/src/services/native-runtime/native-codex-runner.integration.test.ts",
    ingressRetrySuitePath,
    "server/src/services/native-runtime/native-ingress-bootstrap-retry-opencode.integration.test.ts",
    dotRunnerSuitePath,
    restartRecoverySuitePath,
    ...restartWaitSuites,
    cutTurnStartRetrySuitePath,
    usageDeliverySuitePath,
    warmCheckpointOwnershipSuitePath,
    warmSuccessorRunnerReleaseSuitePath,
    pluginWarmOwnerSuitePath,
    ...pluginReleaseResumeSuitePaths,
    ...pluginEvictionSuitePaths,
  ]);
});

test("the native-runner group shards cleanly into a complete non-overlapping partition", () => {
  const full = dryRunJson(["--mode", "general", "--group", "general-server-native-runner"]);
  const shard0 = dryRunJson(["--mode", "general", "--group", "general-server-native-runner", "--shard-index", "0", "--shard-count", "2"]);
  const shard1 = dryRunJson(["--mode", "general", "--group", "general-server-native-runner", "--shard-index", "1", "--shard-count", "2"]);
  assert.ok(shard0.selectedGeneralServerSuites.length > 0 && shard1.selectedGeneralServerSuites.length > 0);
  const combined = [...shard0.selectedGeneralServerSuites, ...shard1.selectedGeneralServerSuites];
  assert.equal(new Set(combined).size, combined.length, "native-runner shards must not overlap");
  assert.deepEqual([...combined].sort(), [...full.selectedGeneralServerSuites].sort(), "native-runner shards must cover all suites");
});

// The PR-side exclusion above is safe only while the wiring it assumes holds:
// pr.yml (the caller whose name reusable pr-trusted.yml jobs see as
// GITHUB_WORKFLOW) is named PR, the package vitest lanes cover every
// partition exactly once, the native-server vitest lanes cover every native
// partition exactly once with release_crate: true, and those lanes' package
// script routes through the wrapper.
test("the PR workflow wiring for the native-runner lane holds", () => {
  const prWorkflow = readFileSync(path.join(repoRoot, ".github/workflows/pr.yml"), "utf8");
  assert.match(prWorkflow, /^name: PR$/m,
    "renaming pr.yml silently moves the native-runner suite back into the uncached server shards");

  const matrix = JSON.parse(readFileSync(path.join(repoRoot, ".github/ci-task-matrix.json"), "utf8"));
  const vitestLanes = matrix.verify_paperclip_runner.filter((entry) => entry.command.startsWith("test:typescript:vitest"));
  for (const entry of vitestLanes) {
    assert.match(entry.command, /^test:typescript:vitest (--package-lane=\d+\/\d+|--native-server(?:=\d+\/\d+)?)$/, entry.lane_label);
    const isNative = /--native-server(?:=\d+\/\d+)?$/.test(entry.command);
    assert.equal(
      entry.task,
      isNative ? "ci:runner-vitest" : "ci:runner-package",
      entry.lane_label,
    );
  }
  const lanes = vitestLanes
    .map((entry) => /--package-lane=(\d+)\/(\d+)$/.exec(entry.command))
    .filter(Boolean).map((match) => [Number(match[1]), Number(match[2])]);
  assert.ok(lanes.length > 0, "expected package-lane test:typescript:vitest lanes in the task matrix");
  assert.equal(new Set(lanes.map(([, count]) => count)).size, 1, "package lanes must agree on the lane count");
  const laneCount = lanes[0][1];
  assert.deepEqual(
    lanes.map(([index]) => index).sort((left, right) => left - right),
    Array.from({ length: laneCount }, (_, index) => index + 1),
    "package lanes must cover every partition exactly once",
  );
  const native = vitestLanes.filter((entry) => /--native-server(?:=\d+\/\d+)?$/.test(entry.command));
  assert.ok(native.length >= 1, "at least one vitest lane carries the native-runner group");
  for (const entry of native) {
    assert.equal(entry.release_crate, true, `${entry.lane_label} needs the release crate`);
  }
  if (native.length === 1) {
    assert.match(native[0].command, /--native-server(?:=1\/1)?$/);
  } else {
    const nativeShards = native
      .map((entry) => /--native-server=(\d+)\/(\d+)$/.exec(entry.command))
      .filter(Boolean).map((match) => [Number(match[1]), Number(match[2])]);
    assert.equal(nativeShards.length, native.length, "multi-lane native-server entries must use --native-server=K/N");
    assert.equal(new Set(nativeShards.map(([, count]) => count)).size, 1, "native-server lanes must agree on the shard count");
    assert.deepEqual(
      nativeShards.map(([index]) => index).sort((left, right) => left - right),
      Array.from({ length: native.length }, (_, index) => index + 1),
      "native-server lanes must cover every partition exactly once",
    );
  }

  const runnerPackage = JSON.parse(
    readFileSync(path.join(repoRoot, "packages/paperclip-runner/package.json"), "utf8"),
  );
  assert.equal(runnerPackage.scripts["test:typescript:vitest"], "node ./scripts/run-pr-vitest-lane.mjs");
});

const laneWrapper = path.join(repoRoot, "packages/paperclip-runner/scripts/run-pr-vitest-lane.mjs");

function wrapperPlan(args, envOverrides = {}) {
  const result = spawnSync(process.execPath, [laneWrapper, ...args, "--dry-run"], {
    cwd: repoRoot,
    encoding: "utf8",
    env: workflowEnv(envOverrides),
  });
  assert.equal(result.status, 0, `expected wrapper dry run to succeed for ${args.join(" ")}: ${result.stderr}`);
  return JSON.parse(result.stdout);
}

test("the PR lanes separate complete package and native workloads without changing local shards", () => {
  for (const [args, envOverrides, packageArgs, native] of [
    [["--shard=1/2"], { GITHUB_WORKFLOW: "PR" }, [], false],
    [["--shard=2/2"], { GITHUB_WORKFLOW: "PR" }, null, true],
    [[], { GITHUB_WORKFLOW: "PR" }, [], true],
    [["--shard=2/3"], { GITHUB_WORKFLOW: "PR" }, ["--shard=2/3"], false],
    [["--shard=3/3"], { GITHUB_WORKFLOW: "PR" }, ["--shard=3/3"], true],
    [["--shard=2/2"], { GITHUB_WORKFLOW: "Release" }, ["--shard=2/2"], false],
    [["--shard=2/2"], {}, ["--shard=2/2"], false],
    [[], {}, [], false],
  ]) {
    const plan = wrapperPlan(args, envOverrides);
    assert.equal(plan.runNativeRunnerGroup, native);
    assert.equal(plan.runPackageTests, packageArgs !== null);
    const vitest = plan.plannedCommands.find(command => command.args[0] === "exec");
    assert.deepEqual(vitest?.args ?? null, packageArgs === null ? null : ["exec", "vitest", "run", ...packageArgs]);
    assert.equal(plan.plannedCommands.some(command => command.args.includes("general-server-native-runner")), native);
    assert.ok(plan.plannedCommands.some(command => command.args.includes("build:rust")), "both workloads require debug fixtures");
  }

  const malformed = spawnSync(process.execPath, [laneWrapper, "--shard=nonsense", "--dry-run"], {
    cwd: repoRoot,
    encoding: "utf8",
    env: workflowEnv({ GITHUB_WORKFLOW: "PR" }),
  });
  assert.notEqual(malformed.status, 0, "a malformed shard flag must fail rather than guess a lane");
});

const runnerRoot = path.join(repoRoot, "packages/paperclip-runner");
const prepCommands = [
  { command: "pnpm", args: ["run", "ensure:eval-build-deps"], cwd: runnerRoot },
  { command: "pnpm", args: ["run", "build:rust"], cwd: runnerRoot },
];
const nativeCommand = {
  command: "pnpm",
  args: ["test:run:general", "--", "--group", "general-server-native-runner"],
  cwd: repoRoot,
};

// Master's trusted workflow keeps sending the --shard commands until the
// package-lane matrix merges, so their exact plans must not move.
test("the master-pinned --shard lane commands plan exactly what they did before package lanes", () => {
  assert.deepEqual(wrapperPlan(["--shard=1/2"], { GITHUB_WORKFLOW: "PR" }).plannedCommands, [
    ...prepCommands,
    { command: "pnpm", args: ["exec", "vitest", "run"], cwd: runnerRoot },
  ]);
  assert.deepEqual(wrapperPlan(["--shard=2/2"], { GITHUB_WORKFLOW: "PR" }).plannedCommands, [...prepCommands, nativeCommand]);
  for (const plan of [wrapperPlan(["--shard=1/2"], { GITHUB_WORKFLOW: "PR" }), wrapperPlan(["--shard=2/2"], { GITHUB_WORKFLOW: "PR" })]) {
    assert.equal(plan.packageLane, undefined);
  }
});

test("--native-server runs only the native group under any workflow and supports K/N sharding", () => {
  for (const envOverrides of [{ GITHUB_WORKFLOW: "PR" }, {}]) {
    const plan = wrapperPlan(["--native-server"], envOverrides);
    assert.deepEqual(plan.plannedCommands, [...prepCommands, nativeCommand]);
    assert.equal(plan.runPackageTests, false);
    assert.equal(plan.runNativeRunnerGroup, true);
  }
  const single = wrapperPlan(["--native-server=1/1"], { GITHUB_WORKFLOW: "PR" });
  assert.deepEqual(single.plannedCommands, [...prepCommands, nativeCommand]);
  assert.deepEqual(single.nativeServerLane, { index: 1, count: 1 });
  const first = wrapperPlan(["--native-server=1/2"], { GITHUB_WORKFLOW: "PR" });
  assert.deepEqual(first.plannedCommands, [
    ...prepCommands,
    { command: "pnpm", args: ["test:run:general", "--", "--group", "general-server-native-runner", "--shard-index", "0", "--shard-count", "2"], cwd: repoRoot },
  ]);
  const second = wrapperPlan(["--native-server=2/2"], { GITHUB_WORKFLOW: "PR" });
  assert.deepEqual(second.plannedCommands, [
    ...prepCommands,
    { command: "pnpm", args: ["test:run:general", "--", "--group", "general-server-native-runner", "--shard-index", "1", "--shard-count", "2"], cwd: repoRoot },
  ]);
});

test("the package lane manifest uses the general server duration schema", () => {
  const manifest = JSON.parse(readFileSync(path.join(runnerRoot, "scripts/vitest-lane-durations.json"), "utf8"));
  const general = JSON.parse(readFileSync(durationsManifest, "utf8"));
  // The refresh script writes exactly these keys; hand-added annotations such
  // as the server manifest's splitEstimates are optional.
  assert.deepEqual(Object.keys(manifest), ["$comment", "unit", "sources", "coverage", "durations"]);
  assert.ok(Object.keys(manifest).every((key) => key in general));
  assert.equal(manifest.unit, "ms");
  assert.deepEqual(Object.keys(manifest.coverage), Object.keys(general.coverage));
  // The weekly refresh samples merged-PR runs for this lane, so its sources
  // may lead with a pull number. test-selection-pr-timings.test.mjs passes the
  // collector's real output through the same check.
  for (const source of manifest.sources) assertManifestSource(source);
  const entries = Object.entries(manifest.durations);
  assert.ok(entries.length > 100);
  for (const [file, ms] of entries) {
    assert.match(file, /^packages\/paperclip-runner\/.+\.test\.[cm]?[jt]sx?$/);
    assert.ok(Number.isFinite(ms) && ms >= 0, file);
  }
});

test("package lane arguments fail rather than guess a lane", () => {
  for (const args of [["--package-lane=0/3"], ["--package-lane=4/3"], ["--package-lane=abc"], ["--package-lane", "1/3"],
    ["--package-lane=1/3", "--package-lane=2/3"], ["--package-lane=1/3", "--shard=1/2"], ["--native-server", "--shard=2/2"],
    ["--native-server", "--package-lane=1/3"], ["--native-server", "src/foo.test.ts"],
    ["--native-server=0/2"], ["--native-server=3/2"], ["--native-server=abc"], ["--native-server=1/2", "--native-server=2/2"]]) {
    const result = spawnSync(process.execPath, [laneWrapper, ...args, "--dry-run"], {
      cwd: repoRoot, encoding: "utf8", env: workflowEnv({ GITHUB_WORKFLOW: "PR" }),
    });
    assert.notEqual(result.status, 0, args.join(" "));
  }
});

const lineShardFile = path.join(repoRoot, "server/src/__tests__/chat-channels.integration.test.ts");
const caseAt = (line, name) => ({ name, file: lineShardFile, projectName: "@paperclipai/server", location: { line, column: 3 } });

test("test-line shards cover nested and parameterized cases exactly once without splitting a source line", () => {
  const cases = [caseAt(10, "suite > nested > first"), caseAt(10, "suite > nested > second"),
    caseAt(20, "same name"), caseAt(30, "same name"), caseAt(40, "last"), caseAt(50, "new case")];
  const shards = partitionTestLines(cases, 3, lineShardFile);
  assert.deepEqual(shards.map((shard) => shard.tests.length), [2, 2, 2]);
  assert.equal(shards.filter((shard) => shard.lines.includes(10)).length, 1);
  assert.equal(shards.find((shard) => shard.lines.includes(10)).tests.length, 2);
  assert.equal(shards.flatMap((shard) => shard.lines).length, 5);
  assert.deepEqual(shards.flatMap((shard) => shard.tests).sort((a, b) => a.location.line - b.location.line), cases);
  assert.deepEqual(partitionTestLines([...cases].reverse(), 3, lineShardFile).map((shard) => shard.lines), shards.map((shard) => shard.lines));
});

test("recorded durations balance chat line shards by time without splitting a source line", () => {
  const cases = [caseAt(10, "slow"), caseAt(20, "each %s"), caseAt(20, "each %s"), caseAt(30, "a"), caseAt(40, "b"),
    caseAt(50, "c"), caseAt(60, "unrecorded")];
  const durations = { slow: 9000, "each %s": 1000, a: 3000, b: 3000, c: 2000 };
  const shards = partitionTestLines(cases, 2, lineShardFile, durations);
  assert.deepEqual(shards.map((shard) => shard.weight), [11000, 11000]);
  assert.deepEqual(shards.map((shard) => shard.lines), [[10, 20], [30, 40, 50, 60]]);
  assert.deepEqual(shards.flatMap((shard) => shard.tests).sort((a, b) => a.location.line - b.location.line), cases);
  assert.deepEqual(partitionTestLines([...cases].reverse(), 2, lineShardFile, durations).map((shard) => shard.lines),
    shards.map((shard) => shard.lines));
  assert.deepEqual(partitionTestLines(cases, 2, lineShardFile).map((shard) => shard.tests.length), [4, 3]);
});

test("chat durations compute per-file medians across profile runs", () => {
  const inventory = [
    "server/src/__tests__/chat-channels/a.integration.test.ts",
    "server/src/__tests__/chat-channels/b.integration.test.ts",
  ];
  const data = chatManifestData(
    inventory,
    [
      new Map([[inventory[0], 4000]]),
      new Map([[inventory[0], 9000], ["server/src/__tests__/unrelated.test.ts", 100]]),
      new Map([[inventory[0], 6000]]),
    ],
    ["run-1"],
  );
  assert.deepEqual(data.durations, { [inventory[0]]: 6000 });
  assert.deepEqual(data.coverage, { measured: 1, inventory: 2 });
});

test("the checked-in chat duration manifest is well formed and covers all chat suites", () => {
  const manifest = JSON.parse(readFileSync(path.join(repoRoot, "scripts", "chat-shard-durations.json"), "utf8"));
  assert.equal(manifest.unit, "ms");
  const entries = Object.entries(manifest.durations);
  assert.ok(entries.length > 0);
  assert.ok(entries.every(([name, ms]) => name.length > 0 && Number.isSafeInteger(ms) && ms > 0));
  assert.deepEqual(loadShardDurations(path.join(repoRoot, "scripts", "chat-shard-durations.json")), manifest.durations);
  for (const suite of allChatSuites) {
    assert.ok(manifest.durations[suite] > 0, `chat manifest missing ${suite}`);
  }
});

test("line-shard collection rejects empty, foreign, or unlocated tests and invalid shard counts", () => {
  const good = caseAt(10, "valid");
  for (const input of [[], null, [{ ...good, file: "/another.test.ts" }], [{ ...good, projectName: "wrong" }],
    [{ ...good, location: undefined }], [{ ...good, location: { line: 0 } }], [{ ...good, name: "" }]]) {
    assert.throws(() => partitionTestLines(input, 1, lineShardFile));
  }
  for (const count of [0, -1, 1.5, Infinity, 2]) assert.throws(() => partitionTestLines([good], count, lineShardFile));
});

test("filtered collection must match the exact assigned case identities, including duplicates", () => {
  const expected = [caseAt(10, "same"), caseAt(10, "same"), caseAt(20, "nested > case")];
  assertSelectedTests(expected, [...expected].reverse(), lineShardFile);
  for (const actual of [expected.slice(1), [...expected, caseAt(30, "extra")],
    [expected[0], expected[1], caseAt(20, "renamed")],
    [expected[0], expected[1], caseAt(21, "nested > case")]]) {
    assert.throws(() => assertSelectedTests(expected, actual, lineShardFile));
  }
});

test("chat file shards form a complete, non-overlapping, duration-balanced partition", () => {
  const durations = loadShardDurations(path.join(repoRoot, "scripts", "chat-shard-durations.json"));
  const heaviest = Math.max(...Object.values(durations));
  for (const count of [2, 3, 5]) {
    const shards = Array.from({ length: count }, (_, index) =>
      dryRunJson(["--mode", "general", "--group", "general-chat", "--shard-index", String(index), "--shard-count", String(count)],
        { PAPERCLIP_TEST_DATABASE_URL: "" }),
    );
    const assigned = shards.flatMap((shard) => shard.selectedChatSuites);
    assert.equal(new Set(assigned).size, assigned.length, `chat shards (${count}) must not overlap`);
    assert.deepEqual([...assigned].sort(), [...allChatSuites].sort(), `chat shards (${count}) must cover all chat suites`);
    const totals = shards.map((shard) => shard.selectedChatSuites.reduce((sum, file) => sum + (durations[file] ?? 0), 0));
    assert.ok(Math.max(...totals) - Math.min(...totals) <= heaviest, `chat shard spread exceeded heaviest suite for count=${count}`);
  }
  assert.deepEqual(
    dryRunJson(["--mode", "general", "--group", "general-chat"], { PAPERCLIP_TEST_DATABASE_URL: "" }).selectedChatSuites,
    allChatSuites,
  );
  const trailing = dryRunJson(
    ["--mode", "general", "--group", "general-chat", "--shard-index", String(allChatSuites.length), "--shard-count", String(allChatSuites.length + 2)],
    { PAPERCLIP_TEST_DATABASE_URL: "" },
  );
  assert.deepEqual(trailing.selectedChatSuites, []);
});

test("default ungrouped runs isolate chat suites in parallel before general-server without dropping native suites", () => {
  for (const args of [[], ["--mode", "general"]]) {
    for (const workflow of ["PR", "Release", ""]) {
      const env = { GITHUB_WORKFLOW: workflow, PAPERCLIP_TEST_DATABASE_URL: "" };
      const plan = dryRunJson(args, env);
      const full = dryRunJson(["--mode", "general", "--group", "general-server",
        "--shard-index", "0", "--shard-count", "1"], env);
      assert.deepEqual(plan.selectedChatSuites, allChatSuites);
      for (const chatFile of allChatSuites) {
        assert.ok(!plan.selectedGeneralServerSuites.includes(chatFile));
      }
      assert.deepEqual([...plan.selectedGeneralServerSuites, ...allChatSuites].sort(), full.selectedGeneralServerSuites.sort());
    }
  }
});

test("default chat isolation leaves explicit groups and shared databases unchanged", () => {
  for (const args of [[], ["--mode", "general"]]) {
    const shared = dryRunJson(args, { PAPERCLIP_TEST_DATABASE_URL: "postgresql://shared/test", GITHUB_WORKFLOW: "PR" });
    assert.equal(shared.selectedChatSuites, null);
    assert.equal(shared.selectedGeneralServerSuites, null);
  }
  const full = dryRunJson(["--mode", "general", "--group", "general-server",
    "--shard-index", "0", "--shard-count", "1"], { PAPERCLIP_TEST_DATABASE_URL: "", GITHUB_WORKFLOW: "PR" });
  assert.equal(full.selectedChatSuites, null);
  for (const chatFile of allChatSuites) {
    assert.ok(full.selectedGeneralServerSuites.includes(chatFile));
  }
  assert.ok(full.selectedGeneralServerSuites.includes(nativeRunnerSuitePath));
  assert.equal(dryRunJson(["--mode", "serialized"], { PAPERCLIP_TEST_DATABASE_URL: "" }).selectedChatSuites, null);
});

for (const [label, modeArgs, lane] of [
  ["general-server-native-runner", ["--mode", "general", "--group", "general-server-native-runner"], "general"],
  ["general-server-without-chat-or-native-runner", ["--mode", "general", "--group", "general-server-without-chat-or-native-runner", "--shard-index", "0", "--shard-count", "12"], "general"],
  ["general-chat", ["--mode", "general", "--group", "general-chat", "--shard-index", "0", "--shard-count", "2"], "general"],
  ["serialized", ["--mode", "serialized", "--shard-index", "4", "--shard-count", "9"], "serialized"],
]) test(`${label} files overlap only when their database fixtures are isolated`, { skip: process.platform === "win32" }, () => {
  const parallelWorkers = defaultServerParallelWorkers(lane);
  const directory = mkdtempSync(path.join(os.tmpdir(), "native-file-workers-"));
  const receipt = path.join(directory, "args.json");
  const fakePnpm = path.join(directory, "pnpm");
  writeFileSync(fakePnpm, `#!/usr/bin/env node\nrequire('node:fs').writeFileSync(${JSON.stringify(receipt)}, JSON.stringify(process.argv.slice(2)));\n`);
  chmodSync(fakePnpm, 0o755);
  try {
    for (const [databaseEnv, workers] of [
      [{}, parallelWorkers],
      [{ PAPERCLIP_TEST_DATABASE_URL: "postgresql://shared/test" }, 1],
      [{ PAPERCLIP_ISSUE_RECOVERY_TEST_DATABASE_URL: "postgresql://shared/recovery_test" }, 1],
      [{ PAPERCLIP_TEST_POSTGRES_ADMIN_URL: "postgresql://owned/postgres" }, parallelWorkers],
      [{ PAPERCLIP_VITEST_MAX_WORKERS: "2" }, 2],
    ]) {
      const env = workflowEnv({
        PATH: `${directory}${path.delimiter}${process.env.PATH}`,
        PAPERCLIP_CI_PROFILE: "false",
        PAPERCLIP_TEST_POSTGRES_SHARED: "0",
      });
      for (const key of Object.keys(env)) if (key.endsWith("_TEST_DATABASE_URL")) delete env[key];
      Object.assign(env, databaseEnv);
      const result = spawnSync(process.execPath, [script, ...modeArgs], {
        cwd: repoRoot, encoding: "utf8", env,
      });
      assert.equal(result.status, 0, result.stdout + result.stderr);
      const args = JSON.parse(readFileSync(receipt, "utf8"));
      assert.ok(args.includes(`--maxWorkers=${workers}`), `expected --maxWorkers=${workers} in ${args.join(" ")}`);
      assert.ok(args.includes(workers > 1 ? "--fileParallelism" : "--no-file-parallelism"));
      if (workers > 1) assert.ok(args.includes("--pool=forks") && args.includes("--isolate"));
      if (label === "general-server-native-runner") {
        for (const file of [restartRecoverySuitePath, ...restartWaitSuites]) assert.ok(args.includes(file));
      }
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
