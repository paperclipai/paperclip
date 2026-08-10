import { readdirSync } from "node:fs";
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
export const IGNORED_SPECS = ["multi-user.spec.ts", "multi-user-authenticated.spec.ts"];

// Enumerates the specs the default e2e lane actually runs, as repo-relative
// paths so the output can be handed straight to `playwright test`.
export function listE2eSpecs(e2eDir = E2E_DIR, repoRoot = REPO_ROOT) {
  return readdirSync(e2eDir)
    .filter((entry) => entry.endsWith(".spec.ts") && !IGNORED_SPECS.includes(entry))
    .map((entry) => path.relative(repoRoot, path.join(e2eDir, entry)).split(path.sep).join("/"))
    .sort((a, b) => a.localeCompare(b));
}

// Playwright's own --shard balances by test count, which is useless here: one
// spec (smoke-lab) is ~40% of the lane's wall clock. Reuse the deterministic
// longest-processing-time partition already proven on the general-server lane
// so every runner computes the identical, non-overlapping split.
export function selectE2eShard(files, shardIndex, shardCount, durations = {}) {
  return partitionGeneralServerSuites(files, shardCount, durations)[shardIndex].files;
}

function parseArgs(argv) {
  const args = { shardIndex: 0, shardCount: 1 };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--shard-index") args.shardIndex = Number(argv[index + 1]);
    if (argv[index] === "--shard-count") args.shardCount = Number(argv[index + 1]);
  }
  return args;
}

function main(argv) {
  const { shardIndex, shardCount } = parseArgs(argv);
  if (!Number.isInteger(shardCount) || shardCount < 1) {
    throw new Error(`--shard-count must be a positive integer, got ${shardCount}`);
  }
  if (!Number.isInteger(shardIndex) || shardIndex < 0 || shardIndex >= shardCount) {
    throw new Error(`--shard-index must be in [0, ${shardCount}), got ${shardIndex}`);
  }

  const specs = listE2eSpecs();
  const durations = loadShardDurations(DURATIONS_MANIFEST);
  process.stdout.write(`${selectE2eShard(specs, shardIndex, shardCount, durations).join(" ")}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2));
}
