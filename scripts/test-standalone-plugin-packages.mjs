#!/usr/bin/env node

// Run the test suites of the plugin packages that pnpm-workspace.yaml keeps
// OUT of the workspace (see the "!packages/plugins/sandbox-providers/**"
// exclusion). Workspace members are covered by the root vitest projects list;
// these packages are not in it, so without this runner their suites never
// execute anywhere in CI.
//
// Each package is installed the same way `build-standalone-public-packages.mjs`
// installs it for release (`pnpm install --ignore-workspace`, then the in-repo
// @paperclipai/plugin-sdk linked in), so the suites run against the dependency
// tree the published package actually ships with.
//
// A suite that runs zero tests is treated as a failure, not a pass: a missing
// standalone install makes test files fail to import, which silently shrinks
// the reported test count. See collectSuiteProblems below.

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path, { dirname } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import {
  isWorkspacePackage,
  parseWorkspaceEntries,
} from "./build-standalone-public-packages.mjs";
import { linkSdkInto, readPluginsUnder } from "./link-plugin-dev-sdk.mjs";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");

// The workspace exclusion this runner compensates for is scoped to the
// sandbox-provider tree. Other excluded plugin packages (the orchestration
// smoke example) declare `workspace:*` dependencies, which cannot resolve
// under `--ignore-workspace`, so they are not standalone-installable.
const PROVIDERS_DIR = "packages/plugins/sandbox-providers";

// The runner drives vitest directly instead of `pnpm run test` so it can add
// the JSON reporter it needs to prove a suite really executed (pnpm defines its
// own --reporter flag, so forwarding one through `pnpm run` is ambiguous).
// Reading the config path out of the package's own test script keeps the two in
// step, and an unrecognised script fails loudly rather than going unrun.
export function parseVitestConfigPath(dir, testScript) {
  const match = /(^|&&\s*)vitest\s+run(\s+--config\s+(\S+))?\s*$/.exec(testScript.trim());

  if (!match) {
    throw new Error(
      `${dir} has a "test" script this runner cannot drive: ${testScript}\n` +
      "Expected `vitest run [--config <file>]`. Update scripts/test-standalone-plugin-packages.mjs " +
      "so the suite keeps running in CI.",
    );
  }

  return match[3] ?? null;
}

// Discover every package under the sandbox-provider tree. Discovery is by
// directory, not by a hand-maintained list, so a newly added provider is
// covered the day it lands instead of quietly opting out of CI.
export function discoverStandalonePluginPackages({
  repoRoot: root,
  workspaceText,
  providersDir = PROVIDERS_DIR,
}) {
  const workspaceEntries = parseWorkspaceEntries(workspaceText);
  const packages = [];
  const skipped = [];

  for (const packageDir of readPluginsUnder(path.join(root, providersDir)).sort()) {
    const dir = path.relative(root, packageDir).split(path.sep).join("/");

    // A provider that is (re-)added to the workspace is already covered by the
    // root vitest projects list, so running it here would only duplicate work.
    if (isWorkspacePackage(dir, workspaceEntries)) {
      skipped.push({ dir, reason: "pnpm workspace member (covered by the root test run)" });
      continue;
    }

    const manifest = JSON.parse(
      readFileSync(path.join(packageDir, "package.json"), "utf8"),
    );

    if (!manifest.scripts?.test) {
      throw new Error(
        `${dir} is excluded from the pnpm workspace but has no "test" script, so nothing would ` +
        "run it. Add a test script, or move the package back into the workspace.",
      );
    }

    packages.push({
      dir,
      name: manifest.name,
      vitestConfig: parseVitestConfigPath(dir, manifest.scripts.test),
    });
  }

  if (packages.length === 0) {
    throw new Error(
      `No standalone plugin packages found under ${providersDir}. If that tree moved, update ` +
      "this runner — an empty package list must never read as a passing test lane.",
    );
  }

  return { packages, skipped };
}

export function summarizeReport(report) {
  const files = Array.isArray(report?.testResults) ? report.testResults.length : 0;
  const tests = Number.isFinite(report?.numTotalTests) ? report.numTotalTests : 0;
  const failed = Number.isFinite(report?.numFailedTests) ? report.numFailedTests : 0;
  return { files, tests, failed };
}

// Turn one package's run into a list of human-readable problems. Empty list ==
// the suite genuinely passed. Kept pure so the zero-test guard itself is
// covered by scripts/__tests__/standalone-plugin-tests.test.mjs.
export function collectSuiteProblems({ exitCode, report }) {
  const problems = [];

  if (exitCode !== 0) {
    problems.push(`test script exited with code ${exitCode}`);
  }

  if (!report) {
    problems.push(
      "no vitest JSON report was written, so the run cannot be proven to have executed any test",
    );
    return problems;
  }

  const { files, tests } = summarizeReport(report);

  if (report.success !== true) {
    problems.push("vitest reported a failing run");
  }
  if (files === 0) {
    problems.push("vitest ran 0 test files");
  }
  if (tests === 0) {
    problems.push("vitest ran 0 tests (a zero-test run is a failure, not a pass)");
  }

  // A test file that fails to import is reported with no assertions at all.
  // Without this check a suite can silently shrink while still looking healthy.
  const emptyFiles = (report.testResults ?? [])
    .filter((result) => (result?.assertionResults?.length ?? 0) === 0)
    .map((result) => result?.name ?? "<unknown file>");

  if (emptyFiles.length > 0) {
    problems.push(
      `${emptyFiles.length} test file(s) produced no tests (import failure?): ${emptyFiles.join(", ")}`,
    );
  }

  return problems;
}

function reportPathFor(name) {
  const outputDir = path.join(os.tmpdir(), "paperclip-standalone-plugin-tests");
  mkdirSync(outputDir, { recursive: true });
  return path.join(outputDir, `${name.replace(/[^a-z0-9]+/gi, "-")}.json`);
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    stdio: "inherit",
    env: { ...process.env, CI: "true" },
  });

  if (result.error) throw result.error;
  return result.status ?? 1;
}

function testPackage(pkg) {
  const packageDir = path.join(repoRoot, pkg.dir);
  const nodeModulesDir = path.join(packageDir, "node_modules");
  const packageLockfilePath = path.join(packageDir, "pnpm-lock.yaml");
  const reportPath = reportPathFor(pkg.name);

  console.log(`\n=== ${pkg.name} (${pkg.dir}) ===`);

  if (existsSync(nodeModulesDir)) {
    rmSync(nodeModulesDir, { force: true, recursive: true });
  }
  rmSync(reportPath, { force: true });

  // Mirror the release-time standalone install. These packages intentionally
  // ship no committed lockfile (their .gitignore forbids one), so there is
  // usually nothing to freeze against.
  const installArgs = existsSync(packageLockfilePath)
    ? ["install", "--ignore-workspace", "--frozen-lockfile"]
    : ["install", "--ignore-workspace", "--no-lockfile"];

  const installExit = run("pnpm", installArgs, packageDir);
  if (installExit !== 0) {
    return { pkg, problems: [`standalone install exited with code ${installExit}`] };
  }

  // The fresh install wipes node_modules, so relink the in-repo plugin SDK the
  // suites import (published installs get it from the registry instead).
  linkSdkInto(packageDir);

  const exitCode = run(
    "pnpm",
    [
      "exec",
      "vitest",
      "run",
      ...(pkg.vitestConfig ? ["--config", pkg.vitestConfig] : []),
      "--reporter=default",
      "--reporter=json",
      `--outputFile.json=${reportPath}`,
    ],
    packageDir,
  );

  let report = null;
  if (existsSync(reportPath)) {
    try {
      report = JSON.parse(readFileSync(reportPath, "utf8"));
    } catch (error) {
      console.error(`  Could not parse the vitest JSON report: ${error.message}`);
    }
  }

  return { pkg, report, problems: collectSuiteProblems({ exitCode, report }) };
}

function main() {
  const { packages, skipped } = discoverStandalonePluginPackages({
    repoRoot,
    workspaceText: readFileSync(path.join(repoRoot, "pnpm-workspace.yaml"), "utf8"),
  });

  for (const entry of skipped) {
    console.log(`  i Skipping ${entry.dir}: ${entry.reason}`);
  }
  console.log(
    `Running ${packages.length} standalone plugin suite(s): ${packages.map((p) => p.name).join(", ")}`,
  );

  // Every suite imports @paperclipai/plugin-sdk, which resolves to the in-repo
  // build output. Build it once here so a stale dist cannot skew any suite.
  execFileSync(
    "pnpm",
    ["--filter", "@paperclipai/plugin-sdk", "ensure-build-deps"],
    { cwd: repoRoot, stdio: "inherit" },
  );

  const results = packages.map((pkg) => testPackage(pkg));

  console.log("\nStandalone plugin suites:");
  for (const { pkg, report, problems } of results) {
    const { files, tests, failed } = summarizeReport(report);
    console.log(
      `  ${problems.length === 0 ? "PASS" : "FAIL"}  ${pkg.name}: ` +
      `${tests} test(s) across ${files} file(s), ${failed} failed`,
    );
    for (const problem of problems) {
      console.log(`        - ${problem}`);
    }
  }

  const totalTests = results.reduce(
    (sum, { report }) => sum + summarizeReport(report).tests,
    0,
  );
  const failures = results.filter(({ problems }) => problems.length > 0);

  console.log(`\nTotal: ${totalTests} test(s) across ${results.length} package(s)`);

  if (failures.length > 0) {
    // Same stream as the summary above so the two cannot interleave in CI logs.
    console.log(
      `\n  x ${failures.length} standalone plugin suite(s) failed: ` +
      failures.map(({ pkg }) => pkg.name).join(", "),
    );
    process.exitCode = 1;
  }
}

const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  main();
}
