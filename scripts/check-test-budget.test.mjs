import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  checkTestFileBudget,
  findUnbudgetedSleeps,
  runTestBudgetCheck,
  validateNightlyManifest,
} from "./check-test-budget.mjs";

test("checked-in scripts/ci/nightly-only-suites.json passes full manifest & invariant validation", () => {
  const result = runTestBudgetCheck({ manifestOnly: true });
  assert.deepEqual(result.violations, []);
  assert.ok(result.nightlyCount > 0, "expected non-empty nightly-only-suites.json");
});

test("findUnbudgetedSleeps flags real-clock sleeps >1000ms and respects allow-sleep annotations", () => {
  const source = [
    "await delay(500);",
    "await delay(1000);",
    "await delay(1_500);",
    "await setTimeout(resolve, 2500);",
    "await page.waitForTimeout(3000);",
    "await delay(5000); // test-budget:allow-sleep: socket idle check",
    "// await delay(9000);",
  ].join("\n");

  const violations = findUnbudgetedSleeps(source);
  assert.deepEqual(
    violations.map((v) => ({ rule: v.rule, line: v.line })),
    [
      { rule: "sleep-over-1s", line: 3 },
      { rule: "sleep-over-1s", line: 4 },
      { rule: "sleep-over-1s", line: 5 },
    ],
  );
});

test("checkTestFileBudget enforces migration, prose-guidance, and tiny embedded-PG rules on new files", () => {
  const mig = checkTestFileBudget(
    "packages/db/src/old-backfill-migration.test.ts",
    'const sql = readFileSync("./migrations/0420_backfill.sql", "utf8");',
    { isNew: true },
  );
  assert.deepEqual(mig.map((v) => v.rule), ["historical-migration-test"]);

  const guidance = checkTestFileBudget(
    "server/src/__tests__/foo-guidance.test.ts",
    'const text = readFileSync("ui/src/App.tsx", "utf8"); expect(text).toContain("Settings");',
    { isNew: true },
  );
  assert.deepEqual(guidance.map((v) => v.rule), ["prose-guidance-grep"]);

  const tinyPg = checkTestFileBudget(
    "server/src/__tests__/tiny-one-off.test.ts",
    'import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";\nit("works", async () => {});',
    { isNew: true },
  );
  assert.deepEqual(tinyPg.map((v) => v.rule), ["tiny-standalone-db-test"]);

  const tinyPgAllowed = checkTestFileBudget(
    "server/src/__tests__/tiny-one-off.test.ts",
    '// test-budget:allow-standalone-db: needs isolated process env\nimport { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";',
    { isNew: true },
  );
  assert.deepEqual(tinyPgAllowed, []);

  // Nightly-registered suites are exempt from PR sleep & tiny-DB limits.
  const nightly = checkTestFileBudget(
    "server/src/__tests__/soak-example.test.ts",
    'import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";\nawait delay(5000);',
    { isNew: true, nightlyPaths: new Set(["server/src/__tests__/soak-example.test.ts"]) },
  );
  assert.deepEqual(nightly, []);
});

test("validateNightlyManifest rejects missing files, duplicates, and protected core invariant suites", () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "paperclip-test-budget-"));
  try {
    mkdirSync(path.join(tmp, "scripts/ci"), { recursive: true });
    mkdirSync(path.join(tmp, "server/src/__tests__"), { recursive: true });
    mkdirSync(path.join(tmp, "server/src/services/connectors"), { recursive: true });
    writeFileSync(path.join(tmp, "server/src/__tests__/authz-company-access.test.ts"), "// authz\n");
    writeFileSync(path.join(tmp, "server/src/services/connectors/slack-access.test.ts"), "// access\n");
    writeFileSync(path.join(tmp, "server/src/services/budget-resume-continuation.test.ts"), "// budget\n");
    writeFileSync(path.join(tmp, "server/src/__tests__/real-soak.test.ts"), "// soak\n");
    writeFileSync(
      path.join(tmp, "scripts/ci/nightly-only-suites.json"),
      JSON.stringify({
        suites: [
          { path: "server/src/__tests__/real-soak.test.ts" },
          { path: "server/src/__tests__/real-soak.test.ts" },
          { path: "server/src/__tests__/missing-suite.test.ts" },
          { path: "server/src/__tests__/authz-company-access.test.ts" },
          { path: "server/src/services/connectors/slack-access.test.ts" },
          { path: "server/src/services/budget-resume-continuation.test.ts" },
        ],
      }),
    );

    const { violations } = validateNightlyManifest(tmp);
    assert.deepEqual(
      violations.map((v) => v.rule),
      ["nightly-manifest", "nightly-manifest", "protected-invariant", "protected-invariant", "protected-invariant"],
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
