import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  collectSuiteProblems,
  discoverStandalonePluginPackages,
  parseVitestConfigPath,
  summarizeReport,
} from "../test-standalone-plugin-packages.mjs";

const WORKSPACE_TEXT = [
  "packages:",
  "  - packages/*",
  "  - packages/plugins/*",
  '  - "!packages/plugins/sandbox-providers/**"',
].join("\n");

function makeRepo(packages) {
  const root = mkdtempSync(path.join(os.tmpdir(), "standalone-plugin-tests-"));
  for (const [dir, manifest] of Object.entries(packages)) {
    const packageDir = path.join(root, dir);
    mkdirSync(packageDir, { recursive: true });
    writeFileSync(path.join(packageDir, "package.json"), JSON.stringify(manifest));
  }
  return root;
}

function passingReport({ files = 2, testsPerFile = 3 } = {}) {
  const testResults = Array.from({ length: files }, (_, index) => ({
    name: `/repo/test/unit/file-${index}.test.ts`,
    assertionResults: Array.from({ length: testsPerFile }, () => ({ status: "passed" })),
  }));
  return {
    success: true,
    numTotalTests: files * testsPerFile,
    numFailedTests: 0,
    testResults,
  };
}

test("discovers every sandbox-provider package that the workspace excludes", () => {
  const root = makeRepo({
    "packages/plugins/sandbox-providers/kubernetes": {
      name: "@paperclipai/plugin-kubernetes",
      scripts: { test: "vitest run --config vitest.config.ts" },
    },
    "packages/plugins/sandbox-providers/modal": {
      name: "@paperclipai/plugin-modal",
      scripts: { test: "vitest run --config vitest.config.ts" },
    },
  });

  try {
    const { packages, skipped } = discoverStandalonePluginPackages({
      repoRoot: root,
      workspaceText: WORKSPACE_TEXT,
    });

    assert.deepEqual(
      packages.map((pkg) => pkg.name),
      ["@paperclipai/plugin-kubernetes", "@paperclipai/plugin-modal"],
    );
    assert.deepEqual(skipped, []);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("skips a provider that is back inside the workspace", () => {
  const root = makeRepo({
    "packages/plugins/sandbox-providers/kubernetes": {
      name: "@paperclipai/plugin-kubernetes",
      scripts: { test: "vitest run --config vitest.config.ts" },
    },
    "packages/plugins/sandbox-providers/modal": {
      name: "@paperclipai/plugin-modal",
      scripts: { test: "vitest run --config vitest.config.ts" },
    },
  });
  const workspaceText = [
    "packages:",
    "  - packages/plugins/sandbox-providers/*",
    '  - "!packages/plugins/sandbox-providers/kubernetes"',
  ].join("\n");

  try {
    const { packages, skipped } = discoverStandalonePluginPackages({
      repoRoot: root,
      workspaceText,
    });

    assert.deepEqual(
      packages.map((pkg) => pkg.name),
      ["@paperclipai/plugin-kubernetes"],
    );
    assert.deepEqual(
      skipped.map((entry) => entry.dir),
      ["packages/plugins/sandbox-providers/modal"],
    );
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("refuses to let an excluded package opt out of testing", () => {
  const root = makeRepo({
    "packages/plugins/sandbox-providers/kubernetes": {
      name: "@paperclipai/plugin-kubernetes",
      scripts: { build: "tsc" },
    },
  });

  try {
    assert.throws(
      () => discoverStandalonePluginPackages({ repoRoot: root, workspaceText: WORKSPACE_TEXT }),
      /has no "test" script/,
    );
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("an empty provider tree fails instead of reading as a pass", () => {
  const root = makeRepo({});

  try {
    assert.throws(
      () => discoverStandalonePluginPackages({ repoRoot: root, workspaceText: WORKSPACE_TEXT }),
      /must never read as a passing test lane/,
    );
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("reads the vitest config path out of a package test script", () => {
  assert.equal(
    parseVitestConfigPath("pkg", "vitest run --config vitest.config.ts"),
    "vitest.config.ts",
  );
  assert.equal(parseVitestConfigPath("pkg", "vitest run"), null);
  assert.equal(
    parseVitestConfigPath(
      "pkg",
      "pnpm -C ../../../.. --filter @paperclipai/plugin-sdk ensure-build-deps && vitest run --config vitest.config.ts",
    ),
    "vitest.config.ts",
  );
});

test("a test script this runner cannot drive fails instead of going unrun", () => {
  assert.throws(
    () => parseVitestConfigPath("pkg", "jest --ci"),
    /cannot drive/,
  );
});

test("a green run with real tests reports no problems", () => {
  assert.deepEqual(collectSuiteProblems({ exitCode: 0, report: passingReport() }), []);
});

test("a failing suite is a problem", () => {
  const report = passingReport();
  report.success = false;
  report.numFailedTests = 1;

  const problems = collectSuiteProblems({ exitCode: 1, report });

  assert.ok(problems.some((problem) => problem.includes("exited with code 1")));
  assert.ok(problems.some((problem) => problem.includes("failing run")));
});

test("a zero-test run fails even when vitest claims success", () => {
  const problems = collectSuiteProblems({
    exitCode: 0,
    report: { success: true, numTotalTests: 0, numFailedTests: 0, testResults: [] },
  });

  assert.ok(problems.some((problem) => problem.includes("0 test files")));
  assert.ok(problems.some((problem) => problem.includes("0 tests")));
});

test("a test file that collected nothing fails the suite", () => {
  const report = passingReport();
  report.testResults.push({
    name: "/repo/test/unit/plugin.test.ts",
    assertionResults: [],
  });

  const problems = collectSuiteProblems({ exitCode: 0, report });

  assert.ok(problems.some((problem) => problem.includes("produced no tests")));
  assert.ok(problems.some((problem) => problem.includes("plugin.test.ts")));
});

test("a missing JSON report fails the suite", () => {
  const problems = collectSuiteProblems({ exitCode: 0, report: null });

  assert.ok(problems.some((problem) => problem.includes("no vitest JSON report")));
});

test("summarizeReport tolerates a missing report", () => {
  assert.deepEqual(summarizeReport(null), { files: 0, tests: 0, failed: 0 });
  assert.deepEqual(summarizeReport(passingReport({ files: 3, testsPerFile: 4 })), {
    files: 3,
    tests: 12,
    failed: 0,
  });
});
