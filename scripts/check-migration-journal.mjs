#!/usr/bin/env node
/**
 * Dependency-free migration journal-consistency guard (RBR-968 / RBR-927 AC3).
 *
 * Why this exists as plain `.mjs` rather than reusing
 * packages/db/src/migration-journal-consistency.ts directly: this runs in the
 * PR `policy` job, which deliberately has no `pnpm install` step, so it must
 * work with nothing but a bare Node runtime and the checked-out tree. Node's
 * type stripping cannot load the TS module because TS emits `.js` import
 * specifiers that resolve to files which only exist after a build.
 *
 * The TS module remains the source of truth for the runtime/bootstrap and
 * test-harness paths. `scripts/__tests__/check-migration-journal.test.mjs`
 * asserts the two implementations report the same verdict on the real tree, so
 * they cannot silently drift.
 *
 * Checks, against packages/db/src/migrations:
 *   1. file <-> journal bijection — every `.sql` has a `meta/_journal.json`
 *      entry and every entry has a `.sql`. Always a hard error, always naming
 *      the offending filename.
 *   2. `idx` uniqueness — hard error, except groups recorded in
 *      packages/db/src/migration-journal-idx-baseline.json, which are reported
 *      as warnings so the guard could be adopted without first rewriting
 *      shipped journal history.
 *   3. `idx` continuity — gaps are warnings.
 *
 * Usage:
 *   node scripts/check-migration-journal.mjs            # baseline honoured
 *   node scripts/check-migration-journal.mjs --strict   # every defect is an error
 */
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const migrationsDir = path.join(repoRoot, "packages", "db", "src", "migrations");
const journalPath = path.join(migrationsDir, "meta", "_journal.json");
const baselinePath = path.join(
  repoRoot,
  "packages",
  "db",
  "src",
  "migration-journal-idx-baseline.json",
);

const strict = process.argv.slice(2).includes("--strict");

function fail(message) {
  console.error(`[check:migration-journal] ${message}`);
  process.exit(1);
}

async function listMigrationFolderFiles() {
  const entries = await readdir(migrationsDir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".sql"))
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right));
}

/**
 * A malformed entry is a hard error rather than a skipped entry: silently
 * dropping it would make an orphaned file look legitimate.
 */
async function readJournalEntries() {
  const parsed = JSON.parse(await readFile(journalPath, "utf8"));
  const entries = Array.isArray(parsed.entries) ? parsed.entries : [];

  return entries.map((entry, index) => {
    if (typeof entry?.tag !== "string" || entry.tag.length === 0) {
      fail(`Migration journal entry ${index} is missing a tag`);
    }
    if (!Number.isInteger(entry?.idx)) {
      fail(
        `Migration journal entry ${index} (${entry.tag}) has a non-integer idx: ${JSON.stringify(entry?.idx)}`,
      );
    }
    return { idx: Number(entry.idx), tag: entry.tag };
  });
}

async function loadBaseline() {
  if (strict) return { duplicateIdx: [] };

  let raw;
  try {
    raw = await readFile(baselinePath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return { duplicateIdx: [] };
    throw error;
  }

  const parsed = JSON.parse(raw);
  const rawEntries = Array.isArray(parsed.duplicateIdx) ? parsed.duplicateIdx : [];

  return {
    duplicateIdx: rawEntries.map((entry, index) => {
      if (!Number.isInteger(entry?.idx)) {
        fail(`Baseline duplicateIdx entry ${index} has a non-integer idx`);
      }
      if (
        !Array.isArray(entry?.tags) ||
        entry.tags.length < 2 ||
        entry.tags.some((tag) => typeof tag !== "string" || tag.length === 0)
      ) {
        fail(
          `Baseline duplicateIdx entry ${index} (idx ${String(entry?.idx)}) must list at least two non-empty tags`,
        );
      }
      return {
        idx: Number(entry.idx),
        tags: entry.tags,
        reason: typeof entry.reason === "string" ? entry.reason : undefined,
      };
    }),
  };
}

function findDuplicateIdxGroups(entries) {
  const tagsByIdx = new Map();
  for (const entry of entries) {
    const existing = tagsByIdx.get(entry.idx);
    if (existing) existing.push(entry.tag);
    else tagsByIdx.set(entry.idx, [entry.tag]);
  }

  return [...tagsByIdx.entries()]
    .filter(([, tags]) => tags.length > 1)
    .map(([idx, tags]) => ({ idx, tags }))
    .sort((left, right) => left.idx - right.idx);
}

function findIdxGaps(entries) {
  if (entries.length === 0) return [];
  const present = new Set(entries.map((entry) => entry.idx));
  const lowest = Math.min(...present);
  const highest = Math.max(...present);

  const gaps = [];
  for (let idx = lowest; idx <= highest; idx += 1) {
    if (!present.has(idx)) gaps.push(idx);
  }
  return gaps;
}

function normalizeTags(tags) {
  return [...tags].sort((left, right) => left.localeCompare(right)).join("|");
}

const migrationFiles = await listMigrationFolderFiles();
const journalEntries = await readJournalEntries();
const journalFiles = journalEntries.map((entry) => `${entry.tag}.sql`);
const baseline = await loadBaseline();

const journalFileSet = new Set(journalFiles);
const migrationFileSet = new Set(migrationFiles);

const errors = [];
const warnings = [];

const orphaned = migrationFiles.filter((fileName) => !journalFileSet.has(fileName));
const missing = journalFiles.filter((fileName) => !migrationFileSet.has(fileName));

if (orphaned.length > 0) {
  errors.push(
    `Orphaned migration file(s) present in packages/db/src/migrations but absent from meta/_journal.json: ${orphaned.join(", ")}.\n` +
      "An orphaned file is never applied by drizzle's journal-driven migrator but is reported as permanently pending by folder-based checks, which breaks database bootstrap. Delete the file if it is a leftover duplicate, or add its journal entry if the migration is real.",
  );
}

if (missing.length > 0) {
  errors.push(
    `Journal entry/entries with no matching .sql file in packages/db/src/migrations: ${missing.join(", ")}.\n` +
      "Restore the missing file or remove the stale journal entry.",
  );
}

const duplicateIdxGroups = findDuplicateIdxGroups(journalEntries);
const baselineByIdx = new Map(baseline.duplicateIdx.map((entry) => [entry.idx, entry]));
const matchedBaselineIdx = new Set();

for (const group of duplicateIdxGroups) {
  const baselined = baselineByIdx.get(group.idx);
  const named = group.tags.map((tag) => `${tag}.sql`).join(", ");

  if (baselined && normalizeTags(baselined.tags) === normalizeTags(group.tags)) {
    matchedBaselineIdx.add(group.idx);
    // Reported, not silenced: a baselined defect stays visible by name on every
    // run. The baseline downgrades it from blocking to loud.
    warnings.push(
      `Duplicate journal idx ${group.idx} shared by: ${named} (known pre-existing defect, baselined in packages/db/src/migration-journal-idx-baseline.json${baselined.reason ? `: ${baselined.reason}` : ""}). Run with --strict to fail on it.`,
    );
    continue;
  }

  if (baselined) {
    matchedBaselineIdx.add(group.idx);
    errors.push(
      `Duplicate journal idx ${group.idx} is baselined for [${baselined.tags.join(", ")}] but the journal now has [${group.tags.join(", ")}]. Give each entry a unique idx, or update packages/db/src/migration-journal-idx-baseline.json only if the change is itself pre-existing history.`,
    );
    continue;
  }

  errors.push(
    `Duplicate journal idx ${group.idx} in meta/_journal.json, shared by: ${named}. Journal idx must be unique — a shared idx makes migration ordering ambiguous. Renumber the newer entry.`,
  );
}

for (const entry of baseline.duplicateIdx) {
  if (matchedBaselineIdx.has(entry.idx)) continue;
  errors.push(
    `Stale baseline entry: packages/db/src/migration-journal-idx-baseline.json excuses duplicate journal idx ${entry.idx} ([${entry.tags.join(", ")}]) but that idx is no longer duplicated. Remove the entry.`,
  );
}

const idxGaps = findIdxGaps(journalEntries);
if (idxGaps.length > 0) {
  warnings.push(
    `Gaps in journal idx sequence: ${idxGaps.join(", ")}. Gaps are tolerated (they usually mean a migration was dropped before merge) but they make "latest idx" an unreliable count of applied migrations.`,
  );
}

for (const warning of warnings) {
  console.warn(`[check:migration-journal] WARN ${warning}`);
}

if (errors.length > 0) {
  for (const error of errors) {
    console.error(`[check:migration-journal] ERROR ${error}`);
  }
  console.error(
    `[check:migration-journal] FAILED — ${errors.length} error(s) across ${migrationFiles.length} migration file(s) and ${journalFiles.length} journal entry/entries.`,
  );
  process.exit(1);
}

console.log(
  `[check:migration-journal] OK — ${migrationFiles.length} migration file(s) match ${journalFiles.length} journal entry/entries${
    warnings.length > 0 ? `, ${warnings.length} warning(s)` : ""
  }${strict ? " (strict)" : ""}.`,
);
