import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const vitest = path.join(root, "node_modules/vitest/vitest.mjs");
const prefix = "[runner-e2e:unit]";

const NODE_TEST_FILES = [
  "tests/runner-e2e/product-regression-testops.test.mjs",
  "tests/runner-e2e/reliability-testops.test.mjs",
  "tests/runner-e2e/artifact-budget.test.mjs",
  "tests/runner-e2e/native-completion-checks.test.mjs",
  "tests/runner-e2e/native-completion-git-source.test.mjs",
  "tests/runner-e2e/native-completion-source-contract.test.mjs",
  "tests/runner-e2e/chat-feature-testops-api.test.mjs",
  "tests/runner-e2e/chat-feature-testops-cli.test.mjs",
  "tests/runner-e2e/chat-feature-testops-results.test.mjs",
  "tests/runner-e2e/testops-chat-reporter.test.mjs",
  "tests/runner-e2e/chat-feature-testops-retained-verification.node-test.mjs",
  "tests/runner-e2e/chat-completion-testops-api.test.mjs",
  "tests/runner-e2e/chat-completion-testops-contract.test.mjs",
  "tests/runner-e2e/chat-full-catalog-testops-manifest.test.mjs",
  "tests/runner-e2e/chat-full-catalog-testops-reconcile.test.mjs",
  "tests/runner-e2e/chat-full-catalog-testops-adapter.test.mjs",
  "tests/runner-e2e/chat-catalog-testops-streaming.test.mjs",
];

function failUsage(message) {
  console.error(`${prefix} ${message}`);
  process.exit(1);
}

function parseIntArg(raw, flag, min) {
  const parsed = Number(raw);
  if (raw === undefined || raw.trim() === "" || !Number.isInteger(parsed) || parsed < min) {
    failUsage(`${flag} must be an integer >= ${min}. Received ${JSON.stringify(raw)}.`);
  }
  return parsed;
}

function parseArgs(argv) {
  const rawArgs = [...argv];
  if (rawArgs[0] === "--") rawArgs.shift();

  let shardIndex = null;
  let shardCount = null;
  let dryRun = false;
  const passthrough = [];

  for (let i = 0; i < rawArgs.length; i += 1) {
    const arg = rawArgs[i];
    if (arg === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (arg === "--shard-index") {
      shardIndex = parseIntArg(rawArgs[i + 1], arg, 0);
      i += 1;
      continue;
    }
    if (arg.startsWith("--shard-index=")) {
      shardIndex = parseIntArg(arg.slice("--shard-index=".length), "--shard-index", 0);
      continue;
    }
    if (arg === "--shard-count") {
      shardCount = parseIntArg(rawArgs[i + 1], arg, 1);
      i += 1;
      continue;
    }
    if (arg.startsWith("--shard-count=")) {
      shardCount = parseIntArg(arg.slice("--shard-count=".length), "--shard-count", 1);
      continue;
    }
    passthrough.push(arg);
  }

  if ((shardIndex === null) !== (shardCount === null)) {
    failUsage("--shard-index and --shard-count must be provided together.");
  }
  if (shardIndex !== null && shardIndex >= shardCount) {
    failUsage(`--shard-index must be less than --shard-count. Received ${shardIndex} of ${shardCount}.`);
  }
  if (shardIndex !== null && passthrough.some((arg) => arg === "--shard" || arg.startsWith("--shard="))) {
    failUsage("--shard cannot be combined with --shard-index/--shard-count.");
  }

  return { shardIndex, shardCount, dryRun, passthrough };
}

const { shardIndex, shardCount, dryRun, passthrough } = parseArgs(process.argv.slice(2));

if (!existsSync(vitest)) {
  console.error(`${prefix} launcher/environment failure: Vitest is not installed. Run pnpm install before validation.`);
  process.exit(2);
}

const vitestShardArgs = shardCount !== null && shardCount > 1
  ? [`--shard=${shardIndex + 1}/${shardCount}`]
  : [];
const nodeTestFiles = shardCount !== null && shardCount > 1
  ? NODE_TEST_FILES.filter((_, index) => index % shardCount === shardIndex)
  : [...NODE_TEST_FILES];
const vitestArgs = ["run", "--config", "tests/runner-e2e/vitest.config.ts", ...vitestShardArgs, ...passthrough];

if (dryRun) {
  console.log(JSON.stringify({
    shardIndex,
    shardCount,
    vitestShard: vitestShardArgs[0] ?? null,
    vitestArgs,
    nodeTestFiles,
  }, null, 2));
  process.exit(0);
}

// Load after the check: a missing install must still report the launcher failure.
const { invocationEnv } = await import(new URL("../../scripts/ci-profile/record.mjs", import.meta.url).href);

const env = { ...process.env };
delete env.NODE_PATH;
delete env.NODE_OPTIONS;
env.NODE_COMPILE_CACHE ??= path.join(tmpdir(), "paperclip-runner-e2e-compile-cache");

const steps = [
  // Server modules under test import the built plugin SDK (and shared) package.
  ["Plugin build dependencies", ["scripts/ensure-plugin-build-deps.mjs"]],
  ["Vitest", [vitest, ...vitestArgs]],
  // The wrapper adds the CI profiling reporter when PAPERCLIP_CI_PROFILE is set.
  ...(nodeTestFiles.length > 0
    ? [["Node tests", ["scripts/ci-profile/node-test.mjs", ...nodeTestFiles]]]
    : []),
];

for (const [name, command] of steps) {
  const result = spawnSync(process.execPath, command, {
    cwd: root, env: name === "Vitest" ? invocationEnv("vitest", env) : env, stdio: "inherit",
  });
  if (result.error || result.signal) {
    console.error(`${prefix} launcher/environment failure: ${name} ${result.error?.message ?? `terminated by ${result.signal}`}`);
    process.exit(2);
  }
  if (result.status !== 0) {
    console.error(`${prefix} ${name} failed (exit ${result.status}); see test runner output above.`);
    process.exit(result.status ?? 1);
  }
}
