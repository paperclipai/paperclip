import assert from "node:assert/strict";
import { resolve } from "node:path";
import { test } from "node:test";

import {
  checkTrackedImports,
  checkTrackedScriptEntryPoints,
  defaultPackageRoot,
  listTrackedFiles,
} from "./lib/tracked-imports.mjs";

const fixtureRoot = "test-fixtures/untracked-import";

test("every tracked import in the package resolves to a tracked file", async () => {
  assert.deepEqual(await checkTrackedImports(), []);
});

test("a negative fixture proves that an untracked module is rejected", async () => {
  const consumer = resolve(defaultPackageRoot, fixtureRoot, "consumer.ts");
  const violations = await checkTrackedImports({
    scanRoots: [fixtureRoot],
    // `module.ts` is deliberately withheld from the tracked set: on disk but
    // absent from the commit is exactly the state a clean checkout cannot build.
    trackedFiles: [consumer],
  });

  assert.deepEqual(
    violations.map(({ specifier, reason }) => ({ specifier, reason })),
    [
      {
        specifier: "./module.js",
        reason: "resolves only to an untracked file, so a clean checkout cannot build it",
      },
      {
        specifier: "./absent.js",
        reason: "does not resolve to any tracked file",
      },
    ],
  );
  assert.ok(violations.every((violation) => violation.file === consumer));
});

test("every package.json script entry point is tracked", async () => {
  assert.deepEqual(await checkTrackedScriptEntryPoints(), []);
});

test("a negative case proves that an untracked script entry point is rejected", async () => {
  const violations = await checkTrackedScriptEntryPoints({
    // Withholding the check script itself reproduces the repository-root
    // `check-*.mjs` ignore rule that kept these entry points out of commits.
    trackedFiles: (await listTrackedFiles()).filter(
      (file) => !file.endsWith("/scripts/check-tracked-imports.mjs"),
    ),
  });

  assert.deepEqual(
    violations.map(({ specifier, reason }) => ({ specifier, reason })),
    [
      {
        specifier: "scripts/check-tracked-imports.mjs",
        reason:
          'the "check:tracked-imports" script runs a file that is not tracked, so a clean checkout cannot run it',
      },
    ],
  );
});

test("the fixture itself is tracked so the package-wide check stays green", async () => {
  const tracked = new Set(await listTrackedFiles());
  for (const name of ["consumer.ts", "module.ts"]) {
    assert.ok(tracked.has(resolve(defaultPackageRoot, fixtureRoot, name)), name);
  }
});
