// The two PR Vitest slots cover separate workloads: the first runs every
// package test and the second runs the native server integration group.
// Both need debug fixtures; only the native group also builds release units.
// Keep the existing --shard commands compatible with master-pinned workflows.
// Local/other callers retain ordinary package sharding. Other PR shard counts
// keep package shards plus native tests on the final lane, preserving coverage.
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { invocationEnv } from "../../../scripts/ci-profile/record.mjs";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const workspaceRoot = resolve(packageRoot, "../..");
const args = process.argv.slice(2).filter((value) => value !== "--dry-run");
const dryRun = process.argv.includes("--dry-run");

const shardArg = args.find((value) => value.startsWith("--shard="));
const shardMatch = shardArg ? /^--shard=(\d+)\/(\d+)$/.exec(shardArg) : null;
if (args.filter(value => value.startsWith("--shard=")).length > 1 || (shardArg && !shardMatch)) {
  console.error(`[pr-vitest-lane] unrecognized shard argument: ${shardArg}`);
  process.exit(1);
}
if (shardMatch && (Number(shardMatch[1]) < 1 || Number(shardMatch[1]) > Number(shardMatch[2]))) {
  throw new Error(`Invalid shard: ${shardArg}`);
}
const isFinalShard = !shardArg || shardMatch[1] === shardMatch[2];
const isPrWorkflow = process.env.GITHUB_WORKFLOW === "PR";
const runNativeRunnerGroup = isPrWorkflow && isFinalShard;
// Reuse the two existing CI slots: all package files in the first, all native
// server files in the second. Keeping the old command arguments makes this
// safe while the trusted workflow still comes from master. Other shard counts
// and local callers retain ordinary Vitest sharding and the final-lane append.
const separateWorkloads = isPrWorkflow && shardMatch?.[2] === "2";
const runPackageTests = !separateWorkloads || !isFinalShard;
const packageArgs = separateWorkloads ? args.filter((arg) => arg !== shardArg) : args;

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
  console.log(JSON.stringify({ isPrWorkflow, isFinalShard, runNativeRunnerGroup, runPackageTests, plannedCommands }, null, 2));
  process.exit(0);
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
