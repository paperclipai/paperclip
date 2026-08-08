#!/usr/bin/env node
/**
 * Journal-consistency guard (RBR-968 / RBR-927 AC3).
 *
 * Asserts, against packages/db/src/migrations:
 *   1. file <-> journal bijection — every `.sql` has a `meta/_journal.json`
 *      entry and every entry has a `.sql`. Violations are always hard errors
 *      naming the offending filename.
 *   2. `idx` uniqueness — no two journal entries share an `idx`. Hard error,
 *      except for the pre-existing groups recorded in
 *      migration-journal-idx-baseline.json, which are reported as warnings so
 *      they stay visible without blocking unrelated work.
 *   3. `idx` continuity — gaps are reported as warnings.
 *
 * Runs before any embedded-Postgres suite (scripts/run-vitest-stable.mjs
 * preflight) and as part of `check:migrations`, which already gates
 * build / typecheck / generate / migrate.
 *
 * Usage:
 *   tsx src/check-migration-journal.ts            # baseline honoured
 *   tsx src/check-migration-journal.ts --strict   # every defect is an error
 */
import { fileURLToPath } from "node:url";
import {
  auditMigrationJournal,
  EMPTY_MIGRATION_JOURNAL_IDX_BASELINE,
  loadMigrationJournalIdxBaseline,
} from "./migration-journal-consistency.js";

const migrationsDir = fileURLToPath(new URL("./migrations", import.meta.url));
const journalPath = fileURLToPath(new URL("./migrations/meta/_journal.json", import.meta.url));

const strict = process.argv.slice(2).includes("--strict");

const baseline = strict
  ? EMPTY_MIGRATION_JOURNAL_IDX_BASELINE
  : await loadMigrationJournalIdxBaseline();

const { errors, warnings, result } = await auditMigrationJournal({
  migrationsDir,
  journalPath,
  baseline,
  strict,
});

for (const warning of warnings) {
  console.warn(`[check:migration-journal] WARN ${warning}`);
}

if (errors.length > 0) {
  for (const error of errors) {
    console.error(`[check:migration-journal] ERROR ${error}`);
  }
  console.error(
    `[check:migration-journal] FAILED — ${errors.length} error(s) across ${result.migrationFiles.length} migration file(s) and ${result.journalFiles.length} journal entry/entries.`,
  );
  process.exit(1);
}

console.log(
  `[check:migration-journal] OK — ${result.migrationFiles.length} migration file(s) match ${result.journalFiles.length} journal entry/entries${
    warnings.length > 0 ? `, ${warnings.length} warning(s)` : ""
  }${strict ? " (strict)" : ""}.`,
);
