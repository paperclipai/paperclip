/**
 * Backfill historical `cost_events.cost_cents` rows that landed at $0 because
 * the adapter could not parse a cost from its CLI output. Pulls per-row
 * `(provider, model, tokens, billing_type)` and recomputes through the
 * `@paperclipai/pricing` service. Idempotent and dry-run by default.
 *
 * Runs out-of-band (one-shot maintenance task), wired into the workspace via
 * `pnpm --filter @paperclipai/server pricing:backfill`.
 *
 * Safety:
 *   - dry-run unless `--apply` is passed
 *   - pre-flight snapshot into `cost_events_backfill_snapshot` before any UPDATE
 *   - allowlist filter on `billing_type` so subscription/fixed rows are not touched
 *   - operates on `cost_cents = 0` only (NULL rows are correctly-identified-unpriced)
 *   - rollback restores from the snapshot table
 *
 * See `/Users/mjaverto/.claude/plans/okay-i-agree-let-s-radiant-origami.md`
 * Phase 0.5, Lane G for the design and the safety constraints this implements.
 */

import { sql, eq, and, inArray, isNotNull } from "drizzle-orm";
import readline from "node:readline";
import { createDb, costEvents, agentRuntimeState } from "@paperclipai/db";
import type { Db } from "@paperclipai/db";
import { priceUsd } from "@paperclipai/pricing";
import { loadConfig } from "../config.js";

// ---------------------------------------------------------------------------
// Public surface (exported for tests). The CLI path lives at the bottom.
// ---------------------------------------------------------------------------

export interface BackfillOptions {
  /** Default true. Must be flipped off explicitly via `--apply`. */
  dryRun: boolean;
  /** Restrict to a single agent. */
  agentId?: string | null;
  /** Restrict to a single company. */
  companyId?: string | null;
  /** UPDATE batch size. */
  batchSize: number;
  /** Restore-from-snapshot mode. */
  rollback: boolean;
  /** Skip rollback confirmation prompt. */
  yes: boolean;
  /**
   * Session timestamp passed to the snapshot INSERT so a re-run does not
   * re-snapshot rows already captured in this run. Defaults to "now".
   */
  sessionAt?: Date;
  /**
   * Optional override for the priceUsd function — tests inject a fake so they
   * can drive deterministic catalog responses without touching the vendored
   * snapshot. Defaults to the real `@paperclipai/pricing` lookup.
   */
  priceUsd?: typeof priceUsd;
  /** Where progress lines are written. Defaults to stdout. */
  log?: (line: string) => void;
}

export interface BackfillSummary {
  mode: "dry-run" | "apply" | "rollback";
  candidateCount: number;
  wouldUpdateCount: number;
  wouldStayUnchangedCount: number;
  wouldStayZeroWithoutPricingCount: number;
  appliedUpdateCount: number;
  affectedAgentIds: string[];
  agentRuntimeStateRefreshed: number;
  rolledBackRowCount: number;
  /** ISO timestamp passed in (or generated) for snapshot deduplication. */
  sessionAt: string;
}

const ALLOWED_BILLING_TYPES = ["metered_api", "credits", "unknown"] as const;

// `agent_runtime_state.total_cost_cents` is BIGINT but drizzle types it as
// `number` in mode:"number". COALESCE returns text under postgres-js when the
// column is bigint, so we cast back inside the SUM.
const SUM_COST_CENTS_NOT_NULL = sql<number>`COALESCE(SUM(${costEvents.costCents}) FILTER (WHERE ${costEvents.costCents} IS NOT NULL), 0)::bigint`;

// ---------------------------------------------------------------------------
// Pre-flight: snapshot table
// ---------------------------------------------------------------------------

async function ensureSnapshotTable(db: Db): Promise<void> {
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS cost_events_backfill_snapshot (
      id uuid NOT NULL,
      cost_cents integer,
      billing_type text,
      snapshot_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (id, snapshot_at)
    )
  `);
}

async function snapshotCandidates(
  db: Db,
  options: BackfillOptions,
  sessionAt: Date,
): Promise<number> {
  // Snapshot every candidate row we are about to consider in this session.
  // The (id, snapshot_at) PK guarantees we never overwrite a prior session's
  // capture. Within the same session we filter on `sessionAt` so a re-run
  // (after a partial crash) does not duplicate-insert.
  const agentClause = options.agentId
    ? sql`AND ce.agent_id = ${options.agentId}`
    : sql``;
  const companyClause = options.companyId
    ? sql`AND ce.company_id = ${options.companyId}`
    : sql``;

  const sessionIso = sessionAt.toISOString();
  const result = await db.execute(sql`
    INSERT INTO cost_events_backfill_snapshot (id, cost_cents, billing_type, snapshot_at)
    SELECT ce.id, ce.cost_cents, ce.billing_type, ${sessionIso}::timestamptz
    FROM cost_events ce
    WHERE ce.billing_type IN ('metered_api','credits','unknown')
      AND ce.cost_cents = 0
      ${agentClause}
      ${companyClause}
      AND NOT EXISTS (
        SELECT 1 FROM cost_events_backfill_snapshot s
        WHERE s.id = ce.id AND s.snapshot_at = ${sessionIso}::timestamptz
      )
  `);

  // postgres-js returns the inserted-row count via .count on the result.
  // Cast through unknown because Db.execute() is typed as unknown[].
  return readRowCount(result);
}

// ---------------------------------------------------------------------------
// Candidate identification
// ---------------------------------------------------------------------------

interface CandidateRow {
  id: string;
  agentId: string;
  companyId: string;
  provider: string;
  model: string;
  billingType: string;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  costCents: number | null;
}

/**
 * Candidate-filter SQL (mirrored verbatim in the dryRun report):
 *
 *   billing_type IN ('metered_api','credits','unknown')
 *     AND cost_cents = 0
 *     AND <optional agent/company scope>
 *
 * Note that we deliberately exclude `cost_cents IS NULL`. NULL rows in the
 * post-Lane-A schema were already classified as unpriced at write time —
 * touching them would erase the "pricing service had no entry" signal.
 */
async function listCandidates(
  db: Db,
  options: BackfillOptions,
): Promise<CandidateRow[]> {
  const where = and(
    inArray(costEvents.billingType, [...ALLOWED_BILLING_TYPES]),
    eq(costEvents.costCents, 0),
    options.agentId ? eq(costEvents.agentId, options.agentId) : undefined,
    options.companyId ? eq(costEvents.companyId, options.companyId) : undefined,
  );

  const rows = await db
    .select({
      id: costEvents.id,
      agentId: costEvents.agentId,
      companyId: costEvents.companyId,
      provider: costEvents.provider,
      model: costEvents.model,
      billingType: costEvents.billingType,
      inputTokens: costEvents.inputTokens,
      cachedInputTokens: costEvents.cachedInputTokens,
      outputTokens: costEvents.outputTokens,
      costCents: costEvents.costCents,
    })
    .from(costEvents)
    .where(where);

  return rows;
}

// ---------------------------------------------------------------------------
// Per-row pricing
// ---------------------------------------------------------------------------

interface PricedCandidate {
  id: string;
  agentId: string;
  newCostCents: number;
}

function priceCandidates(
  rows: CandidateRow[],
  pricer: typeof priceUsd,
): { priced: PricedCandidate[]; unpriced: CandidateRow[] } {
  const priced: PricedCandidate[] = [];
  const unpriced: CandidateRow[] = [];
  for (const row of rows) {
    const usd = pricer({
      provider: row.provider,
      model: row.model,
      inputTokens: row.inputTokens,
      outputTokens: row.outputTokens,
      cachedInputTokens: row.cachedInputTokens,
      billingType: row.billingType,
    });
    if (typeof usd === "number" && Number.isFinite(usd) && usd > 0) {
      priced.push({
        id: row.id,
        agentId: row.agentId,
        newCostCents: Math.max(0, Math.round(usd * 100)),
      });
    } else {
      unpriced.push(row);
    }
  }
  return { priced, unpriced };
}

// ---------------------------------------------------------------------------
// Apply mode
// ---------------------------------------------------------------------------

async function applyUpdates(
  db: Db,
  priced: PricedCandidate[],
  options: BackfillOptions,
  log: (line: string) => void,
): Promise<number> {
  if (priced.length === 0) return 0;

  let applied = 0;
  for (let offset = 0; offset < priced.length; offset += options.batchSize) {
    const batch = priced.slice(offset, offset + options.batchSize);

    // Each row gets its own UPDATE (cost differs per row). We send them in a
    // single transaction per batch so a partial failure rolls back cleanly.
    await db.transaction(async (tx) => {
      for (const row of batch) {
        // Idempotency guard: only UPDATE if the row is still cost_cents = 0
        // AND still in the allowed billing-type set. Belt and suspenders for
        // concurrent writers.
        await tx
          .update(costEvents)
          .set({ costCents: row.newCostCents })
          .where(
            and(
              eq(costEvents.id, row.id),
              eq(costEvents.costCents, 0),
              inArray(costEvents.billingType, [...ALLOWED_BILLING_TYPES]),
            ),
          );
        applied += 1;
      }
    });

    log(
      JSON.stringify({
        event: "batch.applied",
        batch: Math.floor(offset / options.batchSize) + 1,
        size: batch.length,
        applied,
        total: priced.length,
      }),
    );
  }

  return applied;
}

async function refreshAgentRuntimeState(
  db: Db,
  agentIds: string[],
  log: (line: string) => void,
): Promise<number> {
  if (agentIds.length === 0) return 0;

  // Recompute totalCostCents for every affected agent from the canonical
  // cost_events sum (excluding NULLs). Mirrors the Lane G plan SQL but
  // expressed via drizzle so it stays type-safe.
  const updated = await db
    .update(agentRuntimeState)
    .set({
      totalCostCents: sql<number>`(
        SELECT ${SUM_COST_CENTS_NOT_NULL}
        FROM ${costEvents}
        WHERE ${costEvents.agentId} = ${agentRuntimeState.agentId}
          AND ${isNotNull(costEvents.costCents)}
      )`,
      updatedAt: new Date(),
    })
    .where(inArray(agentRuntimeState.agentId, agentIds))
    .returning({ agentId: agentRuntimeState.agentId });

  log(
    JSON.stringify({
      event: "runtime_state.refreshed",
      agentIds: updated.length,
    }),
  );

  return updated.length;
}

// ---------------------------------------------------------------------------
// Rollback mode
// ---------------------------------------------------------------------------

async function rollbackFromSnapshot(
  db: Db,
  options: BackfillOptions,
  log: (line: string) => void,
): Promise<{ rowCount: number; affectedAgents: string[] }> {
  // Restore each cost_events row to its pre-backfill cost_cents value. We use
  // the most-recent snapshot per id (a row may have been snapshotted multiple
  // times if multiple `--apply` passes touched it).
  //
  // Rollback SQL (per the Lane G plan, verbatim):
  //   UPDATE cost_events SET cost_cents = s.cost_cents
  //   FROM cost_events_backfill_snapshot s
  //   WHERE cost_events.id = s.id;
  const agentClause = options.agentId
    ? sql`AND ce.agent_id = ${options.agentId}`
    : sql``;
  const companyClause = options.companyId
    ? sql`AND ce.company_id = ${options.companyId}`
    : sql``;

  // Capture the affected agent ids first so we can refresh their runtime
  // state after the restore (numbers will have changed).
  const beforeRows = await db.execute(sql`
    SELECT DISTINCT ce.agent_id::text AS agent_id
    FROM cost_events ce
    JOIN cost_events_backfill_snapshot s ON s.id = ce.id
    WHERE ce.cost_cents IS DISTINCT FROM s.cost_cents
      ${agentClause}
      ${companyClause}
  `);
  const affectedAgents = Array.from(
    new Set(toRows<{ agent_id: string }>(beforeRows).map((r) => r.agent_id)),
  );

  const result = await db.execute(sql`
    UPDATE cost_events
    SET cost_cents = latest.cost_cents
    FROM (
      SELECT DISTINCT ON (id) id, cost_cents
      FROM cost_events_backfill_snapshot
      ORDER BY id, snapshot_at DESC
    ) latest
    WHERE cost_events.id = latest.id
      AND cost_events.cost_cents IS DISTINCT FROM latest.cost_cents
  `);

  const rowCount = readRowCount(result);
  log(
    JSON.stringify({
      event: "rollback.applied",
      rowCount,
      affectedAgents: affectedAgents.length,
    }),
  );

  return { rowCount, affectedAgents };
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

export async function runBackfill(
  db: Db,
  options: BackfillOptions,
): Promise<BackfillSummary> {
  const log = options.log ?? ((line: string) => process.stdout.write(line + "\n"));
  const pricer = options.priceUsd ?? priceUsd;
  const sessionAt = options.sessionAt ?? new Date();

  if (options.rollback) {
    await ensureSnapshotTable(db);
    const { rowCount, affectedAgents } = await rollbackFromSnapshot(db, options, log);
    const refreshed = await refreshAgentRuntimeState(db, affectedAgents, log);
    return {
      mode: "rollback",
      candidateCount: 0,
      wouldUpdateCount: 0,
      wouldStayUnchangedCount: 0,
      wouldStayZeroWithoutPricingCount: 0,
      appliedUpdateCount: 0,
      affectedAgentIds: affectedAgents,
      agentRuntimeStateRefreshed: refreshed,
      rolledBackRowCount: rowCount,
      sessionAt: sessionAt.toISOString(),
    };
  }

  const candidates = await listCandidates(db, options);
  const { priced, unpriced } = priceCandidates(candidates, pricer);
  const affectedAgentIds = Array.from(new Set(priced.map((p) => p.agentId)));

  log(
    JSON.stringify({
      event: "candidates.identified",
      candidateCount: candidates.length,
      wouldUpdate: priced.length,
      wouldStayZeroWithoutPricing: unpriced.length,
      affectedAgents: affectedAgentIds.length,
      mode: options.dryRun ? "dry-run" : "apply",
    }),
  );

  if (options.dryRun) {
    return {
      mode: "dry-run",
      candidateCount: candidates.length,
      wouldUpdateCount: priced.length,
      wouldStayUnchangedCount: 0,
      wouldStayZeroWithoutPricingCount: unpriced.length,
      appliedUpdateCount: 0,
      affectedAgentIds,
      agentRuntimeStateRefreshed: 0,
      rolledBackRowCount: 0,
      sessionAt: sessionAt.toISOString(),
    };
  }

  // Apply path: snapshot first, then update.
  await ensureSnapshotTable(db);
  const snapshotted = await snapshotCandidates(db, options, sessionAt);
  log(
    JSON.stringify({
      event: "snapshot.captured",
      rowCount: snapshotted,
      sessionAt: sessionAt.toISOString(),
    }),
  );

  const applied = await applyUpdates(db, priced, options, log);
  const refreshed = await refreshAgentRuntimeState(db, affectedAgentIds, log);

  return {
    mode: "apply",
    candidateCount: candidates.length,
    wouldUpdateCount: priced.length,
    wouldStayUnchangedCount: 0,
    wouldStayZeroWithoutPricingCount: unpriced.length,
    appliedUpdateCount: applied,
    affectedAgentIds,
    agentRuntimeStateRefreshed: refreshed,
    rolledBackRowCount: 0,
    sessionAt: sessionAt.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// CLI plumbing
// ---------------------------------------------------------------------------

interface ParsedArgs {
  options: BackfillOptions;
  help: boolean;
}

export function parseArgs(argv: readonly string[]): ParsedArgs {
  let dryRun = true;
  let apply = false;
  let agentId: string | null = null;
  let companyId: string | null = null;
  let batchSize = 500;
  let rollback = false;
  let yes = false;
  let help = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case "--dry-run":
        dryRun = true;
        apply = false;
        break;
      case "--apply":
        apply = true;
        dryRun = false;
        break;
      case "--rollback":
        rollback = true;
        break;
      case "--yes":
      case "-y":
        yes = true;
        break;
      case "--agent-id":
        agentId = argv[++i] ?? null;
        break;
      case "--company-id":
        companyId = argv[++i] ?? null;
        break;
      case "--batch-size": {
        const value = Number.parseInt(argv[++i] ?? "", 10);
        if (!Number.isFinite(value) || value <= 0) {
          throw new Error("--batch-size must be a positive integer");
        }
        batchSize = value;
        break;
      }
      case "--help":
      case "-h":
        help = true;
        break;
      default:
        if (arg && arg.startsWith("--")) {
          throw new Error(`Unknown flag: ${arg}`);
        }
    }
  }

  if (apply && rollback) {
    throw new Error("--apply and --rollback are mutually exclusive");
  }

  return {
    options: {
      dryRun: rollback ? false : dryRun,
      agentId,
      companyId,
      batchSize,
      rollback,
      yes,
    },
    help,
  };
}

const HELP_TEXT = `pricing:backfill — recompute cost_events.cost_cents from the pricing catalog

Defaults to dry-run. Pass --apply to actually write updates.

Flags:
  --dry-run                 Default. Print summary without writing.
  --apply                   Execute UPDATEs.
  --rollback                Restore cost_events.cost_cents from the snapshot table.
  --yes, -y                 Skip the rollback confirmation prompt.
  --agent-id <uuid>         Limit to a single agent.
  --company-id <uuid>       Limit to a single company.
  --batch-size <n>          UPDATE batch size (default 500).
  --help, -h                Show this help.
`;

async function confirmRollback(): Promise<boolean> {
  if (!process.stdin.isTTY) return false;
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = await new Promise<string>((resolve) => {
      rl.question(
        "Rollback will overwrite cost_events.cost_cents from the snapshot table. Continue? [y/N] ",
        resolve,
      );
    });
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

async function main(): Promise<void> {
  const { options, help } = parseArgs(process.argv.slice(2));
  if (help) {
    process.stdout.write(HELP_TEXT);
    return;
  }

  if (options.rollback && !options.yes) {
    const ok = await confirmRollback();
    if (!ok) {
      process.stderr.write("Rollback aborted.\n");
      process.exitCode = 1;
      return;
    }
  }

  const config = loadConfig();
  const dbUrl =
    process.env.DATABASE_URL?.trim()
    || config.databaseUrl
    || `postgres://paperclip:paperclip@127.0.0.1:${config.embeddedPostgresPort}/paperclip`;

  const db = createDb(dbUrl);
  const summary = await runBackfill(db, options);
  process.stdout.write(JSON.stringify({ event: "summary", ...summary }, null, 2) + "\n");
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toRows<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  if (result && typeof result === "object" && Array.isArray((result as { rows?: unknown }).rows)) {
    return (result as { rows: T[] }).rows;
  }
  return [];
}

function readRowCount(result: unknown): number {
  if (result && typeof result === "object") {
    const count = (result as { count?: unknown }).count;
    if (typeof count === "number" && Number.isFinite(count)) return count;
    const length = (result as { length?: unknown }).length;
    if (typeof length === "number" && Number.isFinite(length)) return length;
    const rows = (result as { rows?: unknown }).rows;
    if (Array.isArray(rows)) return rows.length;
  }
  return 0;
}

// Run as CLI when invoked directly (tsx src/scripts/backfill-cost-cents.ts).
const isCli = (() => {
  if (typeof process === "undefined" || !process.argv[1]) return false;
  try {
    const entry = process.argv[1];
    const url = new URL(import.meta.url);
    return url.pathname === entry || url.pathname.endsWith(entry);
  } catch {
    return false;
  }
})();

if (isCli) {
  void main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`pricing:backfill failed: ${message}\n`);
    process.exitCode = 1;
  });
}
