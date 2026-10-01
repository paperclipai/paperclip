// Runs this package's vitest shard for a Verify Paperclip Runner lane, then —
// on the final shard of the PR workflow only — the server package's
// general-server-native-runner group.
//
// That server suite rebuilds the Runner release binaries with cargo in
// beforeAll. The PR workflow's plain General tests server shards carry no
// Rust cache, so hosting it there cold-compiled every third-party crate on
// each run (277s of a 291s shard vitest step, actions run 35246999382,
// 2026-09-17) and made that shard the slowest check of the whole run. The
// Verify Paperclip Runner lanes already restore the shared release-runner-v1
// Rust cache read-only, which turns that build into an incremental rebuild,
// and the workflow files themselves list this lane's command as a package
// script — so the suite moves here without a workflow-file change.
//
// Contract, mirrored in scripts/run-vitest-stable.mjs (prWorkflowName) and
// pinned by scripts/__tests__/run-vitest-stable-shard.test.mjs:
// - Only the PR workflow (pr.yml, whose GITHUB_WORKFLOW the reusable
//   pr-trusted.yml jobs inherit) excludes the suite from the server shards,
//   and only there does this wrapper run it. Any other caller — local runs,
//   release-verify.yml — keeps the suite in the server group, so a renamed
//   workflow degrades to the slower covered path instead of losing coverage.
// - The suite runs on the lane whose --shard=N/M has N === M (or an unsharded
//   invocation), so exactly one PR lane carries it.
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const workspaceRoot = resolve(packageRoot, "../..");
const args = process.argv.slice(2).filter((value) => value !== "--dry-run");
const dryRun = process.argv.includes("--dry-run");

const shardArg = args.find((value) => value.startsWith("--shard="));
const shardMatch = shardArg ? /^--shard=(\d+)\/(\d+)$/.exec(shardArg) : null;
if (shardArg && !shardMatch) {
  console.error(`[pr-vitest-lane] unrecognized shard argument: ${shardArg}`);
  process.exit(1);
}
const isFinalShard = !shardArg || shardMatch[1] === shardMatch[2];
const isPrWorkflow = process.env.GITHUB_WORKFLOW === "PR";
const runNativeRunnerGroup = isPrWorkflow && isFinalShard;

const plannedCommands = [
  { command: "pnpm", args: ["run", "ensure:eval-build-deps"], cwd: packageRoot },
  { command: "pnpm", args: ["run", "build:rust"], cwd: packageRoot },
  { command: "pnpm", args: ["exec", "vitest", "run", ...args], cwd: packageRoot },
  ...(runNativeRunnerGroup
    ? [{
        command: "pnpm",
        args: ["test:run:general", "--", "--group", "general-server-native-runner"],
        cwd: workspaceRoot,
      }]
    : []),
];

if (dryRun) {
  console.log(JSON.stringify({ isPrWorkflow, isFinalShard, runNativeRunnerGroup, plannedCommands }, null, 2));
  process.exit(0);
}

for (const planned of plannedCommands) {
  const result = spawnSync(planned.command, planned.args, {
    cwd: planned.cwd,
    stdio: "inherit",
  });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}
