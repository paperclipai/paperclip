import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { selectionHash } from "../ci/test-selection-manifest.mjs";
import {
  defaultServerParallelWorkers,
  resolveServerParallelWorkers,
  resolveWorkspaceParallelWorkers,
} from "../ci/vitest-workers.mjs";
import { partitionWorkspaceProjects, selectWorkspaceProjectsShard } from "../ci/workspaces-b-shard.mjs";
import { discoverWorkspacePackagePaths, ensureAllWorkspaceLinksCurrent } from "../ensure-workspace-package-links.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const script = path.join(repoRoot, "scripts", "run-vitest-stable.mjs");
const nativeRunnerSuitePath = "server/src/services/native-runtime/plugin-runner-probe.test.ts";

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
    "PAPERCLIP_CI_TEST_SELECTION",
    "PAPERCLIP_CI_SELECTION_HASH",
  ]) {
    if (!(key in envOverrides)) {
      delete env[key];
    }
  }
  return env;
}

function dryRunJson(args, envOverrides = {}) {
  const result = spawnSync(process.execPath, [script, ...args, "--dry-run"], {
    cwd: repoRoot,
    encoding: "utf8",
    env: workflowEnv(envOverrides),
  });
  assert.equal(result.status, 0, `expected success for ${args.join(" ")}: ${result.stderr}`);
  return JSON.parse(result.stdout);
}

test("general-workspaces-b and general-workspaces-a batch all projects into one vitest invocation", { skip: process.platform === "win32" }, () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "batch-workspaces-"));
  const receipt = path.join(directory, "calls.ndjson");
  const fakePnpm = path.join(directory, "pnpm");
  writeFileSync(fakePnpm, `#!/usr/bin/env node\nrequire('node:fs').appendFileSync(${JSON.stringify(receipt)}, JSON.stringify(process.argv.slice(2)) + '\\n');\n`);
  chmodSync(fakePnpm, 0o755);
  try {
    const run = (args) => {
      rmSync(receipt, { force: true });
      const result = spawnSync(process.execPath, [script, ...args], {
        cwd: repoRoot,
        encoding: "utf8",
        env: workflowEnv({
          PATH: `${directory}${path.delimiter}${process.env.PATH}`,
          PAPERCLIP_CI_PROFILE: "false",
          PAPERCLIP_TEST_POSTGRES_SHARED: "0",
        }),
      });
      assert.equal(result.status, 0, result.stdout + result.stderr);
      return readFileSync(receipt, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    };

    const workspacesBProjects = dryRunJson(["--mode", "general", "--group", "general-workspaces-b"]).workspaceProjects;
    const bCalls = run(["--mode", "general", "--group", "general-workspaces-b"]);
    assert.equal(bCalls.length, 1, "general-workspaces-b must invoke vitest once for all projects");
    const bProjectsArg = bCalls[0].flatMap((arg, index) => (arg === "--project" ? [bCalls[0][index + 1]] : []));
    assert.deepEqual(bProjectsArg, workspacesBProjects);

    const workspacesAProjects = dryRunJson(["--mode", "general", "--group", "general-workspaces-a"]).workspaceProjects;
    const aCalls = run(["--mode", "general", "--group", "general-workspaces-a", "--shard-index", "1", "--shard-count", "2"]);
    assert.equal(aCalls.length, 1, "general-workspaces-a must invoke vitest once for all projects in the shard");
    const aProjectsArg = aCalls[0].flatMap((arg, index) => (arg === "--project" ? [aCalls[0][index + 1]] : []));
    assert.deepEqual(aProjectsArg, workspacesAProjects);
    assert.ok(aCalls[0].includes("--shard=2/2"));
    assert.ok(aCalls[0].some((arg) => /^--maxWorkers=\d+$/.test(arg)), `expected top-level --maxWorkers in ${aCalls[0].join(" ")}`);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("nightly-only suites manifest excludes listed suites only in PR mode and respects PAPERCLIP_CI_FULL=1", { skip: process.platform === "win32" }, () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "nightly-manifest-"));
  const manifestFile = path.join(directory, "nightly-only-suites.json");
  const fullGeneral = dryRunJson(["--mode", "general", "--group", "general-server-without-chat", "--shard-index", "0", "--shard-count", "1"], { GITHUB_WORKFLOW: "PR", PAPERCLIP_CI_FULL: "1" });
  const sampleGeneralSuite = fullGeneral.selectedGeneralServerSuites[0];
  const sampleKeptGeneralSuite = fullGeneral.selectedGeneralServerSuites[1];
  const fullSerialized = dryRunJson(["--mode", "serialized", "--shard-index", "0", "--shard-count", "1"]);
  const sampleSerializedSuite = fullSerialized.selectedSerializedSuites[0];
  const sampleNativeSuite = nativeRunnerSuitePath;
  const sampleDbSuite = "packages/db/src/client.test.ts";

  writeFileSync(manifestFile, JSON.stringify({
    $comment: "fixture manifest",
    suites: [
      { path: sampleGeneralSuite, category: "soak", reason: "fixture", measuredMs: 120000 },
      sampleSerializedSuite,
      { path: sampleNativeSuite, category: "restart-lease-soak", reason: "fixture", measuredMs: 200000 },
      { path: sampleDbSuite, category: "db-soak", reason: "fixture", measuredMs: 90000 },
    ],
  }, null, 2));

  try {
    const prEnv = { GITHUB_WORKFLOW: "PR", PAPERCLIP_CI_NIGHTLY_SUITES_FILE: manifestFile };
    const prGeneral = dryRunJson(["--mode", "general", "--group", "general-server-without-chat", "--shard-index", "0", "--shard-count", "1"], prEnv);
    assert.equal(prGeneral.nightlyExclusionActive, true);
    assert.ok(!prGeneral.selectedGeneralServerSuites.includes(sampleGeneralSuite));
    assert.deepEqual(prGeneral.excludedNightlySuites, [sampleGeneralSuite]);

    const prSerialized = dryRunJson(["--mode", "serialized", "--shard-index", "0", "--shard-count", "1"], prEnv);
    assert.ok(!prSerialized.selectedSerializedSuites.includes(sampleSerializedSuite));
    assert.equal(prSerialized.serializedSuiteCount, fullSerialized.serializedSuiteCount - 1);
    assert.deepEqual(prSerialized.excludedNightlySuites, [sampleSerializedSuite]);

    const prNative = dryRunJson(["--mode", "general", "--group", "general-server-native-runner"], prEnv);
    assert.ok(!prNative.selectedGeneralServerSuites.includes(sampleNativeSuite));
    assert.deepEqual(prNative.excludedNightlySuites, [sampleNativeSuite]);

    // PAPERCLIP_CI_FULL=1, Release, Cloud readiness, and local runs retain all suites.
    for (const fullEnv of [
      { ...prEnv, PAPERCLIP_CI_FULL: "1" },
      { GITHUB_WORKFLOW: "Release", PAPERCLIP_CI_NIGHTLY_SUITES_FILE: manifestFile },
      { GITHUB_WORKFLOW: "Cloud readiness", PAPERCLIP_CI_NIGHTLY_SUITES_FILE: manifestFile },
      { PAPERCLIP_CI_NIGHTLY_SUITES_FILE: manifestFile },
    ]) {
      const general = dryRunJson(["--mode", "general", "--group", "general-server-without-chat", "--shard-index", "0", "--shard-count", "1"], fullEnv);
      assert.equal(general.nightlyExclusionActive, false);
      assert.deepEqual(general.excludedNightlySuites, []);
      assert.ok(general.selectedGeneralServerSuites.includes(sampleGeneralSuite));
      const serialized = dryRunJson(["--mode", "serialized", "--shard-index", "0", "--shard-count", "1"], fullEnv);
      assert.ok(serialized.selectedSerializedSuites.includes(sampleSerializedSuite));
      const native = dryRunJson(["--mode", "general", "--group", "general-server-native-runner"], fullEnv);
      assert.ok(native.selectedGeneralServerSuites.includes(sampleNativeSuite));
    }

    // Empty-list guard: when every native-runner suite is excluded in PR mode, vitest must NOT run unfiltered.
    const allNative = dryRunJson(["--mode", "general", "--group", "general-server-native-runner"]).selectedGeneralServerSuites;
    const allNativeManifest = path.join(directory, "all-native-nightly.json");
    writeFileSync(allNativeManifest, JSON.stringify({ suites: allNative }));
    const receipt = path.join(directory, "empty-guard-calls.ndjson");
    const fakePnpm = path.join(directory, "pnpm");
    writeFileSync(fakePnpm, `#!/usr/bin/env node\nrequire('node:fs').appendFileSync(${JSON.stringify(receipt)}, JSON.stringify(process.argv.slice(2)) + '\\n');\n`);
    chmodSync(fakePnpm, 0o755);
    const emptyResult = spawnSync(process.execPath, [script, "--mode", "general", "--group", "general-server-native-runner"], {
      cwd: repoRoot,
      encoding: "utf8",
      env: workflowEnv({
        GITHUB_WORKFLOW: "PR",
        PAPERCLIP_CI_NIGHTLY_SUITES_FILE: allNativeManifest,
        PAPERCLIP_CI_PROFILE: "false",
        PAPERCLIP_TEST_POSTGRES_SHARED: "0",
        PATH: `${directory}${path.delimiter}${process.env.PATH}`,
      }),
    });
    assert.equal(emptyResult.status, 0, emptyResult.stdout + emptyResult.stderr);
    assert.equal(existsSync(receipt), false, "an empty filtered suite set must skip vitest instead of running unfiltered");

    // Selected runs in PR mode also filter nightly-only suites unless PAPERCLIP_CI_FULL=1.
    const selectionFile = path.join(directory, "selection-manifest.json");
    const head = spawnSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8" }).stdout.trim();
    const selManifest = {
      version: 1,
      head,
      lanes: {
        "general-server-without-chat": {
          shards: [{ "@paperclipai/server": [sampleGeneralSuite, sampleKeptGeneralSuite] }],
        },
      },
    };
    writeFileSync(selectionFile, JSON.stringify(selManifest));
    const selHash = selectionHash(selManifest);
    const prSelected = dryRunJson(
      ["--mode", "general", "--group", "general-server-without-chat", "--shard-index", "0", "--shard-count", "1"],
      { ...prEnv, PAPERCLIP_CI_TEST_SELECTION: selectionFile, PAPERCLIP_CI_SELECTION_HASH: selHash },
    );
    assert.deepEqual(prSelected.selection["@paperclipai/server"], [sampleKeptGeneralSuite], "selected PR run must drop nightly-only suite");

    const fullSelected = dryRunJson(
      ["--mode", "general", "--group", "general-server-without-chat", "--shard-index", "0", "--shard-count", "1"],
      { ...prEnv, PAPERCLIP_CI_FULL: "1", PAPERCLIP_CI_TEST_SELECTION: selectionFile, PAPERCLIP_CI_SELECTION_HASH: selHash },
    );
    assert.deepEqual(
      fullSelected.selection["@paperclipai/server"],
      [sampleGeneralSuite, sampleKeptGeneralSuite],
      "PAPERCLIP_CI_FULL=1 selected run must keep nightly-only suite",
    );

    // general-workspaces-c forwards packages/db nightly excludes to vitest --exclude.
    rmSync(receipt, { force: true });
    const dbResult = spawnSync(process.execPath, [script, "--mode", "general", "--group", "general-workspaces-c"], {
      cwd: repoRoot,
      encoding: "utf8",
      env: workflowEnv({
        ...prEnv,
        PAPERCLIP_CI_PROFILE: "false",
        PAPERCLIP_TEST_POSTGRES_SHARED: "0",
        PATH: `${directory}${path.delimiter}${process.env.PATH}`,
      }),
    });
    assert.equal(dbResult.status, 0, dbResult.stdout + dbResult.stderr);
    const dbCall = JSON.parse(readFileSync(receipt, "utf8").trim());
    assert.ok(dbCall.includes("--exclude") && dbCall.includes("src/client.test.ts"), `expected db nightly exclude in ${dbCall.join(" ")}`);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("shared Postgres wrapper skips non-Postgres workspace groups even when opted in", { skip: process.platform === "win32" }, () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "shared-pg-skip-"));
  const receipt = path.join(directory, "env.json");
  const fakePnpm = path.join(directory, "pnpm");
  writeFileSync(
    fakePnpm,
    `#!/usr/bin/env node\nrequire('node:fs').writeFileSync(${JSON.stringify(receipt)}, JSON.stringify({ admin: process.env.PAPERCLIP_TEST_POSTGRES_ADMIN_URL ?? null, template: process.env.PAPERCLIP_TEST_POSTGRES_TEMPLATE ?? null }));\n`,
  );
  chmodSync(fakePnpm, 0o755);
  try {
    for (const group of ["general-workspaces-a", "general-workspaces-b"]) {
      rmSync(receipt, { force: true });
      const result = spawnSync(process.execPath, [script, "--mode", "general", "--group", group], {
        cwd: repoRoot,
        encoding: "utf8",
        env: workflowEnv({
          PATH: `${directory}${path.delimiter}${process.env.PATH}`,
          PAPERCLIP_CI_PROFILE: "false",
          PAPERCLIP_TEST_POSTGRES_SHARED: "1",
        }),
      });
      assert.equal(result.status, 0, result.stdout + result.stderr);
      assert.deepEqual(JSON.parse(readFileSync(receipt, "utf8")), { admin: null, template: null }, `${group} must not boot shared Postgres`);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("dynamic server workers scale cleanly across 4-core and 8-core runners while honoring explicit overrides", { skip: process.platform === "win32" }, () => {
  assert.equal(defaultServerParallelWorkers("general", 1), 1);
  assert.equal(defaultServerParallelWorkers("general", 4), 4);
  assert.equal(defaultServerParallelWorkers("general", 8), 7);
  assert.equal(defaultServerParallelWorkers("general", 16), 8);

  assert.equal(defaultServerParallelWorkers("serialized", 1), 1);
  assert.equal(defaultServerParallelWorkers("serialized", 4), 3);
  assert.equal(defaultServerParallelWorkers("serialized", 8), 5);
  assert.equal(defaultServerParallelWorkers("serialized", 16), 6);

  assert.equal(resolveServerParallelWorkers("general", { PAPERCLIP_VITEST_CPU_COUNT: "8" }), 7);
  assert.equal(resolveServerParallelWorkers("serialized", { PAPERCLIP_VITEST_CPU_COUNT: "8" }), 5);
  assert.equal(resolveWorkspaceParallelWorkers({ PAPERCLIP_VITEST_CPU_COUNT: "4" }), 4);
  assert.equal(resolveWorkspaceParallelWorkers({ PAPERCLIP_VITEST_CPU_COUNT: "8" }), 7);
  assert.equal(resolveWorkspaceParallelWorkers({ PAPERCLIP_VITEST_CPU_COUNT: "8", PAPERCLIP_VITEST_MAX_WORKERS: "3" }), 3);
  assert.equal(
    resolveServerParallelWorkers("general", { PAPERCLIP_VITEST_CPU_COUNT: "8", PAPERCLIP_VITEST_MAX_WORKERS: "2" }),
    2,
  );
  assert.throws(() => resolveServerParallelWorkers("general", { PAPERCLIP_VITEST_MAX_WORKERS: "0" }));

  const directory = mkdtempSync(path.join(os.tmpdir(), "dynamic-workers-"));
  const receipt = path.join(directory, "args.json");
  const fakePnpm = path.join(directory, "pnpm");
  writeFileSync(fakePnpm, `#!/usr/bin/env node\nrequire('node:fs').writeFileSync(${JSON.stringify(receipt)}, JSON.stringify(process.argv.slice(2)));\n`);
  chmodSync(fakePnpm, 0o755);
  try {
    for (const [cpuCount, expectedGeneral, expectedSerialized] of [
      ["4", 4, 3],
      ["8", 7, 5],
    ]) {
      for (const [modeArgs, expectedWorkers] of [
        [["--mode", "general", "--group", "general-server-without-chat-or-native-runner", "--shard-index", "0", "--shard-count", "12"], expectedGeneral],
        [["--mode", "general", "--group", "general-server-native-runner"], expectedGeneral],
        [["--mode", "serialized", "--shard-index", "0", "--shard-count", "9"], expectedSerialized],
      ]) {
        const result = spawnSync(process.execPath, [script, ...modeArgs], {
          cwd: repoRoot,
          encoding: "utf8",
          env: workflowEnv({
            PATH: `${directory}${path.delimiter}${process.env.PATH}`,
            PAPERCLIP_CI_PROFILE: "false",
            PAPERCLIP_TEST_POSTGRES_SHARED: "0",
            PAPERCLIP_VITEST_CPU_COUNT: cpuCount,
          }),
        });
        assert.equal(result.status, 0, result.stdout + result.stderr);
        const args = JSON.parse(readFileSync(receipt, "utf8"));
        assert.ok(args.includes(`--maxWorkers=${expectedWorkers}`), `cpu=${cpuCount} expected --maxWorkers=${expectedWorkers} in ${args.join(" ")}`);
      }
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("general-workspaces-b 2-shard split partitions projects cleanly without Vitest --shard and balances adapter-utils", { skip: process.platform === "win32" }, () => {
  const unsharded = dryRunJson(["--mode", "general", "--group", "general-workspaces-b"]);
  const shard0 = dryRunJson(["--mode", "general", "--group", "general-workspaces-b", "--shard-index", "0", "--shard-count", "2"]);
  const shard1 = dryRunJson(["--mode", "general", "--group", "general-workspaces-b", "--shard-index", "1", "--shard-count", "2"]);

  assert.equal(shard0.workspacesVitestShard, null);
  assert.equal(shard1.workspacesVitestShard, null);
  assert.deepEqual(shard0.workspaceProjects, ["@paperclipai/adapter-utils"]);
  assert.ok(shard1.workspaceProjects.length === unsharded.workspaceProjects.length - 1);

  const combined = [...shard0.workspaceProjects, ...shard1.workspaceProjects].sort();
  assert.deepEqual(combined, [...unsharded.workspaceProjects].sort(), "2-shard partition must cover every project exactly once");

  // Unknown future projects get default weight and are still partitioned cleanly.
  const withFuture = partitionWorkspaceProjects([...unsharded.workspaceProjects, "@paperclipai/future-pkg"], 2);
  assert.ok(withFuture.flatMap((s) => s.projects).includes("@paperclipai/future-pkg"));
  assert.deepEqual(selectWorkspaceProjectsShard(unsharded.workspaceProjects, 0, 1), unsharded.workspaceProjects);

  const directory = mkdtempSync(path.join(os.tmpdir(), "workspaces-b-shards-"));
  const receipt = path.join(directory, "calls.ndjson");
  const fakePnpm = path.join(directory, "pnpm");
  writeFileSync(fakePnpm, `#!/usr/bin/env node\nrequire('node:fs').appendFileSync(${JSON.stringify(receipt)}, JSON.stringify(process.argv.slice(2)) + '\\n');\n`);
  chmodSync(fakePnpm, 0o755);
  try {
    const run = (args) => {
      rmSync(receipt, { force: true });
      const result = spawnSync(process.execPath, [script, ...args], {
        cwd: repoRoot,
        encoding: "utf8",
        env: workflowEnv({
          PATH: `${directory}${path.delimiter}${process.env.PATH}`,
          PAPERCLIP_CI_PROFILE: "false",
          PAPERCLIP_TEST_POSTGRES_SHARED: "0",
        }),
      });
      assert.equal(result.status, 0, result.stdout + result.stderr);
      return existsSync(receipt)
        ? readFileSync(receipt, "utf8").trim().split("\n").map((line) => JSON.parse(line))
        : [];
    };

    for (const [index, expectedProjects] of [
      ["0", shard0.workspaceProjects],
      ["1", shard1.workspaceProjects],
    ]) {
      const calls = run(["--mode", "general", "--group", "general-workspaces-b", "--shard-index", index, "--shard-count", "2"]);
      assert.equal(calls.length, 1, `workspaces-b shard ${index}/2 must invoke vitest once`);
      const projectsArg = calls[0].flatMap((arg, i) => (arg === "--project" ? [calls[0][i + 1]] : []));
      assert.deepEqual(projectsArg, expectedProjects);
      assert.ok(!calls[0].some((arg) => arg.startsWith("--shard=")), "project-partitioned shard must not pass --shard");
    }

    // Over-sharded empty bucket skips vitest rather than running unfiltered.
    const emptyCalls = run(["--mode", "general", "--group", "general-workspaces-b", "--shard-index", "20", "--shard-count", "25"]);
    assert.deepEqual(emptyCalls, []);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("ensure-workspace-package-links discovers workspace packages and repairs stale links without tsx", { skip: process.platform === "win32" }, async () => {
  const discovered = discoverWorkspacePackagePaths(repoRoot);
  for (const name of ["@paperclipai/server", "@paperclipai/ui", "@paperclipai/shared", "@paperclipai/db", "@paperclipai/plugin-sdk", "paperclipai"]) {
    assert.ok(discovered.has(name), `expected workspace package ${name}`);
  }

  const fixtureRoot = mkdtempSync(path.join(os.tmpdir(), "ws-links-fixture-"));
  const { mkdirSync, symlinkSync, realpathSync } = await import("node:fs");
  try {
    const sharedDir = path.join(fixtureRoot, "packages", "shared");
    const staleDir = path.join(fixtureRoot, "stale-target");
    const serverDir = path.join(fixtureRoot, "server");
    mkdirSync(path.join(sharedDir, "src"), { recursive: true });
    mkdirSync(staleDir, { recursive: true });
    mkdirSync(path.join(serverDir, "node_modules", "@paperclipai"), { recursive: true });
    writeFileSync(path.join(sharedDir, "package.json"), JSON.stringify({ name: "@paperclipai/shared" }));
    writeFileSync(path.join(serverDir, "package.json"), JSON.stringify({
      name: "@paperclipai/server",
      dependencies: { "@paperclipai/shared": "workspace:*" },
    }));
    symlinkSync(staleDir, path.join(serverDir, "node_modules", "@paperclipai", "shared"));

    await ensureAllWorkspaceLinksCurrent(fixtureRoot);
    assert.equal(
      realpathSync(path.join(serverDir, "node_modules", "@paperclipai", "shared")),
      realpathSync(sharedDir),
    );
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});
