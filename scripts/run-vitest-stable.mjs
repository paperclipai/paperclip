#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadShardDurations, selectGeneralServerShard } from "./general-server-shard.mjs";
import {
  VitestInvocationSupervisor,
  acquireHostSlot,
  diagnoseStableInvocations,
  reapStaleStableInvocations,
  resolveTestTempParent,
} from "./vitest-supervisor.mjs";

const repoRoot = process.cwd();
const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
const generalServerShardDurations = loadShardDurations(
  path.join(scriptsDir, "general-server-shard-durations.json"),
);
const serverRoot = path.join(repoRoot, "server");
const serverSrcDir = path.join(repoRoot, "server", "src");
const serverTestsDir = path.join(repoRoot, "server", "src", "__tests__");
const nonServerProjects = [
  "@paperclipai/shared",
  "@paperclipai/skills-catalog",
  "@paperclipai/db",
  "@paperclipai/adapter-utils",
  "@paperclipai/adapter-claude-local",
  "@paperclipai/adapter-codex-local",
  "@paperclipai/adapter-openclaw-gateway",
  "@paperclipai/adapter-opencode-local",
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
  "server/src/__tests__/heartbeat-dependency-scheduling.test.ts",
  "server/src/__tests__/heartbeat-issue-liveness-escalation.test.ts",
  "server/src/__tests__/heartbeat-process-recovery.test.ts",
  "server/src/__tests__/invite-accept-existing-member.test.ts",
  "server/src/__tests__/invite-accept-gateway-defaults.test.ts",
  "server/src/__tests__/invite-accept-replay.test.ts",
  "server/src/__tests__/invite-expiry.test.ts",
  "server/src/__tests__/invite-join-manager.test.ts",
  "server/src/__tests__/invite-onboarding-text.test.ts",
  "server/src/__tests__/issues-checkout-wakeup.test.ts",
  "server/src/__tests__/issues-service.test.ts",
  "server/src/__tests__/opencode-local-adapter-environment.test.ts",
  "server/src/__tests__/project-routes-env.test.ts",
  "server/src/__tests__/redaction.test.ts",
  "server/src/__tests__/routines-e2e.test.ts",
]);
let executionOptions = null;
let activeSupervisor = null;
let requestedExitCode = null;
let fatalError = null;
const cancellation = new AbortController();
const serializedModeName = "serialized";
const generalModeName = "general";
const allModeName = "all";
const generalServerGroupName = "general-server";
const generalWorkspacesAGroupName = "general-workspaces-a";
const generalWorkspacesBGroupName = "general-workspaces-b";
const generalWorkspacesAProjects = ["@paperclipai/ui", "paperclipai"];
const generalWorkspacesBProjects = nonServerProjects.filter((project) => !generalWorkspacesAProjects.includes(project));
const generalGroupNames = [generalServerGroupName, generalWorkspacesAGroupName, generalWorkspacesBGroupName];
const serializedServerVitestArgs = [
  "--no-file-parallelism",
  "--maxWorkers=1",
];

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
  let diagnose = false;
  let reapStale = false;
  let retainFailed = process.env.PAPERCLIP_TEST_RETAIN_FAILED === "1";
  let retainedLimit = parsePositiveInteger(
    process.env.PAPERCLIP_TEST_RETAIN_LIMIT ?? "3",
    "PAPERCLIP_TEST_RETAIN_LIMIT",
  );

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

    if (arg === "--diagnose") {
      diagnose = true;
      continue;
    }

    if (arg === "--reap-stale") {
      diagnose = true;
      reapStale = true;
      continue;
    }

    if (arg === "--retain-failed") {
      retainFailed = true;
      continue;
    }

    if (arg === "--retained-limit") {
      retainedLimit = parsePositiveInteger(readOptionValue(argv, index, arg), arg);
      index += 1;
      continue;
    }

    if (arg.startsWith("--retained-limit=")) {
      retainedLimit = parsePositiveInteger(arg.slice("--retained-limit=".length), "--retained-limit");
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
    (mode === generalModeName && group === generalServerGroupName);
  if (!shardAllowed && shardIndex !== null) {
    fail(
      "--shard-index/--shard-count are only valid with --mode serialized or --mode general --group general-server.",
    );
  }

  if (group !== null && mode !== generalModeName) {
    fail("--group is only valid with --mode general.");
  }

  if (group !== null && !generalGroupNames.includes(group)) {
    fail(`Unknown group "${group}". Expected one of: ${generalGroupNames.join(", ")}.`);
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
      diagnose,
      reapStale,
      retainFailed,
      retainedLimit,
    };
  }

  return {
    mode,
    shardIndex,
    shardCount,
    group,
    dryRun,
    diagnose,
    reapStale,
    retainFailed,
    retainedLimit,
  };
}

function selectSerializedSuites(routeTests, shardIndex, shardCount) {
  return routeTests.filter((_, index) => index % shardCount === shardIndex);
}

async function runVitest(args, label) {
  if (cancellation.signal.aborted) {
    throw cancellation.signal.reason ?? new Error("Stable test run cancelled.");
  }
  console.log(`\n[test:run] ${label}`);
  const temp = await resolveTestTempParent();
  const supervisor = new VitestInvocationSupervisor({
    invocationId: randomUUID(),
    label,
    tempParent: temp.parent,
    tempSource: temp.source,
  });
  activeSupervisor = supervisor;
  let result = null;
  let runError = null;
  try {
    result = await supervisor.run("pnpm", ["exec", "vitest", "run", ...args], { cwd: repoRoot });
  } catch (error) {
    runError = error;
  } finally {
    const failed = Boolean(runError || requestedExitCode !== null || result?.code !== 0 || result?.signal);
    const retainReason = executionOptions.retainFailed && failed
      ? runError
        ? "runner_error"
        : result?.signal
          ? `child_signal_${result.signal}`
          : `child_exit_${result?.code ?? "unknown"}`
      : null;
    try {
      await supervisor.cleanup({ retainReason, retainedLimit: executionOptions.retainedLimit });
    } catch (cleanupError) {
      runError = cleanupError;
    }
    activeSupervisor = null;
  }
  if (runError) throw runError;
  if (fatalError) throw fatalError;
  if (requestedExitCode !== null) {
    const error = new Error(`Stable test run cancelled (exit ${requestedExitCode}).`);
    error.exitCode = requestedExitCode;
    throw error;
  }
  if (result.error) {
    throw new Error(`Failed to start Vitest: ${result.error.message}`);
  }
  if (result.code !== 0) {
    const error = new Error(`Vitest exited with status ${result.code ?? 1}${result.signal ? ` (${result.signal})` : ""}.`);
    error.exitCode = result.code ?? 1;
    throw error;
  }
}

async function runGeneralSuites(routeTests) {
  for (const groupName of generalGroupNames) {
    await runGeneralGroup(routeTests, groupName);
  }
}

async function runProjectGroup(projects, groupName) {
  for (const project of projects) {
    await runVitest(["--project", project], `${groupName} project ${project}`);
  }
}

async function runGeneralGroup(routeTests, groupName, shardIndex = null, shardCount = null) {
  if (groupName === generalServerGroupName) {
    if (shardCount !== null && shardCount > 1) {
      const shardFiles = selectGeneralServerShard(
        generalServerTestFiles,
        shardIndex,
        shardCount,
        generalServerShardDurations,
      );
      console.log(
        `\n[test:run] general-server shard ${shardIndex + 1}/${shardCount} running ${shardFiles.length} of ${generalServerTestFiles.length} suites`,
      );
      if (shardFiles.length === 0) {
        return;
      }

      await runVitest(
        [
          "--project",
          "@paperclipai/server",
          ...serializedServerVitestArgs,
          ...shardFiles,
        ],
        `${groupName} shard ${shardIndex + 1}/${shardCount}`,
      );
      return;
    }

    const excludeRouteArgs = routeTests.flatMap((file) => ["--exclude", file.serverPath]);
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
    await runProjectGroup(generalWorkspacesAProjects, groupName);
    return;
  }

  if (groupName === generalWorkspacesBGroupName) {
    await runProjectGroup(generalWorkspacesBProjects, groupName);
    return;
  }

  fail(`Unknown group "${groupName}".`);
}

async function runSerializedSuites(routeTests, shardIndex, shardCount) {
  const shardTests = selectSerializedSuites(routeTests, shardIndex, shardCount);
  console.log(
    `\n[test:run] serialized shard ${shardIndex + 1}/${shardCount} running ${shardTests.length} of ${routeTests.length} suites`,
  );

  for (const routeTest of shardTests) {
    await runVitest(
      [
        "--project",
        "@paperclipai/server",
        routeTest.repoPath,
        "--pool=forks",
        "--isolate",
      ],
      routeTest.repoPath,
    );
  }
}

const routeTests = walk(serverTestsDir)
  .filter((file) => isRouteOrAuthzTest(toRepoPath(file)))
  .map((file) => ({
    repoPath: toRepoPath(file),
    serverPath: toServerPath(file),
  }))
  .sort((a, b) => a.repoPath.localeCompare(b.repoPath));

// Every server test file that the general-server group is responsible for,
// i.e. the whole server project minus the route/authz suites that run in the
// dedicated serialized shards. Sharding this list across runners is what keeps
// the general-server lane from becoming the PR critical path: the server vitest
// config pins maxWorkers to 1, so the only way to parallelize is across jobs.
// Suites are partitioned by recorded duration (scripts/general-server-shard.mjs)
// rather than round-robin, so one slow suite cluster can't stretch a single shard.
const generalServerTestFiles = walk(serverSrcDir)
  .map((file) => toRepoPath(file))
  .filter((repoPath) => repoPath.endsWith(".test.ts"))
  .filter((repoPath) => !isRouteOrAuthzTest(repoPath))
  .sort((a, b) => a.localeCompare(b));

executionOptions = parseCliOptions(process.argv.slice(2));
if (executionOptions.dryRun) {
  const serializedSuites =
    executionOptions.mode === serializedModeName
      ? selectSerializedSuites(routeTests, executionOptions.shardIndex, executionOptions.shardCount)
      : routeTests;
  console.log(
    JSON.stringify(
      {
        mode: executionOptions.mode,
        shardIndex: executionOptions.shardIndex,
        shardCount: executionOptions.shardCount,
        group: executionOptions.group,
        availableGeneralGroups: generalGroupNames,
        serializedSuiteCount: routeTests.length,
        selectedSerializedSuites: serializedSuites.map((routeTest) => routeTest.repoPath),
        generalServerSuiteCount: generalServerTestFiles.length,
        selectedGeneralServerSuites:
          executionOptions.mode === generalModeName &&
          executionOptions.group === generalServerGroupName &&
          executionOptions.shardCount !== null
            ? selectGeneralServerShard(
                generalServerTestFiles,
                executionOptions.shardIndex,
                executionOptions.shardCount,
                generalServerShardDurations,
              )
            : null,
      },
      null,
      2,
    ),
  );
  process.exit(0);
}

if (executionOptions.diagnose) {
  console.log(
    JSON.stringify(
      executionOptions.reapStale
        ? await reapStaleStableInvocations()
        : await diagnoseStableInvocations(),
      null,
      2,
    ),
  );
  process.exit(0);
}

function requestCancellation(reason, exitCode, error = null) {
  requestedExitCode ??= exitCode;
  fatalError ??= error;
  if (!cancellation.signal.aborted) cancellation.abort(error ?? new Error(reason));
  activeSupervisor?.requestStop(reason);
}

const signalHandlers = new Map([
  ["SIGINT", () => requestCancellation("parent_SIGINT", 130)],
  ["SIGTERM", () => requestCancellation("parent_SIGTERM", 143)],
]);
for (const [signal, handler] of signalHandlers) process.once(signal, handler);
const uncaughtHandler = (error) => requestCancellation("uncaught_exception", 1, error);
const rejectionHandler = (reason) => requestCancellation(
  "unhandled_rejection",
  1,
  reason instanceof Error ? reason : new Error(String(reason)),
);
process.once("uncaughtException", uncaughtHandler);
process.once("unhandledRejection", rejectionHandler);

let hostSlot = null;
try {
  const stableRunId = randomUUID();
  hostSlot = await acquireHostSlot({ invocationId: stableRunId, signal: cancellation.signal });
  console.log(
    `[test:run] ${JSON.stringify({
      event: "vitest_stable_run_start",
      stableRunId,
      runnerPid: process.pid,
      hostSlot: hostSlot.index,
    })}`,
  );
  if (executionOptions.mode === generalModeName || executionOptions.mode === allModeName) {
    if (executionOptions.group) {
      await runGeneralGroup(
        routeTests,
        executionOptions.group,
        executionOptions.shardIndex,
        executionOptions.shardCount,
      );
    } else {
      await runGeneralSuites(routeTests);
    }
  }

  if (executionOptions.mode === serializedModeName || executionOptions.mode === allModeName) {
    await runSerializedSuites(
      routeTests,
      executionOptions.shardIndex ?? 0,
      executionOptions.shardCount ?? 1,
    );
  }
} catch (error) {
  console.error(`[test:run] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = error?.exitCode ?? requestedExitCode ?? 1;
} finally {
  if (activeSupervisor) {
    try {
      await activeSupervisor.cleanup();
    } catch (error) {
      console.error(`[test:run] ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    }
  }
  if (hostSlot) {
    try {
      await hostSlot.release();
    } catch (error) {
      console.error(`[test:run] Failed to release host slot: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    }
  }
  for (const [signal, handler] of signalHandlers) process.removeListener(signal, handler);
  process.removeListener("uncaughtException", uncaughtHandler);
  process.removeListener("unhandledRejection", rejectionHandler);
}
