import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const MIGRATIONS_FOLDER = fileURLToPath(new URL("./migrations", import.meta.url));
const MIGRATIONS_JOURNAL_JSON = fileURLToPath(
  new URL("./migrations/meta/_journal.json", import.meta.url),
);
const IDX_BASELINE_JSON = fileURLToPath(
  new URL("./migration-journal-idx-baseline.json", import.meta.url),
);

/**
 * An orphaned migration file (a `.sql` in the migrations folder with no
 * `meta/_journal.json` entry) is invisible to drizzle's journal-driven
 * `migrate()` but *is* visible to any folder-enumerating check such as
 * `inspectMigrations`. The result is a database that is genuinely up to date
 * while bootstrap reports it as permanently pending, which surfaces as an
 * unfixable "Failed to bootstrap migrations" and — when it happens inside a
 * `beforeAll` — a whole suite reporting `skipped` instead of `failed`.
 *
 * This module is the single source of truth for the journal invariants so the
 * build gate (`check:migrations`), the standalone CI guard
 * (`scripts/check-migration-journal.mjs`) and the runtime bootstrap path all
 * describe the same defects the same way, always naming the offending file.
 *
 * Two enforcement levels, deliberately different:
 *
 * - `assertMigrationJournalConsistency` runs inside `applyPendingMigrations`,
 *   i.e. in every embedded-Postgres `beforeAll`. It enforces only the
 *   invariants that actually break bootstrap: the file/journal bijection and
 *   well-formed entries. It must never start failing on pre-existing shipped
 *   journal history, or it would brick production startup.
 * - `auditMigrationJournal` is the pre-test/pre-build gate. It additionally
 *   enforces `idx` uniqueness (with an explicit, ratcheting baseline for
 *   already-shipped defects) and reports `idx` gaps as warnings.
 */
export type MigrationJournalInconsistency =
  | { readonly kind: "orphaned-migration-file"; readonly fileName: string }
  | { readonly kind: "missing-migration-file"; readonly fileName: string };

/** A journal `idx` value claimed by more than one entry. */
export type DuplicateJournalIdxGroup = {
  readonly idx: number;
  /** Tags sharing this `idx`, in journal order. */
  readonly tags: readonly string[];
};

export type MigrationJournalEntry = {
  readonly idx: number;
  readonly tag: string;
};

export type MigrationJournalConsistencyResult = {
  readonly migrationFiles: readonly string[];
  readonly journalFiles: readonly string[];
  /**
   * File/journal bijection violations only. These are the bootstrap-breaking
   * defects; `idx` problems are reported separately because they do not stop
   * `migrate()` from running.
   */
  readonly inconsistencies: readonly MigrationJournalInconsistency[];
  /** Every `idx` shared by two or more journal entries. Not baseline-filtered. */
  readonly duplicateIdxGroups: readonly DuplicateJournalIdxGroup[];
  /** Missing `idx` values between the lowest and highest present `idx`. */
  readonly idxGaps: readonly number[];
};

type JournalFile = {
  entries?: Array<{ idx?: number; tag?: string; when?: number }>;
};

export type DuplicateIdxBaselineEntry = {
  readonly idx: number;
  readonly tags: readonly string[];
  readonly reason?: string;
};

export type MigrationJournalIdxBaseline = {
  readonly duplicateIdx: readonly DuplicateIdxBaselineEntry[];
};

export const EMPTY_MIGRATION_JOURNAL_IDX_BASELINE: MigrationJournalIdxBaseline = {
  duplicateIdx: [],
};

export async function listMigrationFolderFiles(
  migrationsDir: string = MIGRATIONS_FOLDER,
): Promise<string[]> {
  const entries = await readdir(migrationsDir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".sql"))
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right));
}

/**
 * Reads `meta/_journal.json` and validates entry shape. A malformed entry is a
 * hard error rather than a skipped entry: silently dropping it would make an
 * orphan look legitimate.
 */
export async function readJournalEntries(
  journalPath: string = MIGRATIONS_JOURNAL_JSON,
): Promise<MigrationJournalEntry[]> {
  const raw = await readFile(journalPath, "utf8");
  const parsed = JSON.parse(raw) as JournalFile;
  const entries = parsed.entries ?? [];

  return entries.map((entry, index) => {
    if (typeof entry?.tag !== "string" || entry.tag.length === 0) {
      throw new Error(`Migration journal entry ${index} is missing a tag`);
    }
    if (!Number.isInteger(entry?.idx)) {
      throw new Error(
        `Migration journal entry ${index} (${entry.tag}) has a non-integer idx: ${JSON.stringify(entry?.idx)}`,
      );
    }
    return { idx: Number(entry.idx), tag: entry.tag };
  });
}

export async function listJournalMigrationFileNames(
  journalPath: string = MIGRATIONS_JOURNAL_JSON,
): Promise<string[]> {
  const entries = await readJournalEntries(journalPath);
  return entries.map((entry) => `${entry.tag}.sql`);
}

export function findDuplicateJournalIdxGroups(
  entries: readonly MigrationJournalEntry[],
): DuplicateJournalIdxGroup[] {
  const tagsByIdx = new Map<number, string[]>();
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

export function findJournalIdxGaps(entries: readonly MigrationJournalEntry[]): number[] {
  if (entries.length === 0) return [];
  const present = new Set(entries.map((entry) => entry.idx));
  const lowest = Math.min(...present);
  const highest = Math.max(...present);

  const gaps: number[] = [];
  for (let idx = lowest; idx <= highest; idx += 1) {
    if (!present.has(idx)) gaps.push(idx);
  }
  return gaps;
}

/**
 * Compares the migrations folder against `meta/_journal.json` and reports every
 * file that exists on only one side, plus the `idx` health of the journal. Pure
 * inspection: it never throws for a defect, so callers can format their own
 * message and choose their own enforcement level.
 */
export async function checkMigrationJournalConsistency(options?: {
  readonly migrationsDir?: string;
  readonly journalPath?: string;
}): Promise<MigrationJournalConsistencyResult> {
  const migrationFiles = await listMigrationFolderFiles(options?.migrationsDir);
  const journalEntries = await readJournalEntries(options?.journalPath);
  const journalFiles = journalEntries.map((entry) => `${entry.tag}.sql`);

  const journalFileSet = new Set(journalFiles);
  const migrationFileSet = new Set(migrationFiles);

  const inconsistencies: MigrationJournalInconsistency[] = [];

  for (const fileName of migrationFiles) {
    if (!journalFileSet.has(fileName)) {
      inconsistencies.push({ kind: "orphaned-migration-file", fileName });
    }
  }

  for (const fileName of journalFiles) {
    if (!migrationFileSet.has(fileName)) {
      inconsistencies.push({ kind: "missing-migration-file", fileName });
    }
  }

  return {
    migrationFiles,
    journalFiles,
    inconsistencies,
    duplicateIdxGroups: findDuplicateJournalIdxGroups(journalEntries),
    idxGaps: findJournalIdxGaps(journalEntries),
  };
}

export function formatMigrationJournalInconsistencies(
  inconsistencies: readonly MigrationJournalInconsistency[],
): string {
  const orphaned = inconsistencies
    .filter((entry) => entry.kind === "orphaned-migration-file")
    .map((entry) => entry.fileName);
  const missing = inconsistencies
    .filter((entry) => entry.kind === "missing-migration-file")
    .map((entry) => entry.fileName);

  const lines: string[] = ["Migration folder and meta/_journal.json disagree."];

  if (orphaned.length > 0) {
    lines.push(
      `Orphaned migration file(s) present in packages/db/src/migrations but absent from meta/_journal.json: ${orphaned.join(", ")}.`,
      "An orphaned file is never applied by drizzle's journal-driven migrator but is reported as permanently pending by folder-based checks, which breaks database bootstrap. Delete the file if it is a leftover duplicate, or add its journal entry if the migration is real.",
    );
  }

  if (missing.length > 0) {
    lines.push(
      `Journal entry/entries with no matching .sql file in packages/db/src/migrations: ${missing.join(", ")}.`,
      "Restore the missing file or remove the stale journal entry.",
    );
  }

  return lines.join("\n");
}

/**
 * Hard-fails with the offending filename when the migrations folder and the
 * journal disagree. Called from migration bootstrap so an orphaned file can
 * never degrade into a silently skipped test suite.
 *
 * Intentionally limited to the bijection: `idx` uniqueness is enforced by
 * `auditMigrationJournal` in the build/CI gate instead, because a duplicate
 * `idx` does not stop `migrate()` and pre-existing shipped duplicates must not
 * brick production bootstrap.
 */
export async function assertMigrationJournalConsistency(options?: {
  readonly migrationsDir?: string;
  readonly journalPath?: string;
}): Promise<void> {
  const { inconsistencies } = await checkMigrationJournalConsistency(options);
  if (inconsistencies.length === 0) return;
  throw new Error(formatMigrationJournalInconsistencies(inconsistencies));
}

function normalizeTags(tags: readonly string[]): string {
  return [...tags].sort((left, right) => left.localeCompare(right)).join("|");
}

export function parseMigrationJournalIdxBaseline(raw: string): MigrationJournalIdxBaseline {
  const parsed = JSON.parse(raw) as { duplicateIdx?: unknown };
  const rawEntries = Array.isArray(parsed.duplicateIdx) ? parsed.duplicateIdx : [];

  const duplicateIdx = rawEntries.map((entry, index) => {
    const candidate = entry as { idx?: unknown; tags?: unknown; reason?: unknown };
    if (!Number.isInteger(candidate.idx)) {
      throw new Error(`Baseline duplicateIdx entry ${index} has a non-integer idx`);
    }
    if (
      !Array.isArray(candidate.tags) ||
      candidate.tags.length < 2 ||
      candidate.tags.some((tag) => typeof tag !== "string" || tag.length === 0)
    ) {
      throw new Error(
        `Baseline duplicateIdx entry ${index} (idx ${String(candidate.idx)}) must list at least two non-empty tags`,
      );
    }
    return {
      idx: Number(candidate.idx),
      tags: candidate.tags as string[],
      reason: typeof candidate.reason === "string" ? candidate.reason : undefined,
    };
  });

  return { duplicateIdx };
}

export async function loadMigrationJournalIdxBaseline(
  baselinePath: string = IDX_BASELINE_JSON,
): Promise<MigrationJournalIdxBaseline> {
  return parseMigrationJournalIdxBaseline(await readFile(baselinePath, "utf8"));
}

export type MigrationJournalAuditResult = {
  readonly errors: readonly string[];
  readonly warnings: readonly string[];
  readonly result: MigrationJournalConsistencyResult;
};

/**
 * Full pre-test/pre-build audit: bijection, `idx` uniqueness (minus the
 * explicit baseline) and `idx` continuity (warning).
 *
 * The baseline is a ratchet. A baselined duplicate group is excused only when
 * its `idx` *and* its exact tag set still match, so a third entry joining a
 * baselined group is a fresh error. A baseline entry that no longer matches the
 * journal is itself an error, so the file cannot rot into a blanket exemption.
 */
export async function auditMigrationJournal(options?: {
  readonly migrationsDir?: string;
  readonly journalPath?: string;
  readonly baseline?: MigrationJournalIdxBaseline;
  /** Ignore the baseline and report every duplicate. */
  readonly strict?: boolean;
}): Promise<MigrationJournalAuditResult> {
  const result = await checkMigrationJournalConsistency(options);
  const baseline = options?.strict
    ? EMPTY_MIGRATION_JOURNAL_IDX_BASELINE
    : (options?.baseline ?? EMPTY_MIGRATION_JOURNAL_IDX_BASELINE);

  const errors: string[] = [];
  const warnings: string[] = [];

  if (result.inconsistencies.length > 0) {
    errors.push(formatMigrationJournalInconsistencies(result.inconsistencies));
  }

  const baselineByIdx = new Map(baseline.duplicateIdx.map((entry) => [entry.idx, entry]));
  const matchedBaselineIdx = new Set<number>();

  for (const group of result.duplicateIdxGroups) {
    const baselined = baselineByIdx.get(group.idx);
    if (baselined && normalizeTags(baselined.tags) === normalizeTags(group.tags)) {
      matchedBaselineIdx.add(group.idx);
      // Reported, not silenced. A baselined defect stays visible by name on
      // every run — the baseline downgrades it from blocking to loud, so the
      // guard can be adopted without first rewriting shipped journal history.
      warnings.push(
        `Duplicate journal idx ${group.idx} shared by: ${group.tags.map((tag) => `${tag}.sql`).join(", ")} (known pre-existing defect, baselined in packages/db/src/migration-journal-idx-baseline.json${baselined.reason ? `: ${baselined.reason}` : ""}). Run with --strict to fail on it.`,
      );
      continue;
    }
    if (baselined) {
      matchedBaselineIdx.add(group.idx);
      errors.push(
        `Duplicate journal idx ${group.idx} is baselined for [${[...baselined.tags].join(", ")}] but the journal now has [${group.tags.join(", ")}]. Give each entry a unique idx, or update packages/db/src/migration-journal-idx-baseline.json only if the change is itself pre-existing history.`,
      );
      continue;
    }
    errors.push(
      `Duplicate journal idx ${group.idx} in meta/_journal.json, shared by: ${group.tags.map((tag) => `${tag}.sql`).join(", ")}. Journal idx must be unique — a shared idx makes migration ordering ambiguous. Renumber the newer entry.`,
    );
  }

  for (const entry of baseline.duplicateIdx) {
    if (matchedBaselineIdx.has(entry.idx)) continue;
    errors.push(
      `Stale baseline entry: packages/db/src/migration-journal-idx-baseline.json excuses duplicate journal idx ${entry.idx} ([${[...entry.tags].join(", ")}]) but that idx is no longer duplicated. Remove the entry.`,
    );
  }

  if (result.idxGaps.length > 0) {
    warnings.push(
      `Gaps in journal idx sequence: ${result.idxGaps.join(", ")}. Gaps are tolerated (they usually mean a migration was dropped before merge) but they make "latest idx" an unreliable count of applied migrations.`,
    );
  }

  return { errors, warnings, result };
}
