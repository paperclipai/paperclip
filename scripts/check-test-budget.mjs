#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRootDefault = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const NIGHTLY_MANIFEST_REL = "scripts/ci/nightly-only-suites.json";

const TEST_FILE_PATTERN = /^(?:packages\/db\/src|server\/src|ui\/src)\/.+\.test\.tsx?$|^tests\/e2e\/.+\.spec\.ts$/;
const SLEEP_CALL_PATTERN = /\b(?:setTimeout|delay|waitForTimeout)\s*\(([^)\n]*)\)/g;
const NUMERIC_LITERAL_PATTERN = /\b(\d[\d_]*)\b/g;
const HISTORICAL_MIGRATION_FILE_PATTERN = /^(?:packages\/db\/src|server\/src)\/.*migration\.test\.ts$/;
const HISTORICAL_MIGRATION_CONTENT_PATTERN = /\b0\d{3}_[a-z0-9_]+\.sql\b|--> statement-breakpoint/;
const GUIDANCE_FILE_PATTERN = /-guidance\.test\.ts$/;
const PROSE_READ_PATTERN = /\breadFile(?:Sync)?\s*\([^)\n]*(?:\.(?:md|tsx)\b|SKILL\.md|AGENTS\.md|README\.md)/;
const EMBEDDED_PG_PATTERN = /\b(?:startEmbeddedPostgresTestDatabase|createTestPostgres)\b/;

export const PROTECTED_INVARIANT_PATTERN =
  /(?:auth|authz|-access(?:\.|\/|$)|company-access|isolation|checkout|assignee|approval|(?:^|\/)budget-|budget-policy|budget-cancellation|budget-evaluation|budget-hold|activity-log|secret|csrf|redaction|guard|security|tenant|privacy|sentry|telemetry|otel|observability|injection|ssrf|oracle|cli-invocation-safety)/i;

const MAX_PR_SLEEP_MS = 1_000;
const TINY_DB_FILE_MAX_LOC = 80;

function parseNumericMs(raw) {
  const value = Number(raw.replaceAll("_", ""));
  return Number.isFinite(value) ? value : 0;
}

export function findUnbudgetedSleeps(source, { onlyLineNumbers = null } = {}) {
  const violations = [];
  const lines = source.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const lineNumber = index + 1;
    if (onlyLineNumbers && !onlyLineNumbers.has(lineNumber)) continue;
    const line = lines[index];
    if (line.includes("test-budget:allow-sleep")) continue;
    if (/^\s*\/\//.test(line)) continue;

    SLEEP_CALL_PATTERN.lastIndex = 0;
    let match;
    while ((match = SLEEP_CALL_PATTERN.exec(line)) !== null) {
      const args = match[1] ?? "";
      // For setTimeout(fn, ms), check the last numeric literal in the argument list;
      // for delay(ms) / waitForTimeout(ms), check the first numeric literal.
      const isSetTimeout = match[0].startsWith("setTimeout");
      const targetSlice = isSetTimeout ? args.split(",").slice(1).join(",") : args.split(",")[0] ?? "";
      NUMERIC_LITERAL_PATTERN.lastIndex = 0;
      let numMatch;
      while ((numMatch = NUMERIC_LITERAL_PATTERN.exec(targetSlice)) !== null) {
        const ms = parseNumericMs(numMatch[1]);
        if (ms > MAX_PR_SLEEP_MS) {
          violations.push({
            rule: "sleep-over-1s",
            line: lineNumber,
            message: `Unbudgeted real-clock sleep (${ms}ms > ${MAX_PR_SLEEP_MS}ms). Use fake timers/condition waits, move soak suite to ${NIGHTLY_MANIFEST_REL}, or annotate with // test-budget:allow-sleep: <reason>.`,
          });
        }
      }
    }
  }
  return violations;
}

export function validateNightlyManifest(root = repoRootDefault, manifestRel = NIGHTLY_MANIFEST_REL) {
  const fullPath = path.join(root, manifestRel);
  const violations = [];
  if (!existsSync(fullPath)) {
    return { paths: new Set(), violations: [{ file: manifestRel, rule: "nightly-manifest", message: "Missing nightly manifest." }] };
  }

  let parsed;
  try {
    parsed = JSON.parse(readFileSync(fullPath, "utf8"));
  } catch (error) {
    return {
      paths: new Set(),
      violations: [{ file: manifestRel, rule: "nightly-manifest", message: `Invalid JSON: ${error.message}` }],
    };
  }

  if (!Array.isArray(parsed?.suites)) {
    return {
      paths: new Set(),
      violations: [{ file: manifestRel, rule: "nightly-manifest", message: "Manifest must contain a suites array." }],
    };
  }

  const seen = new Set();
  for (const entry of parsed.suites) {
    const suitePath = typeof entry === "string" ? entry : entry?.path;
    if (typeof suitePath !== "string" || !suitePath.trim()) {
      violations.push({ file: manifestRel, rule: "nightly-manifest", message: "Suite entry is missing a non-empty string path." });
      continue;
    }
    if (suitePath.startsWith("/") || suitePath.includes("\\") || suitePath.split("/").includes("..")) {
      violations.push({ file: manifestRel, rule: "nightly-manifest", message: `Invalid non-repo-relative path: ${suitePath}` });
      continue;
    }
    if (seen.has(suitePath)) {
      violations.push({ file: manifestRel, rule: "nightly-manifest", message: `Duplicate suite path: ${suitePath}` });
      continue;
    }
    seen.add(suitePath);
    if (!existsSync(path.join(root, suitePath))) {
      violations.push({ file: manifestRel, rule: "nightly-manifest", message: `Nightly suite does not exist on disk: ${suitePath}` });
    }
    if (PROTECTED_INVARIANT_PATTERN.test(suitePath)) {
      violations.push({
        file: manifestRel,
        rule: "protected-invariant",
        message: `Core control-plane / security / privacy invariant suite must remain on PRs, not in ${manifestRel}: ${suitePath}`,
      });
    }
  }

  return { paths: seen, violations };
}

export function checkTestFileBudget(fileRel, source, { isNew = true, nightlyPaths = new Set(), addedLineNumbers = null } = {}) {
  if (!TEST_FILE_PATTERN.test(fileRel)) return [];
  const violations = [];
  const isNightly = nightlyPaths.has(fileRel);

  if (!isNightly) {
    for (const v of findUnbudgetedSleeps(source, { onlyLineNumbers: isNew ? null : addedLineNumbers })) {
      violations.push({ file: fileRel, ...v });
    }
  }

  if (isNew) {
    if (
      HISTORICAL_MIGRATION_FILE_PATTERN.test(fileRel) &&
      HISTORICAL_MIGRATION_CONTENT_PATTERN.test(source) &&
      !source.includes("test-budget:allow-migration-test")
    ) {
      violations.push({
        file: fileRel,
        rule: "historical-migration-test",
        message: "Do not add standalone historical SQL migration replay tests; extend core runner tests in packages/db/src/client.test.ts or migration-compatibility.test.ts.",
      });
    }

    if (
      GUIDANCE_FILE_PATTERN.test(fileRel) &&
      PROSE_READ_PATTERN.test(source) &&
      !source.includes("test-budget:allow-prose-check")
    ) {
      violations.push({
        file: fileRel,
        rule: "prose-guidance-grep",
        message: "Do not add brittle static prose-grep guidance tests over .md/.tsx files.",
      });
    }

    const lineCount = source.split(/\r?\n/).length;
    if (
      !isNightly &&
      lineCount <= TINY_DB_FILE_MAX_LOC &&
      EMBEDDED_PG_PATTERN.test(source) &&
      !source.includes("test-budget:allow-standalone-db")
    ) {
      violations.push({
        file: fileRel,
        rule: "tiny-standalone-db-test",
        message: `New embedded-Postgres test file is only ${lineCount} LOC (<= ${TINY_DB_FILE_MAX_LOC}). Extend the owning service/route suite instead, or annotate with // test-budget:allow-standalone-db: <reason>.`,
      });
    }
  }

  return violations;
}

function addedLinesFromDiff(root, baseRef, fileRel) {
  const diff = execFileSync("git", ["diff", "-U0", `${baseRef}...HEAD`, "--", fileRel], {
    cwd: root,
    encoding: "utf8",
  });
  const added = new Set();
  let currentLine = 0;
  for (const line of diff.split(/\r?\n/)) {
    const hunk = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/);
    if (hunk) {
      currentLine = Number(hunk[1]);
      continue;
    }
    if (line.startsWith("+") && !line.startsWith("+++")) {
      added.add(currentLine);
      currentLine += 1;
    } else if (!line.startsWith("-")) {
      currentLine += 1;
    }
  }
  return added;
}

function changedTestFilesFromBase(root, baseRef) {
  const out = execFileSync("git", ["diff", "--diff-filter=AM", "--name-status", `${baseRef}...HEAD`], {
    cwd: root,
    encoding: "utf8",
  });
  const entries = [];
  for (const raw of out.split(/\r?\n/)) {
    if (!raw.trim()) continue;
    const [status, fileRel] = raw.split("\t");
    if (!fileRel || !TEST_FILE_PATTERN.test(fileRel)) continue;
    entries.push({ fileRel, isNew: status === "A" });
  }
  return entries;
}

export function parseBudgetArgs(argv) {
  const options = { base: null, files: [], root: repoRootDefault, manifestOnly: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--base") {
      options.base = argv[++i] ?? null;
    } else if (arg.startsWith("--base=")) {
      options.base = arg.slice("--base=".length);
    } else if (arg === "--root") {
      options.root = path.resolve(argv[++i] ?? repoRootDefault);
    } else if (arg === "--manifest-only") {
      options.manifestOnly = true;
    } else if (arg === "--files") {
      while (i + 1 < argv.length && !argv[i + 1].startsWith("--")) {
        options.files.push(argv[++i]);
      }
    } else if (!arg.startsWith("--")) {
      options.files.push(arg);
    }
  }
  return options;
}

export function runTestBudgetCheck(options) {
  const root = options.root ?? repoRootDefault;
  const { paths: nightlyPaths, violations } = validateNightlyManifest(root);

  if (options.manifestOnly) {
    return { nightlyCount: nightlyPaths.size, checkedFiles: 0, violations };
  }

  let targets = [];
  if (options.files?.length) {
    targets = options.files.map((fileRel) => ({ fileRel, isNew: true, addedLineNumbers: null }));
  } else if (options.base) {
    targets = changedTestFilesFromBase(root, options.base).map((entry) => ({
      ...entry,
      addedLineNumbers: entry.isNew ? null : addedLinesFromDiff(root, options.base, entry.fileRel),
    }));
  }

  for (const target of targets) {
    const absPath = path.join(root, target.fileRel);
    if (!existsSync(absPath)) continue;
    const source = readFileSync(absPath, "utf8");
    violations.push(
      ...checkTestFileBudget(target.fileRel, source, {
        isNew: target.isNew,
        nightlyPaths,
        addedLineNumbers: target.addedLineNumbers,
      }),
    );
  }

  return { nightlyCount: nightlyPaths.size, checkedFiles: targets.length, violations };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const options = parseBudgetArgs(process.argv.slice(2));
  const result = runTestBudgetCheck(options);
  if (result.violations.length > 0) {
    console.error(`[check-test-budget] FAILED with ${result.violations.length} violation(s):`);
    for (const v of result.violations) {
      const loc = v.line ? `${v.file}:${v.line}` : v.file;
      console.error(`  - [${v.rule}] ${loc}: ${v.message}`);
    }
    process.exit(1);
  }
  console.log(
    `[check-test-budget] PASS (${result.nightlyCount} nightly suites validated, ${result.checkedFiles} test file(s) checked).`,
  );
}
