import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const root = fileURLToPath(new URL("../../", import.meta.url));

it.skipIf(process.env.PAPERCLIP_UNIT_BOUNDARY_PROBE === "1")("runs the documented pnpm validation with clean test processes after parent and shim injection", () => {
  const directory = realpathSync(mkdtempSync(path.join(tmpdir(), "runner unit boundary-")));
  try {
    const preload = path.join(directory, "preload.cjs");
    const foreignModules = path.join(directory, "foreign-modules");
    const log = path.join(directory, "preloads.ndjson");
    const report = path.join(directory, "vitest.json");
    writeFileSync(preload, `require("node:fs").appendFileSync(${JSON.stringify(log)}, JSON.stringify({
      argv: process.argv, execArgv: process.execArgv, nodePath: process.env.NODE_PATH
    }) + "\\n");`);
    const result = spawnSync("pnpm", ["test:e2e:runner:unit", "installed-cli.test.ts",
      "--maxWorkers=1", "--reporter=json", `--outputFile=${report}`], {
      cwd: root,
      encoding: "utf8",
      timeout: 90_000,
      env: { ...process.env, PAPERCLIP_UNIT_BOUNDARY_PROBE: "1",
        NODE_PATH: foreignModules, NODE_OPTIONS: `--require=${JSON.stringify(preload)}` },
    });
    expect(result.error, `${result.stdout}\n${result.stderr}`).toBeUndefined();
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    const tests = JSON.parse(readFileSync(report, "utf8"));
    expect(tests.numPassedTests).toBeGreaterThan(0);
    expect(tests.numFailedTests).toBe(0);
    expect(tests.testResults).toHaveLength(1);
    expect(tests.testResults[0].name).toMatch(/installed-cli\.test\.ts$/);
    expect(result.stdout).toContain("native completion prerequisite admits an executed passing boundary");
    const preloads = readFileSync(log, "utf8").trim().split("\n").map(line => JSON.parse(line));
    expect(preloads.some(record => record.argv.some(arg => /pnpm(?:\.c?js)?$/.test(arg)))).toBe(true);
    expect(preloads.some(record => record.argv[1]?.endsWith("/run-unit.mjs")
      && record.nodePath?.split(path.delimiter).includes(foreignModules))).toBe(true);
    expect(preloads.every(record => {
      const target = record.argv[1] ? path.relative(root, record.argv[1]) : "";
      return !/vitest|tinypool|\.test\.(?:ts|mjs)$/.test(target) && !record.execArgv.includes("--test");
    })).toBe(true);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 120_000);

it("reports a missing test runner as a launcher/environment failure before any product assertions", () => {
  const directory = realpathSync(mkdtempSync(path.join(tmpdir(), "runner-unit-uninstalled-")));
  try {
    const launcher = path.join(directory, "tests/runner-e2e/run-unit.mjs");
    mkdirSync(path.dirname(launcher), { recursive: true });
    copyFileSync(path.join(root, "tests/runner-e2e/run-unit.mjs"), launcher);
    const result = spawnSync(process.execPath, [launcher], { encoding: "utf8", timeout: 5000 });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("launcher/environment failure: Vitest is not installed");
    expect(result.stdout).toBe("");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

it("shards Vitest and node:test suites into a complete, non-overlapping cover", () => {
  const launcher = path.join(root, "tests/runner-e2e/run-unit.mjs");
  const dryRun = (args) => {
    const result = spawnSync(process.execPath, [launcher, ...args, "--dry-run"], {
      cwd: root,
      encoding: "utf8",
      timeout: 5000,
    });
    expect(result.status, result.stderr).toBe(0);
    return JSON.parse(result.stdout);
  };

  const unsharded = dryRun([]);
  expect(unsharded.vitestShard).toBeNull();
  expect(unsharded.nodeTestFiles.length).toBeGreaterThan(0);

  const shardCount = 4;
  const shards = Array.from({ length: shardCount }, (_, index) =>
    dryRun(["--shard-index", String(index), "--shard-count", String(shardCount)]),
  );
  expect(shards.map((s) => s.vitestShard)).toEqual(["--shard=1/4", "--shard=2/4", "--shard=3/4", "--shard=4/4"]);
  for (let i = 0; i < shardCount; i += 1) {
    expect(shards[i].vitestArgs).toContain(`--shard=${i + 1}/4`);
    expect(shards[i].vitestArgs).not.toContain("--shard-index");
    expect(shards[i].vitestArgs).not.toContain("--shard-count");
  }
  const combinedNodeTests = shards.flatMap((s) => s.nodeTestFiles);
  expect(new Set(combinedNodeTests).size).toBe(combinedNodeTests.length);
  expect([...combinedNodeTests].sort()).toEqual([...unsharded.nodeTestFiles].sort());

  // Supports `=` flag form and leading `--` separator used by `pnpm run`.
  const eqShard = dryRun(["--", "--shard-index=2", "--shard-count=4"]);
  expect(eqShard).toEqual(shards[2]);

  // Over-sharded trailing shards get an empty node:test list rather than duplicating files.
  const emptyNodeShard = dryRun(["--shard-index", "20", "--shard-count", "25"]);
  expect(emptyNodeShard.nodeTestFiles).toEqual([]);
  expect(emptyNodeShard.vitestShard).toBe("--shard=21/25");

  // Invalid or conflicting shard arguments fail fast with exit code 1.
  for (const badArgs of [
    ["--shard-index", "0"],
    ["--shard-count", "4"],
    ["--shard-index", "4", "--shard-count", "4"],
    ["--shard-index", "-1", "--shard-count", "4"],
    ["--shard-index", "0", "--shard-count", "0"],
    ["--shard-index", "0", "--shard-count", "4", "--shard=1/4"],
  ]) {
    const failed = spawnSync(process.execPath, [launcher, ...badArgs, "--dry-run"], {
      cwd: root,
      encoding: "utf8",
      timeout: 5000,
    });
    expect(failed.status, `expected failure for ${badArgs.join(" ")}`).toBe(1);
  }
});
