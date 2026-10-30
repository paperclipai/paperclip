/**
 * Usage and cost accounting for the Hermes local adapter, read from Hermes'
 * own ledger instead of its stdout.
 *
 * Hermes keeps authoritative per-session, per-model accounting in
 * `~/.hermes/state.db` (`session_model_usage`). It is written by the same code
 * that renders the CLI's own cost footer, and it carries a `cost_status` saying
 * whether a row is a reconciled `actual`, an `estimated`, `included` in a
 * subscription, or unpriced.
 *
 * Reading it replaces two regexes that scraped the child's stdout. Those
 * regexes matched no line Hermes actually prints -- it prints
 * `Input tokens: 1,868,210`, while the pattern required `tokens: N input` with
 * no thousands separators -- so every run recorded zero tokens. Worse, the cost
 * pattern `(?:cost|spent)[:\s]*\$?([\d.]+)` matched the *agent's own prose*, so
 * a sentence like "hosting cost: 0.07 per hour" became $0.07 of billed spend
 * while the real cost line (`**Cost:** ~$1.93 estimated`) did not match at all.
 * A seat could therefore set its own billed spend by typing the word "cost".
 *
 * Four invariants here are deliberate:
 *
 * - A session's rows accumulate across resumes, so a run is charged the
 *   *delta* against a baseline taken before the child starts.
 * - When the ledger has usage it could not price, tokens are reported with no
 *   cost at all rather than a cost of zero, so Paperclip records the row as
 *   `unpriced` instead of as a run that was free.
 * - Pricing is judged on the models this run actually *grew*, not on the
 *   session as a whole. A session that was priced yesterday must not make
 *   today's unpriced run look like a run that cost nothing.
 * - "The ledger says nothing yet" and "the ledger could not be read" are
 *   different answers. Only the first is zero; the second is unknown, and a
 *   run whose baseline is unknown is left unpriced rather than being charged
 *   the whole session's history.
 */

import { createRequire } from "node:module";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);

/** `cost_status` values that mean the row carries a usable price. */
const PRICED_COST_STATUS = new Set(["actual", "estimated", "included"]);

/** How long to wait for Hermes to flush accounting after the child exits. */
const SETTLE_ATTEMPTS = 6;
const SETTLE_INTERVAL_MS = 250;

/** One model's accumulated usage within a session. */
export interface ModelUsage {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  apiCalls: number;
  /** Accumulated cost, or null when the row carries tokens with no usable price. */
  costUsd: number | null;
}

/** Totals for one session, summed across every model it used. */
export interface LedgerTotals {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  apiCalls: number;
  /** Sum of priced rows only. Unpriced rows contribute no cost. */
  costUsd: number;
  pricedRows: number;
  unpricedRows: number;
  /** Models whose rows recorded tokens but no usable price. */
  unpricedModels: string[];
  /** Per-model breakdown, so a delta can tell which models actually moved. */
  byModel: Record<string, ModelUsage>;
  /** False when the ledger is readable but holds no rows for this session yet. */
  hasRows: boolean;
}

/** What a single run consumed: the delta between two ledger reads. */
export interface LedgerDelta {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  apiCalls: number;
  /** Cost of the priced models this run grew. Partial when `unpriced` is true. */
  costUsd: number;
  /**
   * True only when every model this run grew carried a usable price, so
   * `costUsd` is the run's whole cost rather than part of it. Callers report a
   * cost to Paperclip only on this flag.
   */
  priced: boolean;
  /** True when a model this run grew recorded tokens with no usable price. */
  unpriced: boolean;
  unpricedModels: string[];
}

/** A readable ledger holding nothing for this session: known zero, not unknown. */
export function emptyLedgerTotals(): LedgerTotals {
  return {
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    apiCalls: 0,
    costUsd: 0,
    pricedRows: 0,
    unpricedRows: 0,
    unpricedModels: [],
    byModel: {},
    hasRows: false,
  };
}

interface UsageRow {
  model?: unknown;
  api_call_count?: unknown;
  input_tokens?: unknown;
  output_tokens?: unknown;
  cache_read_tokens?: unknown;
  cache_write_tokens?: unknown;
  estimated_cost_usd?: unknown;
  actual_cost_usd?: unknown;
  cost_status?: unknown;
}

/**
 * Resolve Hermes' state database: explicit config, then HERMES_HOME, then
 * `<child HOME>/.hermes`.
 *
 * `env` must be the environment the child is actually launched with. A config
 * that overrides HOME without setting HERMES_HOME moves Hermes' ledger with it,
 * so reading `os.homedir()` here would meter the wrong database — or none.
 * `os.homedir()` remains the fallback for when the child inherits our own HOME.
 */
export function resolveStateDbPath(
  config: Record<string, unknown> | undefined,
  env: Record<string, string | undefined> | undefined,
): string {
  const explicit = config?.hermesStateDb;
  if (typeof explicit === "string" && explicit.trim()) return explicit;
  const hermesHome = env?.HERMES_HOME?.trim();
  if (hermesHome) return path.join(hermesHome, "state.db");
  const home = env?.HOME?.trim() || os.homedir();
  return path.join(home, ".hermes", "state.db");
}

/** Non-negative integer counter, or 0. Providers occasionally report nonsense. */
function counter(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/**
 * The usable cost of a row, or null when it has none.
 *
 * `actual_cost_usd` is NOT NULL DEFAULT 0, so 0 means "not yet reconciled"
 * rather than "free", and the estimate is used instead. A negative amount is
 * never a cost: OpenRouter publishes `prompt: -1, completion: -1` as sentinel
 * pricing for its router pseudo-models, which Hermes multiplied out into large
 * negative costs. Refusing it here keeps it out of any seat total.
 */
function rowCostUsd(actual: unknown, estimated: unknown): number | null {
  const reconciled = Number(actual);
  if (Number.isFinite(reconciled) && reconciled > 0) return reconciled;
  const estimate = Number(estimated);
  if (!Number.isFinite(estimate) || estimate < 0) return null;
  return estimate;
}

/** Only the slice of `node:sqlite` this module uses. */
interface ReadOnlyDatabase {
  prepare(sql: string): { all(...params: unknown[]): UsageRow[] };
  close(): void;
}
interface SqliteModule {
  DatabaseSync: new (path: string, options?: { readOnly?: boolean }) => ReadOnlyDatabase;
}

let sqliteModule: SqliteModule | null = null;
let sqliteLoadAttempted = false;

/** `node:sqlite` is built in from Node 22.5, but load defensively and once. */
function loadSqlite(): SqliteModule | null {
  if (!sqliteLoadAttempted) {
    sqliteLoadAttempted = true;
    try {
      sqliteModule = require("node:sqlite") as SqliteModule;
    } catch {
      sqliteModule = null;
    }
  }
  return sqliteModule;
}

/**
 * Session totals from Hermes' ledger, or null when they cannot be read.
 *
 * Null means "unknown" and is never substituted with zeros: a run whose usage
 * is unknown must not be recorded as a run that used nothing. A ledger that is
 * readable but holds no rows for this session is a different answer — that is
 * a known zero, returned as empty totals with `hasRows: false`, because a
 * session which has not billed anything yet is not an unreadable ledger.
 */
export function readLedgerTotals(
  sessionId: string | null | undefined,
  dbPath: string | null | undefined,
): LedgerTotals | null {
  if (!sessionId || !dbPath || !fsSync.existsSync(dbPath)) return null;
  const sqlite = loadSqlite();
  if (!sqlite) return null;

  let db: ReadOnlyDatabase | undefined;
  try {
    db = new sqlite.DatabaseSync(dbPath, { readOnly: true });
    const rows = db
      .prepare(
        `SELECT model, api_call_count, input_tokens, output_tokens,
                cache_read_tokens, cache_write_tokens,
                estimated_cost_usd, actual_cost_usd, cost_status
           FROM session_model_usage
          WHERE session_id = ?`,
      )
      .all(sessionId);
    if (rows.length === 0) return emptyLedgerTotals();

    const totals = emptyLedgerTotals();
    totals.hasRows = true;

    for (const row of rows) {
      const model = String(row.model ?? "unknown");
      const input = counter(row.input_tokens);
      const cached = counter(row.cache_read_tokens) + counter(row.cache_write_tokens);
      const output = counter(row.output_tokens);
      const apiCalls = counter(row.api_call_count);
      totals.inputTokens += input;
      totals.cachedInputTokens += cached;
      totals.outputTokens += output;
      totals.apiCalls += apiCalls;

      const rawCost = rowCostUsd(row.actual_cost_usd, row.estimated_cost_usd);
      const cost =
        rawCost !== null && PRICED_COST_STATUS.has(String(row.cost_status ?? "")) ? rawCost : null;
      if (cost !== null) {
        totals.costUsd += cost;
        totals.pricedRows += 1;
      } else if (input || cached || output) {
        totals.unpricedRows += 1;
        totals.unpricedModels.push(model);
      }

      // The schema keys on (session_id, model), but accumulate defensively so a
      // duplicated row cannot silently discard usage.
      const perModel = (totals.byModel[model] ??= {
        inputTokens: 0,
        cachedInputTokens: 0,
        outputTokens: 0,
        apiCalls: 0,
        costUsd: null,
      });
      perModel.inputTokens += input;
      perModel.cachedInputTokens += cached;
      perModel.outputTokens += output;
      perModel.apiCalls += apiCalls;
      if (cost !== null) perModel.costUsd = (perModel.costUsd ?? 0) + cost;
    }

    return totals;
  } catch {
    // A locked, truncated or schema-changed database is "unknown", not zero.
    return null;
  } finally {
    try {
      db?.close();
    } catch {
      // Already closed, or never opened.
    }
  }
}

/**
 * What this run consumed, given ledger reads from before and after it.
 *
 * Hermes resumes sessions and its rows accumulate, so the difference -- not the
 * total -- is what the run should be charged. Deltas are clamped at zero: the
 * ledger only grows, and a negative delta would mean the baseline was wrong.
 *
 * Either read being null means "unknown", and the answer is null rather than a
 * guess. In particular a null *baseline* is not treated as zero: on a resumed
 * session a momentarily unreadable database would otherwise re-charge the
 * entire session history to this one run. Callers starting a fresh session
 * pass `emptyLedgerTotals()`, which says zero and means it.
 *
 * Pricing is decided per model, over the models this run actually grew. A model
 * that did not move cannot make the run look priced, and a run that grew any
 * unpriced model is reported unpriced -- `costUsd` then holds the part that is
 * known, which is strictly less than the run's real cost.
 */
export function diffLedgerTotals(
  before: LedgerTotals | null,
  after: LedgerTotals | null,
): LedgerDelta | null {
  if (!after || !before) return null;

  const grew = (now: unknown, was: unknown) => Math.max(0, counter(now) - counter(was));
  const noUsage: ModelUsage = {
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    apiCalls: 0,
    costUsd: null,
  };

  let costUsd = 0;
  let anyPriced = false;
  const unpricedModels: string[] = [];

  for (const [model, now] of Object.entries(after.byModel)) {
    const was = before.byModel[model] ?? noUsage;
    const moved =
      grew(now.inputTokens, was.inputTokens) +
        grew(now.cachedInputTokens, was.cachedInputTokens) +
        grew(now.outputTokens, was.outputTokens) +
        grew(now.apiCalls, was.apiCalls) >
      0;
    if (!moved) continue;
    if (now.costUsd === null) {
      unpricedModels.push(model);
    } else {
      anyPriced = true;
      costUsd += Math.max(0, now.costUsd - (was.costUsd ?? 0));
    }
  }

  return {
    inputTokens: grew(after.inputTokens, before.inputTokens),
    cachedInputTokens: grew(after.cachedInputTokens, before.cachedInputTokens),
    outputTokens: grew(after.outputTokens, before.outputTokens),
    apiCalls: grew(after.apiCalls, before.apiCalls),
    // Costs are fractions of a cent, so round rather than floor.
    costUsd: Math.max(0, Math.round(costUsd * 1e6) / 1e6),
    priced: anyPriced && unpricedModels.length === 0,
    unpriced: unpricedModels.length > 0,
    unpricedModels: [...new Set(unpricedModels)],
  };
}

/**
 * Read the ledger, giving Hermes a moment to flush its accounting.
 *
 * Hermes writes usage when it finalizes a session, which can land just after
 * the child exits. Polling until the totals move past the baseline avoids
 * charging a run zero because the read was a few milliseconds early.
 */
export async function readLedgerTotalsSettled(
  sessionId: string | null | undefined,
  dbPath: string | null | undefined,
  baseline: LedgerTotals | null,
): Promise<LedgerTotals | null> {
  let latest: LedgerTotals | null = null;
  for (let attempt = 0; attempt < SETTLE_ATTEMPTS; attempt += 1) {
    latest = readLedgerTotals(sessionId, dbPath);
    const moved =
      latest !== null &&
      (baseline === null ||
        latest.apiCalls > baseline.apiCalls ||
        latest.inputTokens > baseline.inputTokens ||
        latest.outputTokens > baseline.outputTokens);
    if (moved) return latest;
    await new Promise((resolve) => setTimeout(resolve, SETTLE_INTERVAL_MS));
  }
  return latest;
}
