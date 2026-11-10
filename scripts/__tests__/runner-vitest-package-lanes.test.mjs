// Runs real Vitest against the Runner package, so it needs installed workspace
// dependencies. The `policy` job runs run-vitest-stable-shard.test.mjs without
// them; this file runs in `test:release-registry` (Typecheck + Release Registry),
// which installs dependencies first.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { defaultSuiteWeight, loadShardDurations } from "../general-server-shard.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const runnerRoot = path.join(repoRoot, "packages/paperclip-runner");
const laneWrapper = path.join(runnerRoot, "scripts/run-pr-vitest-lane.mjs");
const prepCommands = [
  { command: "pnpm", args: ["run", "ensure:eval-build-deps"], cwd: runnerRoot },
  { command: "pnpm", args: ["run", "build:rust"], cwd: runnerRoot },
];

function wrapperPlan(args, envOverrides = {}) {
  const result = spawnSync(process.execPath, [laneWrapper, ...args, "--dry-run"], {
    cwd: repoRoot,
    encoding: "utf8",
    env: { ...process.env, ...envOverrides },
  });
  assert.equal(result.status, 0, `expected wrapper dry run to succeed for ${args.join(" ")}: ${result.stderr}`);
  return JSON.parse(result.stdout);
}

// Asks Vitest itself which files the given CLI filters select, so both the
// inventory and the lanes' substring filters follow vitest.config.ts exactly.
function vitestListFiles(filters = []) {
  const listed = spawnSync(process.execPath, [path.join(runnerRoot, "node_modules/vitest/vitest.mjs"), "list", "--filesOnly", ...filters], {
    cwd: runnerRoot, encoding: "utf8", env: { ...process.env, PAPERCLIP_CI_PROFILE: "" }, maxBuffer: 16 * 1024 * 1024,
  });
  assert.equal(listed.status, 0, listed.stderr);
  return listed.stdout.split("\n").map((line) => line.trim().replaceAll("\\", "/"))
    .filter((line) => /\.test\.[cm]?[jt]sx?$/.test(line)).sort();
}

test("package lanes form a complete, non-overlapping, balanced cover of the Vitest inventory", () => {
  const inventory = vitestListFiles();
  assert.ok(inventory.length > 100, `expected the full Runner package inventory, got ${inventory.length}`);

  const durations = loadShardDurations(path.join(runnerRoot, "scripts/vitest-lane-durations.json"));
  const weight = (file) => durations[`packages/paperclip-runner/${file}`] ?? defaultSuiteWeight(durations);
  const laneCount = 3;
  const lanes = Array.from({ length: laneCount }, (_, index) => {
    const plan = wrapperPlan([`--package-lane=${index + 1}/${laneCount}`], { GITHUB_WORKFLOW: "PR" });
    assert.equal(plan.runNativeRunnerGroup, false);
    assert.deepEqual(plan.plannedCommands.slice(0, 2), prepCommands, "every package lane prepares debug fixtures");
    assert.ok(!plan.plannedCommands.some((command) => command.args.includes("general-server-native-runner")));
    assert.equal(plan.packageLane.inventory, inventory.length);
    const vitest = plan.plannedCommands.filter((command) => command.args[0] === "exec");
    assert.equal(vitest.length, 1);
    assert.deepEqual(vitest[0].args, ["exec", "vitest", "run", ...plan.packageLane.files]);
    assert.ok(plan.packageLane.files.length > 0, "an empty filter list would run the whole inventory");
    return plan.packageLane;
  });

  const assigned = lanes.flatMap((lane) => lane.files);
  assert.equal(new Set(assigned).size, assigned.length, "a file is assigned to more than one lane");
  assert.deepEqual([...assigned].sort(), inventory, "the lanes must cover the inventory exactly");
  for (const lane of lanes) {
    // Vitest filters are substring matches; no lane may also select another lane's files.
    assert.deepEqual(vitestListFiles(lane.files), [...lane.files].sort(), `lane ${lane.index} filters`);
    assert.equal(lane.estimatedMs, lane.files.reduce((total, file) => total + weight(file), 0));
  }
  // Longest-processing-time bound: no lane exceeds the mean by more than the heaviest file.
  const total = inventory.reduce((sum, file) => sum + weight(file), 0);
  const heaviest = Math.max(...inventory.map(weight));
  for (const lane of lanes) assert.ok(lane.estimatedMs <= total / laneCount + heaviest, `lane ${lane.index} is unbalanced`);
});
