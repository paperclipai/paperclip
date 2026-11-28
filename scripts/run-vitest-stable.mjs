#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadShardDurations, selectGeneralServerShard } from "./general-server-shard.mjs";
import { invocationEnv } from "./ci-profile/record.mjs";
import { vitestRetryArgs } from "./ci/vitest-retry.mjs";
import {
  PR_WORKFLOW_NAME,
  isNightlyExclusionEnabled,
  loadNightlyOnlySuites,
  resolveNightlyOnlySuitesPath,
} from "./ci/nightly-only-suites.mjs";
import { runUnderSharedPostgres, shouldWrapWithSharedPostgres } from "./ci/vitest-shared-postgres.mjs";
import { resolveServerParallelWorkers, resolveWorkspaceParallelWorkers } from "./ci/vitest-workers.mjs";
import { selectWorkspaceProjectsShard } from "./ci/workspaces-b-shard.mjs";
import { loadSelection, selectedShard } from "./ci/test-selection-manifest.mjs";

const repoRoot = process.cwd();
const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
const generalServerShardDurations = loadShardDurations(
  path.join(scriptsDir, "general-server-shard-durations.json"),
);
const serializedShardDurations = loadShardDurations(
  path.join(scriptsDir, "serialized-shard-durations.json"),
);
const chatShardDurations = loadShardDurations(path.join(scriptsDir, "chat-shard-durations.json"));
const serverRoot = path.join(repoRoot, "server");
const serverSrcDir = path.join(repoRoot, "server", "src");
const serverTestsDir = path.join(repoRoot, "server", "src", "__tests__");
const serverScriptsDir = path.join(repoRoot, "server", "scripts");
const nonServerProjects = [
  "@paperclipai/shared",
  "@paperclipai/skills-catalog",
  "@paperclipai/db",
  "@paperclipai/adapter-utils",
  "@paperclipai/adapter-claude-local",
  "@paperclipai/adapter-codex-local",
  "@paperclipai/adapter-cursor-cloud",
  "@paperclipai/adapter-cursor-local",
  "@paperclipai/adapter-gemini-local",
  "@paperclipai/adapter-grok-local",
  "@paperclipai/hermes-paperclip-adapter",
  "@paperclipai/adapter-kimi-local",
  "@paperclipai/adapter-openclaw-gateway",
  "@paperclipai/adapter-opencode-local",
  "@paperclipai/adapter-pi-local",
  "@paperclipai/plugin-daytona",
  "@paperclipai/plugin-sdk",
  "@paperclipai/create-paperclip-plugin",
  "@paperclipai/ui",
  "paperclipai",
];
const routeTestPattern = /[^/]*(?:route|routes|authz)[^/]*\.test\.ts$/;
const additionalSerializedServerTests = new Set([
  "server/src/__tests__/approval-routes-idempotency.test.ts",
  "server/src/__tests__/assets.test.ts",
  "server/src/__tests__/authz-company-access.test.ts",
  "server/src/__tests__/companies-route-path-guard.test.ts",
  "server/src/__tests__/company-portability.test.ts",
  "server/src/__tests__/costs-service.test.ts",
  "server/src/__tests__/express5-auth-wildcard.test.ts",
  "server/src/__tests__/health-dev-server-token.test.ts",
  "server/src/__tests__/health.test.ts",
  "server/src/__tests__/heartbeat-dependency-native-wakes.test.ts",
  "server/src/__tests__/heartbeat-dependency-scheduling.test.ts",
  "server/src/__tests__/heartbeat-issue-liveness-escalation.test.ts",
  "server/src/__tests__/heartbeat-process-recovery-part-1.test.ts",
  "server/src/__tests__/heartbeat-process-recovery-part-2.test.ts",
  "server/src/__tests__/heartbeat-process-recovery-part-3.test.ts",
  "server/src/__tests__/heartbeat-process-recovery-part-4.test.ts",
  "server/src/__tests__/invite-accept-existing-member.test.ts",
  "server/src/__tests__/invite-accept-gateway-defaults.test.ts",
  "server/src/__tests__/invite-accept-replay.test.ts",
  "server/src/__tests__/invite-expiry.test.ts",
  "server/src/__tests__/invite-join-manager.test.ts",
  "server/src/__tests__/invite-onboarding-text.test.ts",
  "server/src/__tests__/invite-url-public-base-url.test.ts",
  "server/src/__tests__/issues-checkout-wakeup.test.ts",
  "server/src/__tests__/issues-service.test.ts",
  "server/src/__tests__/opencode-local-adapter-environment.test.ts",
  "server/src/__tests__/project-routes-env.test.ts",
  "server/src/__tests__/redaction.test.ts",
  "server/src/__tests__/routines-e2e.test.ts",
]);
// Suite-specific external URLs can also name a shared mutable database.
// Owned database factories use PAPERCLIP_TEST_POSTGRES_ADMIN_URL instead.
const hasSharedTestDatabase = Object.entries(process.env).some(([key, value]) =>
  key.startsWith("PAPERCLIP_") && key.endsWith("_TEST_DATABASE_URL") && value?.trim(),
);
let invocationIndex = 0;
const serializedModeName = "serialized";
const generalModeName = "general";
const allModeName = "all";
const generalServerGroupName = "general-server";
const generalServerWithoutChatGroupName = "general-server-without-chat";
const generalServerWithoutChatOrNativeRunnerGroupName = "general-server-without-chat-or-native-runner";
const generalChatGroupName = "general-chat";
const generalServerNativeRunnerGroupName = "general-server-native-runner";
const chatSuitesPrefix = "server/src/__tests__/chat-channels/";
const legacyChatSuitePath = "server/src/__tests__/chat-channels.integration.test.ts";

function isChatChannelSuite(repoPath) {
  return (
    (repoPath.startsWith(chatSuitesPrefix) && repoPath.endsWith(".test.ts")) ||
    repoPath === legacyChatSuitePath
  );
}
// The first suite rebuilds the Runner release binaries with cargo in beforeAll.
// Inside the PR workflow's plain server shards, which carry no Rust cache,
// that build was a ~4m30s cold compile of every third-party crate on each run
// (277s of a 291s shard vitest step, actions run 35246999382, 2026-09-17).
const nativeRunnerSuites = [
  "server/src/services/native-runtime/plugin-runner-probe.test.ts",
  "server/src/services/native-runtime/native-codex-runner.integration.test.ts",
  "server/src/services/native-runtime/native-ingress-bootstrap-retry.integration.test.ts",
  "server/src/services/native-runtime/native-ingress-bootstrap-retry-opencode.integration.test.ts",
  "server/src/__tests__/dot-runner.test.ts",
  // These process cases otherwise skip in server shards without Runner binaries.
  "server/src/services/native-runtime/native-runner-restart-recovery.integration.test.ts",
  "server/src/services/native-runtime/native-runner-restart-lease-renewal.integration.test.ts",
  "server/src/services/native-runtime/native-runner-restart-preparation.integration.test.ts",
  "server/src/services/native-runtime/native-runner-restart-checkpoint-cost.integration.test.ts",
  "server/src/services/native-runtime/native-runner-restart-diskless-direct.integration.test.ts",
  "server/src/services/native-runtime/native-runner-restart-diskless-prepared-task.integration.test.ts",
  "server/src/services/native-runtime/native-cut-turn-start-retry.integration.test.ts",
  "server/src/services/native-runtime/native-usage-delivery.integration.test.ts",
  "server/src/services/native-runtime/native-warm-checkpoint-ownership.integration.test.ts",
  "server/src/services/native-runtime/native-warm-successor-runner-release.integration.test.ts",
  "server/src/services/native-runtime/plugin-runner-task-warm.integration.test.ts",
  "server/src/services/native-runtime/plugin-runner-release-resume-cached.integration.test.ts",
  "server/src/services/native-runtime/plugin-runner-release-resume-adopted.integration.test.ts",
  "server/src/services/native-runtime/plugin-runner-eviction-codex-retired.integration.test.ts",
  "server/src/services/native-runtime/plugin-runner-eviction-codex-abrupt.integration.test.ts",
  "server/src/services/native-runtime/plugin-runner-eviction-claude-retired.integration.test.ts",
  "server/src/services/native-runtime/plugin-runner-eviction-claude-abrupt.integration.test.ts",
];
// In the PR workflow (pr.yml, the caller of pr-trusted.yml — reusable
// workflows inherit the caller's GITHUB_WORKFLOW), the last Verify Paperclip
// Runner vitest shard runs the native-runner group instead, because those
// lanes restore the shared release-runner-v2 Rust cache (see
// packages/paperclip-runner/scripts/run-pr-vitest-lane.mjs). Every other
// caller of the same group keeps the suite in the server shards, so a renamed or
// unknown workflow degrades to today's slower-but-covered behavior rather
// than dropping the suite.
const prWorkflowName = PR_WORKFLOW_NAME;
const nativeRunnerSuiteRunsInRustCachedLane = process.env.GITHUB_WORKFLOW === prWorkflowName;
const nightlyOnlySuitesPath = resolveNightlyOnlySuitesPath({ repoRoot });
const strictlySerialServerTests = new Set([]);

let allNightlyOnlySuites;
try {
  allNightlyOnlySuites = loadNightlyOnlySuites(nightlyOnlySuitesPath);
} catch (error) {
  fail(error.message);
}
const nightlyExclusionActive = isNightlyExclusionEnabled();
const activeNightlyOnlySuites = nightlyExclusionActive ? allNightlyOnlySuites : new Set();

function activeNativeRunnerSuites() {
  return nativeRunnerSuites.filter((file) => !activeNightlyOnlySuites.has(file));
}

function selectNativeRunnerSuites(shardIndex = null, shardCount = null) {
  const suites = activeNativeRunnerSuites();
  if (shardCount === null || shardCount <= 1) {
    return suites;
  }
  return selectGeneralServerShard(
    suites,
    shardIndex,
    shardCount,
    generalServerShardDurations,
  );
}

function resolveWorkers(lane) {
  try {
    return resolveServerParallelWorkers(lane);
  } catch (error) {
    fail(error.message);
  }
}

// Release verification selects this explicit group and runs the omitted suites
// in its cached Runner job. Local callers keep the complete default group.
const generalServerGroups = [
  generalServerGroupName,
  generalServerWithoutChatGroupName,
  generalServerWithoutChatOrNativeRunnerGroupName,
];
function baseExcludedServerSuites(groupName) {
  if (groupName === generalServerWithoutChatOrNativeRunnerGroupName) {
    return [...chatSuites, ...nativeRunnerSuites];
  }
  if (groupName === generalServerWithoutChatGroupName) {
    return nativeRunnerSuiteRunsInRustCachedLane
      ? [...chatSuites, ...nativeRunnerSuites]
      : [...chatSuites];
  }
  return [];
}
function excludedServerSuites(groupName) {
  const base = baseExcludedServerSuites(groupName);
  if (groupName === generalServerGroupName || activeNightlyOnlySuites.size === 0) {
    return base;
  }
  return [...new Set([...base, ...activeNightlyOnlySuites])];
}
const generalWorkspacesAGroupName = "general-workspaces-a";
const generalWorkspacesBGroupName = "general-workspaces-b";
const generalWorkspacesCGroupName = "general-workspaces-c";
const generalWorkspacesAProjects = ["@paperclipai/ui", "paperclipai"];
// The db project runs in its own lane. Its vitest invocation took 168-250s
// of a 436-513s workspaces-b job (PR runs 38084171761, 38083084276 and
// 38083020834, 2026-10-10), which made workspaces-b the slowest check once
// the server shards were rebalanced. Vitest's native --shard would not help
// here: the project is already file-parallel and client.test.ts alone is
// 117-189s of its wall time, so a hash-ordered slice can land both of its
// slow suites on one runner. Splitting by project is deterministic and
// leaves the remaining projects at ~265-275s of vitest time, roughly level
// with this lane.
const generalWorkspacesCProjects = ["@paperclipai/db"];
const generalWorkspacesBProjects = nonServerProjects.filter(
  (project) => !generalWorkspacesAProjects.includes(project) && !generalWorkspacesCProjects.includes(project),
);
const generalGroupNames = [
  generalServerGroupName,
  generalWorkspacesAGroupName,
  generalWorkspacesBGroupName,
  generalWorkspacesCGroupName,
];
const allowedGeneralGroupNames = [
  ...generalGroupNames,
  generalServerWithoutChatGroupName,
  generalServerWithoutChatOrNativeRunnerGroupName,
  generalChatGroupName,
  generalServerNativeRunnerGroupName,
];
const serializedServerVitestArgs = [
  "--no-file-parallelism",
  "--maxWorkers=1",
];
const sourceOnlyVitestArgs = ["--exclude", "**/dist/**"];

function walk(dir) {
  const entries = readdirSync(dir);
  const files = [];
  for (const entry of entries) {
    const absolute = path.join(dir, entry);
    const stats = statSync(absolute);
    if (stats.isDirectory()) {
      files.push(...walk(absolute));
    } else if (stats.isFile()) {
      files.push(absolute);
    }
  }
  return files;
}

function toRepoPath(file) {
  return path.relative(repoRoot, file).split(path.sep).join("/");
}

function toServerPath(file) {
  return path.relative(serverRoot, file).split(path.sep).join("/");
}

function isRouteOrAuthzTest(file) {
  if (isChatChannelSuite(file)) {
    return false;
  }
  if (routeTestPattern.test(file)) {
    return true;
  }

  return additionalSerializedServerTests.has(file);
}

function fail(message) {
  console.error(`[test:run] ${message}`);
  process.exit(1);
}

function readOptionValue(argv, index, argName) {
  const value = argv[index + 1];
  if (value === undefined) {
    fail(`Missing value for ${argName}`);
  }

  return value;
}

function parseNonNegativeInteger(value, argName) {
  const parsed = Number(value);
  if (value.trim() === "" || !Number.isInteger(parsed) || parsed < 0) {
    fail(`${argName} must be a non-negative integer. Received "${value}".`);
  }

  return parsed;
}

function parsePositiveInteger(value, argName) {
  const parsed = Number(value);
  if (value.trim() === "" || !Number.isInteger(parsed) || parsed < 1) {
    fail(`${argName} must be a positive integer. Received "${value}".`);
  }

  return parsed;
}

function parseCliOptions(argv) {
  let mode = allModeName;
  let shardIndex = null;
  let shardCount = null;
  let group = null;
  let dryRun = false;
  let serialChat = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--") {
      continue;
    }

    if (arg === "--mode") {
      mode = readOptionValue(argv, index, arg);
      index += 1;
      continue;
    }

    if (arg.startsWith("--mode=")) {
      mode = arg.slice("--mode=".length);
      continue;
    }

    if (arg === "--shard-index") {
      shardIndex = parseNonNegativeInteger(readOptionValue(argv, index, arg), arg);
      index += 1;
      continue;
    }

    if (arg.startsWith("--shard-index=")) {
      shardIndex = parseNonNegativeInteger(arg.slice("--shard-index=".length), "--shard-index");
      continue;
    }

    if (arg === "--shard-count") {
      shardCount = parsePositiveInteger(readOptionValue(argv, index, arg), arg);
      index += 1;
      continue;
    }

    if (arg.startsWith("--shard-count=")) {
      shardCount = parsePositiveInteger(arg.slice("--shard-count=".length), "--shard-count");
      continue;
    }

    if (arg === "--dry-run") {
      dryRun = true;
      continue;
    }

    if (arg === "--serial-chat") {
      serialChat = true;
      continue;
    }

    if (arg === "--group") {
      group = readOptionValue(argv, index, arg);
      index += 1;
      continue;
    }

    if (arg.startsWith("--group=")) {
      group = arg.slice("--group=".length);
      continue;
    }

    fail(`Unknown argument "${arg}".`);
  }

  if (!new Set([allModeName, generalModeName, serializedModeName]).has(mode)) {
    fail(`Unknown mode "${mode}". Expected one of: ${allModeName}, ${generalModeName}, ${serializedModeName}.`);
  }

  if ((shardIndex === null) !== (shardCount === null)) {
    fail("--shard-index and --shard-count must be provided together.");
  }

  const shardAllowed =
    mode === serializedModeName ||
    (mode === generalModeName &&
      ([...generalServerGroups, generalChatGroupName, generalServerNativeRunnerGroupName, generalWorkspacesAGroupName, generalWorkspacesBGroupName].includes(group)
        || Boolean(process.env.PAPERCLIP_CI_TEST_SELECTION)
          && generalWorkspacesCGroupName === group));
  if (!shardAllowed && shardIndex !== null) {
    fail(
      "--shard-index/--shard-count require serialized mode, a shardable general server/chat/workspaces-a/workspaces-b group, or a selected workspace group.",
    );
  }

  if (group !== null && mode !== generalModeName) {
    fail("--group is only valid with --mode general.");
  }

  if (group !== null && !allowedGeneralGroupNames.includes(group)) {
    fail(`Unknown group "${group}". Expected one of: ${allowedGeneralGroupNames.join(", ")}.`);
  }

  if (serialChat && (mode !== generalModeName || group !== generalChatGroupName)) {
    fail("--serial-chat is only valid with --mode general --group general-chat.");
  }

  if (shardIndex !== null) {
    if (shardIndex >= shardCount) {
      fail(`--shard-index must be less than --shard-count. Received ${shardIndex} of ${shardCount}.`);
    }
  }

  if (mode === serializedModeName) {
    return {
      mode,
      shardIndex: shardIndex ?? 0,
      shardCount: shardCount ?? 1,
      group: null,
      dryRun,
    };
  }

  return {
    mode,
    shardIndex,
    shardCount,
    group,
    dryRun,
    serialChat,
  };
}

function selectSerializedSuites(routeTests, shardIndex, shardCount) {
  // Same duration-aware LPT partition as the general-server lane. Round-robin
  // over the alphabetical list clustered the heavy heartbeat/issues suites on
  // one shard (291s vs 170-201s test steps across the matrix in actions run
  // 32012408876), which made that shard the whole PR run's slowest check.
  const byRepoPath = new Map(routeTests.map((routeTest) => [routeTest.repoPath, routeTest]));
  const shardFiles = selectGeneralServerShard(
    routeTests.map((routeTest) => routeTest.repoPath),
    shardIndex,
    shardCount,
    serializedShardDurations,
  );
  return shardFiles.map((file) => byRepoPath.get(file));
}

function isolatedTestEnv() {
  invocationIndex += 1;
  const tempRootParent = process.platform === "win32" ? os.tmpdir() : "/tmp";
  // Production workspace/security checks reject symlink aliases. In particular
  // /tmp is /private/tmp on macOS, so fixture roots must use the canonical path.
  const testRoot = realpathSync(mkdtempSync(path.join(tempRootParent, "pv-")));
  // Keep per-run paths compact so Unix socket fixtures stay under macOS path limits.
  // Explicitly clear worktree vars so tests never inherit an outer agent's context
  // and accidentally clobber the canonical Paperclip config (KEWL-3955).
  const env = {
    ...process.env,
    NODE_ENV: "test",
    PAPERCLIP_TEST_HOST_HOME: process.env.PAPERCLIP_TEST_HOST_HOME
      ?? (process.env.PAPERCLIP_HOME?.trim() || path.join(os.homedir(), ".paperclip")),
    PAPERCLIP_HOME: path.join(testRoot, "h"),
    // Config discovery otherwise prefers the checkout's .paperclip/config.json
    // over PAPERCLIP_HOME, importing preview scheduling policy into unit tests.
    PAPERCLIP_CONFIG: path.join(testRoot, "h", "config.json"),
    PAPERCLIP_INSTANCE_ID: `vt-${process.pid}-${invocationIndex}`,
    TMPDIR: path.join(testRoot, "t"),
    PAPERCLIP_IN_WORKTREE: undefined,
    PAPERCLIP_CONTEXT: undefined,
    PAPERCLIP_WORKTREE_NAME: undefined,
    PAPERCLIP_WORKTREES_DIR: undefined,
  };
  // The wrapper has already validated and consumed this shard's manifest.
  // Tests may launch independent runner fixtures with a different root/inventory.
  delete env.PAPERCLIP_CI_TEST_SELECTION;
  delete env.PAPERCLIP_CI_SELECTION_HASH;
  mkdirSync(env.PAPERCLIP_HOME, { recursive: true });
  mkdirSync(env.TMPDIR, { recursive: true });
  return { testRoot, env };
}

async function runVitest(args, label, exactFiles = false) {
  console.log(`\n[test:run] ${label}`);
  const isolated = isolatedTestEnv();
  const { env } = isolated;
  await new Promise((resolve, reject) => {
    const command = exactFiles ? process.execPath : "pnpm";
    const prefix = exactFiles ? [path.join(scriptsDir, "ci/run-selected-vitest.mjs")] : ["exec", "vitest", "run"];
    const child = spawn(command, [...prefix, ...sourceOnlyVitestArgs, ...vitestRetryArgs(), ...args], {
      cwd: repoRoot,
      env: invocationEnv("vitest", env),
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${label} failed (${signal ?? code})`));
    });
  });
}

function selectChatSuites(shardIndex = null, shardCount = null) {
  const active = chatSuites.filter((file) => !activeNightlyOnlySuites.has(file));
  if (shardCount !== null && shardCount > 1) {
    return selectGeneralServerShard(active, shardIndex, shardCount, chatShardDurations);
  }
  return active;
}

async function runGeneralSuites(routeTests, isolateChat) {
  if (isolateChat) {
    await runGeneralGroup(routeTests, generalChatGroupName, null, null);
  }
  for (const groupName of generalGroupNames) {
    await runGeneralGroup(routeTests, groupName, null, null, isolateChat ? chatSuites : []);
  }
}

async function runProjectGroup(projects, groupName, shardIndex = null, shardCount = null, excludedFiles = [], extraArgs = []) {
  // Run the whole group in a single multi-project Vitest invocation so Vitest
  // boots once and shares module transform/worker pool overhead across packages.
  // With shard args, Vitest's native --shard deterministically partitions the
  // combined file list across runners into a complete, non-overlapping cover.
  const shardArgs =
    shardCount !== null && shardCount > 1 ? [`--shard=${shardIndex + 1}/${shardCount}`] : [];
  const shardSuffix = shardArgs.length > 0 ? ` shard ${shardIndex + 1}/${shardCount}` : "";
  const excludeArgs = excludedFiles.flatMap((file) => ["--exclude", file]);
  const projectArgs = projects.flatMap((project) => ["--project", project]);
  const label = projects.length === 1
    ? `${groupName} project ${projects[0]}${shardSuffix}`
    : `${groupName} (${projects.length} projects)${shardSuffix}`;
  await runVitest([...projectArgs, ...excludeArgs, ...shardArgs, ...extraArgs], label);
}

function groupUsesPostgres(opts, sel) {
  if (sel) {
    return Boolean(sel["@paperclipai/server"]?.length || sel["@paperclipai/db"]?.length);
  }
  if (opts.mode === serializedModeName || opts.mode === allModeName) {
    return true;
  }
  if (opts.mode === generalModeName) {
    if (opts.group === null) return true;
    return (
      generalServerGroups.includes(opts.group) ||
      opts.group === generalChatGroupName ||
      opts.group === generalServerNativeRunnerGroupName ||
      opts.group === generalWorkspacesCGroupName
    );
  }
  return false;
}

function hasScheduledSuitesForRun(opts, sel) {
  if (sel) {
    return Object.values(sel).some((files) => files.length > 0);
  }
  if (opts.mode === serializedModeName) {
    return selectSerializedSuites(activeRouteTests, opts.shardIndex, opts.shardCount).length > 0;
  }
  if (opts.mode === generalModeName && opts.group === generalChatGroupName) {
    return selectChatSuites(opts.shardIndex, opts.shardCount).length > 0;
  }
  if (opts.mode === generalModeName && opts.group === generalServerNativeRunnerGroupName) {
    return selectNativeRunnerSuites(opts.shardIndex, opts.shardCount).length > 0;
  }
  if (opts.mode === generalModeName && generalServerGroups.includes(opts.group)) {
    const excluded = new Set(excludedServerSuites(opts.group));
    const files = generalServerTestFiles.filter((file) => !excluded.has(file));
    if (opts.shardCount !== null && opts.shardCount > 1) {
      return selectGeneralServerShard(files, opts.shardIndex, opts.shardCount, generalServerShardDurations).length > 0;
    }
    return files.length > 0;
  }
  return true;
}

async function runGeneralGroup(routeTests, groupName, shardIndex = null, shardCount = null, additionalExcludedSuites = []) {
  if (groupName === generalChatGroupName) {
    const shardFiles = selectChatSuites(shardIndex, shardCount);
    const shardSuffix = shardCount !== null && shardCount > 1 ? ` shard ${shardIndex + 1}/${shardCount}` : "";
    console.log(
      `\n[test:run] general-chat${shardSuffix} running ${shardFiles.length} of ${chatSuites.length} suites`,
    );
    if (shardFiles.length === 0) {
      return;
    }
    const parallelArgs = hasSharedTestDatabase || options.serialChat
      ? ["--pool=forks", "--isolate", ...serializedServerVitestArgs]
      : ["--pool=forks", "--isolate", "--fileParallelism", `--maxWorkers=${resolveWorkers("general")}`];
    await runVitest(
      ["--project", "@paperclipai/server", ...parallelArgs, ...shardFiles],
      `general-chat${shardSuffix}`,
    );
    return;
  }
  if (groupName === generalServerNativeRunnerGroupName) {
    const allNativeSuites = activeNativeRunnerSuites();
    const suites = selectNativeRunnerSuites(shardIndex, shardCount);
    const shardSuffix = shardCount !== null && shardCount > 1 ? ` shard ${shardIndex + 1}/${shardCount}` : "";
    if (suites.length === 0) {
      console.log(`\n[test:run] native runner vertical-slice suite${shardSuffix}: 0 suites; skipping`);
      return;
    }
    console.log(
      `\n[test:run] general-server-native-runner${shardSuffix} running ${suites.length} of ${allNativeSuites.length} suites`,
    );
    await runVitest(
      ["--project", "@paperclipai/server",
        // Each file owns its database, home, and processes. Keep cases serial,
        // but overlap long real lease windows across isolated fork workers.
        ...(hasSharedTestDatabase ? serializedServerVitestArgs
          : ["--pool=forks", "--isolate", "--fileParallelism", `--maxWorkers=${resolveWorkers("general")}`]),
        ...suites],
      `native runner vertical-slice suite${shardSuffix}`,
    );
    return;
  }
  if (generalServerGroups.includes(groupName)) {
    const excludedSuites = [...excludedServerSuites(groupName), ...additionalExcludedSuites];
    const files = generalServerTestFiles.filter((file) => !excludedSuites.includes(file));
    if (shardCount !== null && shardCount > 1) {
      const shardFiles = selectGeneralServerShard(
        files,
        shardIndex,
        shardCount,
        generalServerShardDurations,
      );
      console.log(
        `\n[test:run] general-server shard ${shardIndex + 1}/${shardCount} running ${shardFiles.length} of ${files.length} suites`,
      );
      if (shardFiles.length === 0) {
        return;
      }

      const workers = resolveWorkers("general");
      await runVitest(
        [
          "--project",
          "@paperclipai/server",
          // Files have separate fork processes, isolated homes/configs, and
          // disposable per-file databases on the shared test PostgreSQL server.
          // Keep each file's cases serial; overlap independent files across workers.
          // An explicit shared mutable test database cannot be isolated this way.
          ...(hasSharedTestDatabase
            ? serializedServerVitestArgs
            : ["--pool=forks", "--isolate", "--fileParallelism", `--maxWorkers=${workers}`]),
          ...shardFiles,
        ],
        `${groupName} shard ${shardIndex + 1}/${shardCount}`,
      );
      return;
    }

    if (files.length === 0) {
      console.log(`\n[test:run] ${groupName}: 0 suites after filtering; skipping`);
      return;
    }

    const excludeRouteArgs = routeTests.flatMap((file) => ["--exclude", file.serverPath]);
    for (const suite of excludedSuites) {
      if (suite.startsWith("server/")) {
        excludeRouteArgs.push("--exclude", suite.replace(/^server\//, ""));
      }
    }
    await runVitest(
      [
        "--project",
        "@paperclipai/server",
        ...serializedServerVitestArgs,
        ...excludeRouteArgs,
      ],
      `${groupName} server suites excluding ${routeTests.length} serialized suites`,
    );
    return;
  }

  if (groupName === generalWorkspacesAGroupName) {
    // The ui project dominates this lane (~224s of a 319s job in actions run
    // 31371439296, 2026-08-10, where workspaces-a was the slowest PR check).
    // Its test files shard cleanly with Vitest's native --shard, so the lane
    // splits across runners without a duration manifest. Pass --maxWorkers at
    // the top level so both projects share one worker pool (Vitest 5 rejects
    // per-project maxWorkers mismatches within the same sequence.groupOrder).
    await runProjectGroup(generalWorkspacesAProjects, groupName, shardIndex, shardCount, [], [
      `--maxWorkers=${resolveWorkspaceParallelWorkers()}`,
    ]);
    return;
  }

  if (groupName === generalWorkspacesBGroupName) {
    const projects = selectWorkspaceProjectsShard(generalWorkspacesBProjects, shardIndex, shardCount);
    if (projects.length === 0) {
      console.log(`\n[test:run] ${groupName} shard ${shardIndex + 1}/${shardCount}: 0 projects; skipping`);
      return;
    }
    await runProjectGroup(projects, groupName);
    return;
  }

  if (groupName === generalWorkspacesCGroupName) {
    const dbNightlyExcludes = [...activeNightlyOnlySuites]
      .filter((file) => file.startsWith("packages/db/"))
      .map((file) => file.replace(/^packages\/db\//, ""));
    await runProjectGroup(generalWorkspacesCProjects, groupName, null, null, dbNightlyExcludes);
    return;
  }

  fail(`Unknown group "${groupName}".`);
}

async function runSerializedSuites(suites, shardIndex, shardCount) {
  const shardTests = selectSerializedSuites(suites, shardIndex, shardCount);
  console.log(
    `\n[test:run] serialized shard ${shardIndex + 1}/${shardCount} running ${shardTests.length} of ${suites.length} suites`,
  );

  if (shardTests.length === 0) {
    return;
  }

  if (hasSharedTestDatabase) {
    await runVitest(
      [
        "--project",
        "@paperclipai/server",
        ...shardTests.map((test) => test.repoPath),
        "--pool=forks",
        "--isolate",
        ...serializedServerVitestArgs,
      ],
      `serialized shard ${shardIndex + 1}/${shardCount}`,
    );
    return;
  }

  const parallelTests = shardTests.filter((test) => !strictlySerialServerTests.has(test.repoPath));
  const serialOnlyTests = shardTests.filter((test) => strictlySerialServerTests.has(test.repoPath));

  if (parallelTests.length > 0) {
    const workers = resolveWorkers("serialized");
    await runVitest(
      [
        "--project",
        "@paperclipai/server",
        ...parallelTests.map((test) => test.repoPath),
        "--pool=forks",
        "--isolate",
        "--fileParallelism",
        `--maxWorkers=${workers}`,
      ],
      `serialized shard ${shardIndex + 1}/${shardCount}`,
    );
  }

  if (serialOnlyTests.length > 0) {
    await runVitest(
      [
        "--project",
        "@paperclipai/server",
        ...serialOnlyTests.map((test) => test.repoPath),
        "--pool=forks",
        "--isolate",
        ...serializedServerVitestArgs,
      ],
      `serialized shard ${shardIndex + 1}/${shardCount} (strictly serial)`,
    );
  }
}

const allServerTestFiles = walk(serverTestsDir);
const chatSuites = allServerTestFiles
  .map((file) => toRepoPath(file))
  .filter((repoPath) => isChatChannelSuite(repoPath))
  .sort((a, b) => a.localeCompare(b));
const chatSuiteSet = new Set(chatSuites);

const routeTests = allServerTestFiles
  .filter((file) => isRouteOrAuthzTest(toRepoPath(file)))
  .map((file) => ({
    repoPath: toRepoPath(file),
    serverPath: toServerPath(file),
  }))
  .sort((a, b) => a.repoPath.localeCompare(b.repoPath));
const activeRouteTests = routeTests.filter((test) => !activeNightlyOnlySuites.has(test.repoPath));

// Every server test file that the general-server group is responsible for,
// i.e. the whole server project minus the route/authz suites that run in the
// dedicated serialized shards. The default server config keeps files serial;
// the sharded entry point overlaps isolated files per runner unless an
// explicit shared test database requires serial execution.
// Suites are partitioned by recorded duration (scripts/general-server-shard.mjs)
// rather than round-robin, so one slow suite cluster can't stretch a single shard.
const serializedRepoPaths = new Set(routeTests.map(test => test.repoPath));
const generalServerTestFiles = [
  ...walk(serverSrcDir).filter(file => file.endsWith(".test.ts")),
  ...walk(serverScriptsDir).filter(file => file.endsWith(".test.mjs")),
]
  .map((file) => toRepoPath(file))
  // Only exclude suites actually assigned to the serialized lane. A name
  // such as services/openrouter-models.test.ts is not a serialized route.
  .filter((repoPath) => !serializedRepoPaths.has(repoPath))
  .sort((a, b) => a.localeCompare(b));

const options = parseCliOptions(process.argv.slice(2));
const selectionProjects =
  options.mode === serializedModeName ||
  generalServerGroups.includes(options.group) ||
  options.group === generalChatGroupName
    ? ["@paperclipai/server"]
    : options.group === generalWorkspacesAGroupName ? generalWorkspacesAProjects
      : options.group === generalWorkspacesBGroupName ? generalWorkspacesBProjects
        : options.group === generalWorkspacesCGroupName ? generalWorkspacesCProjects : [];
const selection = process.env.PAPERCLIP_CI_TEST_SELECTION
  ? selectedShard(loadSelection(), options, selectionProjects) : null;
if (selection?.["@paperclipai/server"]) {
  const owned = new Set(
    options.mode === serializedModeName
      ? routeTests.map((test) => test.repoPath)
      : options.group === generalChatGroupName
        ? chatSuites
        : generalServerTestFiles.filter((file) => !baseExcludedServerSuites(options.group).includes(file)),
  );
  for (const file of selection["@paperclipai/server"]) {
    if (!owned.has(file)) fail(`Selected test belongs to another server lane: ${file}`);
  }
}
if (selection && activeNightlyOnlySuites.size > 0) {
  for (const [project, files] of Object.entries(selection)) {
    selection[project] = files.filter((file) => !activeNightlyOnlySuites.has(file));
  }
}
if (selection && options.dryRun) {
  writeFileSync(1, JSON.stringify({ selection }));
  process.exit(0);
}
const isolateDefaultChat = !selection && options.group === null && options.mode !== serializedModeName && !hasSharedTestDatabase && chatSuites.length > 0;

function dryRunExcludedNightlySuites() {
  if (activeNightlyOnlySuites.size === 0) {
    return [];
  }
  if (options.mode === serializedModeName) {
    return routeTests
      .map((test) => test.repoPath)
      .filter((file) => activeNightlyOnlySuites.has(file));
  }
  if (options.mode === generalModeName && options.group === generalServerNativeRunnerGroupName) {
    return nativeRunnerSuites.filter((file) => activeNightlyOnlySuites.has(file));
  }
  if (
    options.mode === generalModeName &&
    (options.group === generalServerWithoutChatGroupName ||
      options.group === generalServerWithoutChatOrNativeRunnerGroupName)
  ) {
    const baseExcluded = new Set(baseExcludedServerSuites(options.group));
    return generalServerTestFiles.filter(
      (file) => !baseExcluded.has(file) && activeNightlyOnlySuites.has(file),
    );
  }
  if (options.mode === generalModeName && options.group === generalWorkspacesCGroupName) {
    return [...activeNightlyOnlySuites].filter((file) => file.startsWith("packages/db/")).sort();
  }
  return [];
}

if (options.dryRun) {
  const serializedPool = options.mode === serializedModeName ? activeRouteTests : routeTests;
  const serializedSuites =
    options.mode === serializedModeName
      ? selectSerializedSuites(serializedPool, options.shardIndex, options.shardCount)
      : serializedPool;
  // The inventory exceeds pipe buffers; flush it before the immediate exit.
  writeFileSync(1,
    JSON.stringify(
      {
        mode: options.mode,
        shardIndex: options.shardIndex,
        shardCount: options.shardCount,
        group: options.group,
        availableGeneralGroups: allowedGeneralGroupNames,
        nightlyExclusionActive,
        excludedNightlySuites: dryRunExcludedNightlySuites(),
        serializedSuiteCount: serializedPool.length,
        selectedSerializedSuites: serializedSuites.map((routeTest) => routeTest.repoPath),
        generalServerSuiteCount: generalServerTestFiles.length,
        selectedGeneralServerSuites:
          isolateDefaultChat
            ? generalServerTestFiles.filter((file) => !chatSuiteSet.has(file))
            : options.mode === generalModeName && options.group === generalServerNativeRunnerGroupName
            ? selectNativeRunnerSuites(options.shardIndex, options.shardCount)
            : options.mode === generalModeName &&
                generalServerGroups.includes(options.group) &&
                options.shardCount !== null
              ? selectGeneralServerShard(
                  generalServerTestFiles.filter((file) => !excludedServerSuites(options.group).includes(file)),
                  options.shardIndex,
                  options.shardCount,
                  generalServerShardDurations,
                )
              : null,
        chatSuiteCount: chatSuites.length,
        selectedChatSuites:
          options.group === generalChatGroupName
            ? selectChatSuites(options.shardIndex, options.shardCount)
            : isolateDefaultChat
              ? chatSuites
              : null,
        workspaceProjects:
          options.group === generalWorkspacesAGroupName
            ? generalWorkspacesAProjects
            : options.group === generalWorkspacesBGroupName
              ? selectWorkspaceProjectsShard(generalWorkspacesBProjects, options.shardIndex, options.shardCount)
              : options.group === generalWorkspacesCGroupName
                ? generalWorkspacesCProjects
                : null,
        workspacesVitestShard:
          options.group === generalWorkspacesAGroupName &&
          options.shardCount !== null &&
          options.shardCount > 1
            ? `${options.shardIndex + 1}/${options.shardCount}`
            : null,
      },
      null,
      2,
    ),
  );
  process.exit(0);
}

try {
  if (shouldWrapWithSharedPostgres({
    repoRoot,
    dryRun: options.dryRun,
    hasSharedTestDatabase,
    usesPostgres: groupUsesPostgres(options, selection),
    hasScheduledSuites: hasScheduledSuitesForRun(options, selection),
  })) {
    await runUnderSharedPostgres({
      repoRoot,
      runnerScriptPath: fileURLToPath(import.meta.url),
    });
  } else if (selection) {
    for (const [project, files] of Object.entries(selection)) {
      if (files.length === 0) continue;
      const serverArgs = project !== "@paperclipai/server" ? []
        : hasSharedTestDatabase
          ? ["--pool=forks", "--isolate", ...serializedServerVitestArgs]
          : options.mode === serializedModeName
            ? ["--pool=forks", "--isolate", "--fileParallelism", `--maxWorkers=${resolveWorkers("serialized")}`]
            : ["--pool=forks", "--isolate", "--fileParallelism", `--maxWorkers=${resolveWorkers("general")}`];
      await runVitest(["--project", project, ...serverArgs, ...files],
        `selected ${project}: ${files.length} files`, true);
    }
  } else {
    if (options.mode === generalModeName || options.mode === allModeName) {
      if (options.group) {
        await runGeneralGroup(routeTests, options.group, options.shardIndex, options.shardCount);
      } else {
        await runGeneralSuites(routeTests, isolateDefaultChat);
      }
    }

    if (options.mode === serializedModeName || options.mode === allModeName) {
      await runSerializedSuites(activeRouteTests, options.shardIndex ?? 0, options.shardCount ?? 1);
    }
  }
} catch (error) {
  console.error(`[test:run] ${error.message}`);
  process.exitCode = 1;
}
