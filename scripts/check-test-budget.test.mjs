import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  checkTestFileBudget,
  findUnbudgetedSleeps,
  runTestBudgetCheck,
  validateNightlyManifest,
} from "./check-test-budget.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("checked-in scripts/ci/nightly-only-suites.json passes full manifest & invariant validation", () => {
  const result = runTestBudgetCheck({ manifestOnly: true });
  assert.deepEqual(result.violations, []);
  assert.ok(result.nightlyCount > 0, "expected non-empty nightly-only-suites.json");
});

test("findUnbudgetedSleeps flags real-clock sleeps >1000ms (including inline callbacks and products) and respects allow-sleep annotations", () => {
  const source = [
    "await delay(500);",
    "await delay(1000);",
    "await delay(1_500);",
    "await setTimeout(resolve, 2500);",
    "await new Promise((resolve) => setTimeout(() => resolve(), 2500));",
    "await new Promise((resolve) => setTimeout(() => { resolve(); }, 60 * 1000));",
    "await delay(2 * 1000);",
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
      { rule: "sleep-over-1s", line: 6 },
      { rule: "sleep-over-1s", line: 7 },
      { rule: "sleep-over-1s", line: 8 },
    ],
  );

  // Cancellable deadline timers and full fake-timer scopes must not produce false positives.
  assert.deepEqual(
    findUnbudgetedSleeps(
      "const timer = setTimeout(() => reject(new Error('timeout')), 60_000);\nclearTimeout(timer);",
    ),
    [],
  );
  assert.deepEqual(
    findUnbudgetedSleeps("vi.useFakeTimers();\nsetTimeout(() => done(), 10_000);"),
    [],
  );
  assert.deepEqual(
    findUnbudgetedSleeps(
      'beforeEach(() => { vi.useFakeTimers(); });\nafterEach(() => { vi.useRealTimers(); });\nit("faked", () => {\n  setTimeout(() => done(), 5000);\n});',
    ),
    [],
  );
  assert.deepEqual(
    findUnbudgetedSleeps(
      'vi.useFakeTimers({ toFake: ["Date", "setTimeout"] });\nsetTimeout(() => done(), 2500);',
    ),
    [],
  );

  // Partial fake timers (e.g. Date-only) and real-clock tests in mixed-clock files MUST still be flagged.
  assert.deepEqual(
    findUnbudgetedSleeps(
      'vi.useFakeTimers({ toFake: ["Date"] });\nawait new Promise((resolve) => setTimeout(resolve, 2500));',
    ).map((v) => ({ rule: v.rule, line: v.line })),
    [{ rule: "sleep-over-1s", line: 2 }],
  );
  assert.deepEqual(
    findUnbudgetedSleeps(
      'vi.useFakeTimers({ doNotFake: ["setTimeout"] });\nawait new Promise((resolve) => setTimeout(resolve, 2500));',
    ).map((v) => ({ rule: v.rule, line: v.line })),
    [{ rule: "sleep-over-1s", line: 2 }],
  );
  assert.deepEqual(
    findUnbudgetedSleeps(
      [
        'it("faked", () => {',
        "  vi.useFakeTimers();",
        "  setTimeout(() => done(), 5000);",
        "});",
        'it("real", async () => {',
        "  await new Promise((resolve) => setTimeout(resolve, 2500));",
        "});",
      ].join("\n"),
    ).map((v) => ({ rule: v.rule, line: v.line })),
    [{ rule: "sleep-over-1s", line: 6 }],
  );
  assert.deepEqual(
    findUnbudgetedSleeps(
      [
        'it("restores", async () => {',
        "  vi.useFakeTimers();",
        "  setTimeout(() => done(), 5000);",
        "  vi.useRealTimers();",
        "  await new Promise((resolve) => setTimeout(resolve, 2500));",
        "});",
      ].join("\n"),
    ).map((v) => ({ rule: v.rule, line: v.line })),
    [{ rule: "sleep-over-1s", line: 5 }],
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

  const nestedGuidance = checkTestFileBudget(
    "server/src/__tests__/bar-guidance.test.ts",
    'const text = readFileSync(path.join(dir, "README.md"), "utf8"); expect(text).toContain("Usage");',
    { isNew: true },
  );
  assert.deepEqual(nestedGuidance.map((v) => v.rule), ["prose-guidance-grep"]);

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
    writeFileSync(path.join(tmp, "server/src/__tests__/webhook-ingress.test.ts"), "// webhook\n");
    writeFileSync(path.join(tmp, "server/src/__tests__/storage-s3-credential-rotation.test.ts"), "// cred\n");
    writeFileSync(path.join(tmp, "server/src/__tests__/connection-management.integration.test.ts"), "// isolation\n");
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
          { path: "server/src/__tests__/webhook-ingress.test.ts" },
          { path: "server/src/__tests__/storage-s3-credential-rotation.test.ts" },
          { path: "server/src/__tests__/connection-management.integration.test.ts" },
        ],
      }),
    );

    const { violations } = validateNightlyManifest(tmp);
    assert.deepEqual(
      violations.map((v) => v.rule),
      [
        "nightly-manifest",
        "nightly-manifest",
        "protected-invariant",
        "protected-invariant",
        "protected-invariant",
        "protected-invariant",
        "protected-invariant",
        "protected-invariant",
      ],
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("pr-trusted.yml invokes check-test-budget.mjs with --base on pull requests", () => {
  const workflow = readFileSync(path.join(repoRoot, ".github/workflows/pr-trusted.yml"), "utf8");
  assert.match(workflow, /node \.\/scripts\/check-test-budget\.mjs --base "\$base_sha"/);
});


test("large moved-suite diffs retain added-line sleep enforcement", () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "test-budget-large-diff-"));
  const git = (...args) => execFileSync("git", args, { cwd: tmp, encoding: "utf8" });
  try {
    git("init", "-q");
    git("config", "user.email", "fixture@example.invalid");
    git("config", "user.name", "Test fixture");
    mkdirSync(path.join(tmp, "scripts/ci"), { recursive: true });
    writeFileSync(path.join(tmp, "scripts/ci/nightly-only-suites.json"), JSON.stringify({ version: 1, suites: [] }));
    mkdirSync(path.join(tmp, "server/src"), { recursive: true });
    const testFile = path.join(tmp, "server/src/moved.test.ts");
    // Removing old statements, as with a retained-suite move, exceeds Node's
    // default 1 MiB child-process buffer without making a huge final test.
    writeFileSync(testFile, "// previous suite statement " + "x".repeat(80) + "\n" +
      ("// moved old statement " + "x".repeat(80) + "\n").repeat(20_000));
    git("add", "."); git("commit", "-qm", "before move");
    const base = git("rev-parse", "HEAD").trim();
    writeFileSync(testFile, "await delay(2500);\n");
    git("add", "."); git("commit", "-qm", "move with violation");
    const failed = runTestBudgetCheck({ root: tmp, base });
    assert.equal(failed.checkedFiles, 1);
    assert.deepEqual(failed.violations
      .map(v => ({ file: v.file, line: v.line })), [{ file: "server/src/moved.test.ts", line: 1 }]);
    writeFileSync(testFile, "await delay(500);\n");
    git("add", "."); git("commit", "-qm", "move with permitted wait");
    const passed = runTestBudgetCheck({ root: tmp, base });
    assert.throws(() => runTestBudgetCheck({ root: tmp, base: "missing-base-ref" }));
    assert.equal(passed.checkedFiles, 1);
    assert.deepEqual(passed.violations, []);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
