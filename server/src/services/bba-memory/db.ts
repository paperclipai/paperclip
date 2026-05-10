/**
 * BBA Memory — DB connection, schema init, migrations, seeding.
 *
 * Uses Node's built-in SQLite (`node:sqlite`, stable in Node 24, available
 * in 22.5+ behind --experimental-sqlite). Synchronous, fast, zero native deps.
 * The DB file lives outside the repo at `~/.paperclip/bba-memory/bba-memory.db`
 * so it survives `git clean -fdx` and isn't accidentally committed.
 *
 * Call `initBbaMemory()` once at server startup. It is idempotent.
 */
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { logger } from "../../middleware/logger.js";
import { SEED_SELECTORS } from "./seeds.js";

const MEMORY_DIR = process.env.BBA_MEMORY_DIR ?? path.join(os.homedir(), ".paperclip", "bba-memory");
const DB_PATH = path.join(MEMORY_DIR, "bba-memory.db");
export const TRACES_DIR = path.join(MEMORY_DIR, "traces");
export const SCREENSHOTS_DIR = path.join(MEMORY_DIR, "screenshots");

// Resolve schema.sql relative to this file at runtime (works in both
// tsx-dev and compiled-dist modes).
function resolveSchemaPath(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.join(here, "schema.sql");
}

const CURRENT_SCHEMA_VERSION = 1;

let dbInstance: DatabaseSync | null = null;

export function getDb(): DatabaseSync {
  if (!dbInstance) {
    throw new Error(
      "BBA memory DB not initialised. Call initBbaMemory() at startup.",
    );
  }
  return dbInstance;
}

export function initBbaMemory(): DatabaseSync {
  if (dbInstance) return dbInstance;

  fs.mkdirSync(MEMORY_DIR, { recursive: true });
  fs.mkdirSync(TRACES_DIR, { recursive: true });
  fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });

  const db = new DatabaseSync(DB_PATH);
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA journal_mode = WAL");

  // Apply schema (idempotent — uses CREATE TABLE IF NOT EXISTS).
  const schemaSql = fs.readFileSync(resolveSchemaPath(), "utf8");
  db.exec(schemaSql);

  // Track schema version so future migrations can branch cleanly.
  const versionRow = db
    .prepare("SELECT MAX(version) AS v FROM schema_version")
    .get() as { v: number | null };
  const currentVersion = versionRow?.v ?? 0;

  if (currentVersion < CURRENT_SCHEMA_VERSION) {
    db.prepare(
      "INSERT INTO schema_version (version, applied_at) VALUES (?, ?)",
    ).run(CURRENT_SCHEMA_VERSION, new Date().toISOString());
    logger.info(
      { from: currentVersion, to: CURRENT_SCHEMA_VERSION },
      "bba-memory: schema initialised",
    );
  }

  seedSelectors(db);

  dbInstance = db;
  return db;
}

/**
 * Insert seed selectors. Idempotent — uses INSERT OR IGNORE on
 * UNIQUE(purpose, selector). Never overwrites runtime counters.
 */
function seedSelectors(db: DatabaseSync): void {
  const now = new Date().toISOString();
  const insert = db.prepare(`
    INSERT OR IGNORE INTO selectors_observed (
      purpose, selector, selector_label, priority,
      first_seen_at, last_seen_at, source, notes
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  let inserted = 0;
  db.exec("BEGIN");
  try {
    for (const seed of SEED_SELECTORS) {
      const result = insert.run(
        seed.purpose,
        seed.selector,
        seed.label,
        seed.priority,
        now,
        now,
        seed.source,
        seed.notes ?? null,
      );
      if ((result.changes ?? 0) > 0) inserted += 1;
    }
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }

  if (inserted > 0) {
    logger.info(
      { inserted, total: SEED_SELECTORS.length },
      "bba-memory: seed selectors planted",
    );
  }
}

export function closeBbaMemory(): void {
  if (dbInstance) {
    dbInstance.close();
    dbInstance = null;
  }
}

/**
 * Used by the daily prune job. Deletes runs (and cascade popups/failures)
 * older than `days`. Selector counters and training_sessions are preserved.
 */
export function pruneOldRuns(days = 30): { deletedRuns: number; deletedFiles: number } {
  const db = getDb();
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

  // Collect file paths first so we can delete them on disk.
  const oldRuns = db
    .prepare(
      `SELECT id, trace_zip_path, final_screenshot_path FROM runs WHERE started_at < ?`,
    )
    .all(cutoff) as Array<{
      id: number;
      trace_zip_path: string | null;
      final_screenshot_path: string | null;
    }>;

  const popupShots = db
    .prepare(
      `SELECT screenshot_path FROM popups_seen
       WHERE run_id IN (SELECT id FROM runs WHERE started_at < ?)`,
    )
    .all(cutoff) as Array<{ screenshot_path: string | null }>;

  const failureShots = db
    .prepare(
      `SELECT screenshot_path FROM failures
       WHERE run_id IN (SELECT id FROM runs WHERE started_at < ?)`,
    )
    .all(cutoff) as Array<{ screenshot_path: string | null }>;

  const filesToDelete = new Set<string>();
  for (const r of oldRuns) {
    if (r.trace_zip_path) filesToDelete.add(r.trace_zip_path);
    if (r.final_screenshot_path) filesToDelete.add(r.final_screenshot_path);
  }
  for (const p of popupShots) if (p.screenshot_path) filesToDelete.add(p.screenshot_path);
  for (const f of failureShots) if (f.screenshot_path) filesToDelete.add(f.screenshot_path);

  let deletedFiles = 0;
  for (const file of filesToDelete) {
    try {
      fs.unlinkSync(file);
      deletedFiles += 1;
    } catch {
      /* file may already be gone */
    }
  }

  // Cascade delete via FK (popups_seen, failures use ON DELETE CASCADE).
  const result = db.prepare(`DELETE FROM runs WHERE started_at < ?`).run(cutoff);
  const deletedRuns = Number(result.changes);

  // VACUUM occasionally to reclaim disk; cheap if nothing changed.
  if (deletedRuns > 0) {
    db.exec("VACUUM");
  }

  logger.info(
    { deletedRuns, deletedFiles, cutoff },
    "bba-memory: pruned old runs",
  );

  return { deletedRuns, deletedFiles };
}
