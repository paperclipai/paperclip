// PR Runner Vitest lanes. `--package-lane=K/N` runs the Kth of N
// duration-balanced partitions of the package inventory, and `--native-server`
// runs the native server integration group. Every lane prepares debug
// fixtures; only the native group also needs release units (see the matrix).
//
// The --shard commands stay compatible with master-pinned workflows: under
// the PR workflow with two shards, the first runs every package test and the
// second runs the native server group. Local/other callers retain ordinary
// package sharding. Other PR shard counts keep package shards plus native
// tests on the final lane, preserving coverage.
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { invocationEnv } from "../../../scripts/ci-profile/record.mjs";
import { filesMatchedByFilters, listPackageVitestFiles, planPackageLanes } from "./vitest-package-lanes.mjs";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const workspaceRoot = resolve(packageRoot, "../..");
const args = process.argv.slice(2).filter((value) => value !== "--dry-run");
const dryRun = process.argv.includes("--dry-run");

function fail(message) {
  console.error(`[pr-vitest-lane] ${message}`);
  process.exit(1);
}

const shardArg = args.find((value) => value.startsWith("--shard="));
const shardMatch = shardArg ? /^--shard=(\d+)\/(\d+)$/.exec(shardArg) : null;
if (args.filter(value => value.startsWith("--shard=")).length > 1 || (shardArg && !shardMatch)) {
  fail(`unrecognized shard argument: ${shardArg}`);
}
if (shardMatch && (Number(shardMatch[1]) < 1 || Number(shardMatch[1]) > Number(shardMatch[2]))) {
  throw new Error(`Invalid shard: ${shardArg}`);
}

const laneArgs = args.filter((value) => value.startsWith("--package-lane"));
const laneMatch = laneArgs.length === 1 ? /^--package-lane=(\d+)\/(\d+)$/.exec(laneArgs[0]) : null;
if (laneArgs.length > 1 || (laneArgs.length === 1 && !laneMatch)) {
  fail(`unrecognized package lane argument: ${laneArgs.join(" ")}`);
}
const laneIndex = laneMatch ? Number(laneMatch[1]) : null;
const laneCount = laneMatch ? Number(laneMatch[2]) : null;
if (laneMatch && (laneCount < 1 || laneIndex < 1 || laneIndex > laneCount)) {
  fail(`invalid package lane: ${laneArgs[0]}`);
}
const nativeServerOnly = args.includes("--native-server");
if ([shardArg, laneMatch, nativeServerOnly].filter(Boolean).length > 1) {
  fail("--shard, --package-lane and --native-server are mutually exclusive");
}
if (nativeServerOnly && args.length > 1) {
  fail(`--native-server takes no other arguments: ${args.join(" ")}`);
}

const isFinalShard = !shardArg || shardMatch[1] === shardMatch[2];
const isPrWorkflow = process.env.GITHUB_WORKFLOW === "PR";
// Reuse the two existing CI slots: all package files in the first, all native
// server files in the second. Keeping the old command arguments makes this
// safe while the trusted workflow still comes from master. Other shard counts
// and local callers retain ordinary Vitest sharding and the final-lane append.
const separateWorkloads = isPrWorkflow && shardMatch?.[2] === "2";

let runNativeRunnerGroup;
let runPackageTests;
let packageArgs;
let packageLane = null;
if (laneMatch) {
  const inventory = listPackageVitestFiles();
  const lanes = planPackageLanes(inventory, laneCount);
  const lane = lanes[laneIndex - 1];
  // A filter that also selects a file owned by another lane runs it twice; it
  // never drops coverage, so warn instead of failing the lane.
  const extra = filesMatchedByFilters(lane.files, inventory).filter((file) => !lane.files.includes(file));
  if (extra.length) {
    console.error(`[pr-vitest-lane] package lane ${laneIndex}/${laneCount} filters also select: ${extra.join(", ")}`);
  }
  packageLane = { index: laneIndex, count: laneCount, inventory: inventory.length, estimatedMs: lane.estimatedMs, files: lane.files };
  runNativeRunnerGroup = false;
  // An empty file list would make `vitest run` select the whole inventory.
  runPackageTests = lane.files.length > 0;
  packageArgs = [...args.filter((arg) => arg !== laneArgs[0]), ...lane.files];
} else if (nativeServerOnly) {
  runNativeRunnerGroup = true;
  runPackageTests = false;
  packageArgs = [];
} else {
  runNativeRunnerGroup = isPrWorkflow && isFinalShard;
  runPackageTests = !separateWorkloads || !isFinalShard;
  packageArgs = separateWorkloads ? args.filter((arg) => arg !== shardArg) : args;
}

const plannedCommands = [
  { command: "pnpm", args: ["run", "ensure:eval-build-deps"], cwd: packageRoot },
  { command: "pnpm", args: ["run", "build:rust"], cwd: packageRoot },
  ...(runPackageTests
    ? [{ command: "pnpm", args: ["exec", "vitest", "run", ...packageArgs], cwd: packageRoot }]
    : []),
  ...(runNativeRunnerGroup
    ? [{
        command: "pnpm",
        args: ["test:run:general", "--", "--group", "general-server-native-runner"],
        cwd: workspaceRoot,
      }]
    : []),
];

if (dryRun) {
  console.log(JSON.stringify({
    isPrWorkflow,
    isFinalShard,
    runNativeRunnerGroup,
    runPackageTests,
    ...(packageLane ? { packageLane } : {}),
    plannedCommands,
  }, null, 2));
  process.exit(0);
}

if (packageLane) {
  console.log(`[pr-vitest-lane] package lane ${packageLane.index}/${packageLane.count}: ${packageLane.files.length}/${packageLane.inventory} files, estimated ${Math.round(packageLane.estimatedMs / 1000)}s`);
}
for (const planned of plannedCommands) {
  const result = spawnSync(planned.command, planned.args, {
    cwd: planned.cwd,
    stdio: "inherit",
    env: planned.args[0] === "exec" && planned.args[1] === "vitest" ? invocationEnv("vitest") : process.env,
  });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}
