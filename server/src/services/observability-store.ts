// ROCAA-25: Tier observability — host-local SQLite store for per-invocation tier
// telemetry. Lives at `~/.local/share/paperclip/observability.db` (overridable
// via PAPERCLIP_TIER_OBSERVABILITY_DB_PATH).
//
// Design notes:
//   * Uses Node 22 built-in `node:sqlite` (no new native dependency).
//   * All writes are best-effort: errors are logged and swallowed; the
//     heartbeat critical path is never blocked by an observability failure.
//   * Schema is small and migration-free for now. Sibling tier-ops state
//     (ROCAA-23 Tier 1 cost-ceiling counters) will land alongside in this
//     same file.
//
// The experimental-feature warning emitted by `node:sqlite` is suppressed
// once at module load. We only intercept the single SQLite warning so the
// rest of the process's warning channel is untouched.
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

import { logger } from "../middleware/logger.js";

const requireCjs = createRequire(import.meta.url);

const SQLITE_WARNING_NAME = "ExperimentalWarning";
const SQLITE_WARNING_MATCH = /SQLite is an experimental feature/i;

let warningSuppressed = false;
type EmitWarningArgs = Parameters<typeof process.emitWarning>;
function suppressSqliteExperimentalWarning(): void {
  if (warningSuppressed) return;
  warningSuppressed = true;
  const orig = process.emitWarning.bind(process);
  process.emitWarning = ((...args: EmitWarningArgs): void => {
    const [warning, arg2] = args;
    const message =
      typeof warning === "string" ? warning : warning instanceof Error ? warning.message : "";
    let name: string | undefined;
    if (typeof arg2 === "string") {
      name = arg2;
    } else if (arg2 && typeof arg2 === "object" && "type" in arg2) {
      const t = (arg2 as { type?: unknown }).type;
      if (typeof t === "string") name = t;
    }
    if (name === SQLITE_WARNING_NAME && SQLITE_WARNING_MATCH.test(message)) {
      return;
    }
    return orig(...args);
  }) as typeof process.emitWarning;
}

// `node:sqlite` is a built-in module in Node ≥22. We load it lazily so that
// any environment that somehow lacks it (Node <22, test runner with weird
// mocks, ...) degrades to a no-op store instead of crashing the server at
// import time.
type SqliteDatabase = {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  close(): void;
};
type SqliteStatement = {
  run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint };
  all<T = Record<string, unknown>>(...params: unknown[]): T[];
  get<T = Record<string, unknown>>(...params: unknown[]): T | undefined;
};

interface SqliteModule {
  DatabaseSync: new (path: string, options?: Record<string, unknown>) => SqliteDatabase;
}

function loadSqlite(): SqliteModule | null {
  suppressSqliteExperimentalWarning();
  try {
    return requireCjs("node:sqlite") as SqliteModule;
  } catch (err) {
    logger.warn(
      { error: err instanceof Error ? err.message : String(err) },
      "node:sqlite unavailable — tier observability will run in no-op mode",
    );
    return null;
  }
}

export interface AgentInvocationRecord {
  recordedAt: string; // ISO8601 UTC
  companyId: string;
  agentId: string;
  agentName?: string | null;
  issueId?: string | null;
  runId: string;
  adapterType: string;
  tierUsed?: number; // default 0
  tierTransitions?: Array<{ tier: number; errorReason?: string | null }>;
  costEstimateUsd?: number;
  latencyMs?: number | null;
  tokensUsed?: number | null;
  tokensIn?: number | null;
  tokensOut?: number | null;
  authSource?: string | null;
  rawMeta?: Record<string, unknown> | null;
}

export interface TierMixRow {
  tier: number;
  count: number;
}

export interface ObservabilityStore {
  readonly enabled: boolean;
  readonly dbPath: string | null;
  recordInvocation(record: AgentInvocationRecord): void;
  queryTierMix(sinceIso: string): TierMixRow[];
  queryTier1CostSince(sinceIso: string): number;
  close(): void;
}

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS agent_invocations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  recorded_at TEXT NOT NULL,
  company_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  agent_name TEXT,
  issue_id TEXT,
  run_id TEXT NOT NULL,
  adapter_type TEXT NOT NULL,
  tier_used INTEGER NOT NULL DEFAULT 0,
  tier_transitions TEXT NOT NULL DEFAULT '[]',
  cost_estimate_usd REAL NOT NULL DEFAULT 0,
  latency_ms INTEGER,
  tokens_used INTEGER,
  tokens_in INTEGER,
  tokens_out INTEGER,
  auth_source TEXT,
  raw_meta TEXT
);
CREATE INDEX IF NOT EXISTS idx_invocations_recorded_at
  ON agent_invocations(recorded_at);
CREATE INDEX IF NOT EXISTS idx_invocations_tier
  ON agent_invocations(tier_used, recorded_at);
CREATE INDEX IF NOT EXISTS idx_invocations_issue
  ON agent_invocations(issue_id);
CREATE TABLE IF NOT EXISTS schema_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

export function defaultObservabilityDbPath(): string {
  const override = process.env.PAPERCLIP_TIER_OBSERVABILITY_DB_PATH?.trim();
  if (override) {
    if (override === "~") return os.homedir();
    if (override.startsWith("~/")) return path.resolve(os.homedir(), override.slice(2));
    return path.resolve(override);
  }
  const xdgData = process.env.XDG_DATA_HOME?.trim();
  const base = xdgData
    ? path.resolve(xdgData)
    : path.resolve(os.homedir(), ".local", "share");
  return path.resolve(base, "paperclip", "observability.db");
}

function ensureDirectoryFor(filePath: string): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
}

function noopStore(reason: string, dbPath: string | null): ObservabilityStore {
  logger.warn({ reason, dbPath }, "tier observability store running in no-op mode");
  return {
    enabled: false,
    dbPath,
    recordInvocation: () => undefined,
    queryTierMix: () => [],
    queryTier1CostSince: () => 0,
    close: () => undefined,
  };
}

export interface OpenObservabilityStoreOptions {
  /** Override DB path. Defaults to `defaultObservabilityDbPath()`. */
  dbPath?: string;
  /** Force-disable. Useful for tests + emergency kill-switch via env. */
  enabled?: boolean;
}

export function openObservabilityStore(
  options: OpenObservabilityStoreOptions = {},
): ObservabilityStore {
  const envEnabled = (process.env.PAPERCLIP_TIER_OBSERVABILITY_ENABLED ?? "true")
    .trim()
    .toLowerCase();
  const enabled = options.enabled ?? (envEnabled !== "false" && envEnabled !== "0");
  if (!enabled) {
    return noopStore("disabled-by-env", options.dbPath ?? null);
  }
  const dbPath = options.dbPath ?? defaultObservabilityDbPath();
  const sqlite = loadSqlite();
  if (!sqlite) {
    return noopStore("sqlite-unavailable", dbPath);
  }
  try {
    ensureDirectoryFor(dbPath);
  } catch (err) {
    return noopStore(
      `mkdir-failed:${err instanceof Error ? err.message : String(err)}`,
      dbPath,
    );
  }
  let db: SqliteDatabase;
  try {
    db = new sqlite.DatabaseSync(dbPath);
    db.exec(SCHEMA_SQL);
    db.exec(`INSERT OR REPLACE INTO schema_meta (key, value) VALUES ('schema_version', '1');`);
  } catch (err) {
    return noopStore(
      `open-failed:${err instanceof Error ? err.message : String(err)}`,
      dbPath,
    );
  }

  const insertStmt = db.prepare(`
    INSERT INTO agent_invocations (
      recorded_at, company_id, agent_id, agent_name, issue_id, run_id,
      adapter_type, tier_used, tier_transitions, cost_estimate_usd,
      latency_ms, tokens_used, tokens_in, tokens_out, auth_source, raw_meta
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const tierMixStmt = db.prepare(`
    SELECT tier_used AS tier, COUNT(*) AS count
    FROM agent_invocations
    WHERE recorded_at >= ?
    GROUP BY tier_used
    ORDER BY tier_used ASC
  `);
  const tier1CostStmt = db.prepare(`
    SELECT COALESCE(SUM(cost_estimate_usd), 0) AS total
    FROM agent_invocations
    WHERE tier_used = 1 AND recorded_at >= ?
  `);

  return {
    enabled: true,
    dbPath,
    recordInvocation(record) {
      try {
        const transitions = JSON.stringify(record.tierTransitions ?? []);
        const rawMeta = record.rawMeta ? JSON.stringify(record.rawMeta) : null;
        insertStmt.run(
          record.recordedAt,
          record.companyId,
          record.agentId,
          record.agentName ?? null,
          record.issueId ?? null,
          record.runId,
          record.adapterType,
          record.tierUsed ?? 0,
          transitions,
          record.costEstimateUsd ?? 0,
          record.latencyMs ?? null,
          record.tokensUsed ?? null,
          record.tokensIn ?? null,
          record.tokensOut ?? null,
          record.authSource ?? null,
          rawMeta,
        );
      } catch (err) {
        logger.warn(
          {
            error: err instanceof Error ? err.message : String(err),
            agentId: record.agentId,
            runId: record.runId,
          },
          "tier observability insert failed",
        );
      }
    },
    queryTierMix(sinceIso) {
      try {
        const rows = tierMixStmt.all<{ tier: number; count: number | bigint }>(sinceIso);
        return rows.map((r) => ({ tier: Number(r.tier), count: Number(r.count) }));
      } catch (err) {
        logger.warn(
          { error: err instanceof Error ? err.message : String(err) },
          "tier observability mix query failed",
        );
        return [];
      }
    },
    queryTier1CostSince(sinceIso) {
      try {
        const row = tier1CostStmt.get<{ total: number | null }>(sinceIso);
        return Number(row?.total ?? 0) || 0;
      } catch (err) {
        logger.warn(
          { error: err instanceof Error ? err.message : String(err) },
          "tier observability cost query failed",
        );
        return 0;
      }
    },
    close() {
      try {
        db.close();
      } catch (err) {
        logger.warn(
          { error: err instanceof Error ? err.message : String(err) },
          "tier observability close failed",
        );
      }
    },
  };
}
