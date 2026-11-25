import { readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadShardDurations, partitionGeneralServerSuites } from "./general-server-shard.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..");
const E2E_DIR = path.join(REPO_ROOT, "tests", "e2e");
const DURATIONS_MANIFEST = path.join(HERE, "e2e-shard-durations.json");

// Specs the default local_trusted Playwright project deliberately skips. Keep
// this in sync with `testIgnore` in tests/e2e/playwright.config.ts — the unit
// test in scripts/__tests__/e2e-shard.test.mjs fails if the two ever drift.
export const IGNORED_SPECS = ["in-feed-native/**", "multi-user.spec.ts", "multi-user-authenticated.spec.ts"];

// Specs that mutate instance-wide state on the shared throwaway server or
// assert strict real-time latency / focus restoration sensitive to concurrent
// Chromium contention, and therefore must run with `workers: 1`. Keep in sync
// with `SERIAL_SPECS` in tests/e2e/playwright.config.ts —
// `scripts/__tests__/e2e-shard.test.mjs` fails if the two ever drift.
export const SERIAL_SPECS = [
  "agent-chat-projects-handoff.spec.ts",
  "agent-chat-projects.spec.ts",
  "agent-chat-sessions-navigation.spec.ts",
  "agent-chat-sessions.spec.ts",
  "agent-configuration-revisions.spec.ts",
  "agent-configuration.spec.ts",
  "ai-personal-connection-recovery.spec.ts",
  "cases-read-only.spec.ts",
  "classic-workspace.spec.ts",
  "composer-stop.spec.ts",
  "connection-intents.spec.ts",
  "document-image-gallery.spec.ts",
  "onboarding-resume.spec.ts",
  "onboarding.spec.ts",
  "smoke-lab-p1-p4.spec.ts",
  "smoke-lab-p5-p7.spec.ts",
];

export const DEFAULT_PARALLEL_WORKERS = 2;
export const EFFECTIVE_PARALLEL_SPEEDUP = 1.85;
export const EFFECTIVE_PARALLEL_SPEEDUP_4W = 3.2;

export function resolveEffectiveParallelSpeedup(cpus = os.availableParallelism()) {
  const workers = Math.max(1, Math.min(4, Math.floor(cpus / 2)));
  if (workers >= 4) return EFFECTIVE_PARALLEL_SPEEDUP_4W;
  if (workers === 3) return 2.55;
  if (workers === 2) return EFFECTIVE_PARALLEL_SPEEDUP;
  return 1;
}

export function isSerialE2eSpec(file) {
  return SERIAL_SPECS.includes(path.posix.basename(file.split(path.sep).join("/")));
}

// Enumerates the specs the default e2e lane actually runs, as repo-relative
// paths so the output can be handed straight to `playwright test`.
export function listE2eSpecs(e2eDir = E2E_DIR, repoRoot = REPO_ROOT) {
  return readdirSync(e2eDir)
    .filter((entry) => entry.endsWith(".spec.ts") && !IGNORED_SPECS.includes(entry))
    .map((entry) => path.relative(repoRoot, path.join(e2eDir, entry)).split(path.sep).join("/"))
    .sort((a, b) => a.localeCompare(b));
}

// Isolate instance-mutating specs onto dedicated serial shards so every other
// shard runs purely parallel-safe specs with `workers > 1` and `fullyParallel`.
// Choose the serial/parallel shard split that minimizes projected max wall-clock
// across all shards (serial shards run at 1x, parallel shards at 1/parallelWorkers).
export function partitionE2eShards(
  files,
  shardCount,
  durations = {},
  { parallelWorkers = EFFECTIVE_PARALLEL_SPEEDUP } = {},
) {
  const serialFiles = files.filter(isSerialE2eSpec);
  const parallelFiles = files.filter((file) => !isSerialE2eSpec(file));

  if (shardCount <= 1 || serialFiles.length === 0 || parallelFiles.length === 0) {
    const mode = serialFiles.length > 0 ? "serial" : "parallel";
    const effectiveWorkers = mode === "parallel" ? parallelWorkers : 1;
    return partitionGeneralServerSuites(files, shardCount, durations).map((shard) => ({
      ...shard,
      mode,
      estimatedWallMs: shard.totalWeight / effectiveWorkers,
    }));
  }

  const maxSerialShards = Math.min(serialFiles.length, shardCount - 1);
  let bestPlan = null;

  for (let serialShardCount = 1; serialShardCount <= maxSerialShards; serialShardCount += 1) {
    const parallelShardCount = shardCount - serialShardCount;
    if (parallelShardCount > parallelFiles.length) continue;

    const serialShards = partitionGeneralServerSuites(serialFiles, serialShardCount, durations).map((shard) => ({
      ...shard,
      mode: "serial",
      estimatedWallMs: shard.totalWeight,
    }));
    const parallelShards = partitionGeneralServerSuites(parallelFiles, parallelShardCount, durations).map((shard) => ({
      ...shard,
      mode: "parallel",
      estimatedWallMs: shard.totalWeight / parallelWorkers,
    }));
    const combined = [...serialShards, ...parallelShards];
    const maxWallMs = Math.max(...combined.map((shard) => shard.estimatedWallMs));

    if (!bestPlan || maxWallMs < bestPlan.maxWallMs) {
      bestPlan = { maxWallMs, shards: combined };
    }
  }

  return bestPlan.shards;
}

// Playwright's own --shard balances by test count, which is useless here: spec
// durations vary by 80x and a handful of specs mutate instance-wide settings.
// Partition into dedicated serial and parallel shards weighted by estimated
// wall-clock time so every runner finishes together.
export function selectE2eShard(files, shardIndex, shardCount, durations = {}, options = {}) {
  return partitionE2eShards(files, shardCount, durations, options)[shardIndex].files;
}

function parseArgs(argv) {
  const args = { shardIndex: 0, shardCount: 1, parallelSpeedup: null };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--shard-index") args.shardIndex = Number(argv[index + 1]);
    if (argv[index] === "--shard-count") args.shardCount = Number(argv[index + 1]);
    if (argv[index] === "--parallel-speedup") args.parallelSpeedup = Number(argv[index + 1]);
  }
  return args;
}

function main(argv) {
  const { shardIndex, shardCount, parallelSpeedup } = parseArgs(argv);
  if (!Number.isInteger(shardCount) || shardCount < 1) {
    throw new Error(`--shard-count must be a positive integer, got ${shardCount}`);
  }
  if (!Number.isInteger(shardIndex) || shardIndex < 0 || shardIndex >= shardCount) {
    throw new Error(`--shard-index must be in [0, ${shardCount}), got ${shardIndex}`);
  }
  const envSpeedup = Number.parseFloat(process.env.PAPERCLIP_E2E_PARALLEL_SPEEDUP ?? "");
  const effectiveSpeedup =
    Number.isFinite(parallelSpeedup) && parallelSpeedup > 0
      ? parallelSpeedup
      : Number.isFinite(envSpeedup) && envSpeedup > 0
        ? envSpeedup
        : resolveEffectiveParallelSpeedup();

  const specs = listE2eSpecs();
  const durations = loadShardDurations(DURATIONS_MANIFEST);
  process.stdout.write(
    `${selectE2eShard(specs, shardIndex, shardCount, durations, { parallelWorkers: effectiveSpeedup }).join(" ")}\n`,
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2));
}
