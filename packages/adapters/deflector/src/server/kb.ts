import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import type { Database as BetterSqliteDatabase } from "better-sqlite3";
import { SEED_PATTERNS, type PatternRule, type ConfidenceTier } from "./match.js";

// better-sqlite3 is CJS/native; load via createRequire so this package stays ESM
// and works on Node 20 (node:sqlite is Node 22.5+ only / experimental).
const require = createRequire(import.meta.url);

export type KbDatabase = BetterSqliteDatabase;

function rowToPattern(row: Record<string, unknown>): PatternRule {
  return {
    id: String(row.id),
    name: String(row.name ?? row.id),
    titleRegex: String(row.title_regex ?? ""),
    originKind: row.origin_kind == null ? null : String(row.origin_kind),
    requireOriginTerminal: Number(row.require_origin_terminal ?? 0) === 1,
    resolutionStatus: (String(row.resolution_status ?? "done") === "cancelled"
      ? "cancelled"
      : "done") as "done" | "cancelled",
    commentTemplate: String(row.comment_template ?? ""),
    companyScope: String(row.company_scope ?? "all"),
    confidence: (String(row.confidence ?? "high") as ConfidenceTier) || "high",
    sourceCluster: String(row.source_cluster ?? ""),
    enabled: Number(row.enabled ?? 1) === 1,
  };
}

export function openKb(kbPath: string): KbDatabase {
  mkdirSync(dirname(kbPath), { recursive: true });
  const Database = require("better-sqlite3") as typeof import("better-sqlite3");
  const db = new Database(kbPath);
  db.exec(`
    CREATE TABLE IF NOT EXISTS patterns (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      title_regex TEXT NOT NULL,
      origin_kind TEXT,
      require_origin_terminal INTEGER NOT NULL DEFAULT 0,
      resolution_status TEXT NOT NULL DEFAULT 'done',
      comment_template TEXT NOT NULL,
      company_scope TEXT NOT NULL DEFAULT 'all',
      confidence TEXT NOT NULL DEFAULT 'high',
      source_cluster TEXT NOT NULL DEFAULT '',
      enabled INTEGER NOT NULL DEFAULT 1
    );
    CREATE INDEX IF NOT EXISTS idx_patterns_enabled ON patterns(enabled);
  `);
  return db;
}

export function seedKbIfEmpty(db: KbDatabase, patterns: PatternRule[] = SEED_PATTERNS): number {
  const count = db.prepare("SELECT COUNT(*) AS c FROM patterns").get() as { c: number };
  if (Number(count.c) > 0) return 0;
  const insert = db.prepare(`
    INSERT INTO patterns (
      id, name, title_regex, origin_kind, require_origin_terminal,
      resolution_status, comment_template, company_scope, confidence, source_cluster, enabled
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  let n = 0;
  for (const p of patterns) {
    insert.run(
      p.id,
      p.name,
      p.titleRegex,
      p.originKind,
      p.requireOriginTerminal ? 1 : 0,
      p.resolutionStatus,
      p.commentTemplate,
      p.companyScope,
      p.confidence,
      p.sourceCluster,
      p.enabled ? 1 : 0,
    );
    n += 1;
  }
  return n;
}

export function loadPatterns(db: KbDatabase): PatternRule[] {
  const rows = db.prepare("SELECT * FROM patterns WHERE enabled = 1 ORDER BY id").all() as Record<
    string,
    unknown
  >[];
  return rows.map(rowToPattern);
}

export function upsertPatterns(db: KbDatabase, patterns: PatternRule[]): void {
  const upsert = db.prepare(`
    INSERT INTO patterns (
      id, name, title_regex, origin_kind, require_origin_terminal,
      resolution_status, comment_template, company_scope, confidence, source_cluster, enabled
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      title_regex = excluded.title_regex,
      origin_kind = excluded.origin_kind,
      require_origin_terminal = excluded.require_origin_terminal,
      resolution_status = excluded.resolution_status,
      comment_template = excluded.comment_template,
      company_scope = excluded.company_scope,
      confidence = excluded.confidence,
      source_cluster = excluded.source_cluster,
      enabled = excluded.enabled
  `);
  for (const p of patterns) {
    upsert.run(
      p.id,
      p.name,
      p.titleRegex,
      p.originKind,
      p.requireOriginTerminal ? 1 : 0,
      p.resolutionStatus,
      p.commentTemplate,
      p.companyScope,
      p.confidence,
      p.sourceCluster,
      p.enabled ? 1 : 0,
    );
  }
}
