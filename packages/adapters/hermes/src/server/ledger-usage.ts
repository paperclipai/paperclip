/**
 * Token accounting for the Hermes local adapter, read from Hermes' own ledger.
 *
 * `hermes --format stream-json` reports `tokens.input` as the total context of
 * the final API call, cache included. Measured on a real run: the ledger holds
 * 40,102 fresh input tokens and 579,840 cached tokens, while stream-json
 * reported `input: 619,429` — exactly the sum of both. Treating that number as
 * fresh input double-counts the cache by an order of magnitude.
 *
 * Hermes keeps authoritative per-session accounting in `state.db`, table
 * `session_model_usage`, keyed by (session_id, model). This module reads those
 * rows and returns the delta a single run added, because a session can be
 * resumed and its rows accumulate across runs.
 *
 * Every failure mode returns `null` (unknown), never zero: a missing ledger,
 * a locked database or an unreadable schema must not look like "no usage".
 */
import { existsSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

export interface UsageTotals {
  /** Uncached input. Cache writes are reported separately, per the ledger. */
  inputTokens: number;
  /** Cache reads only. Paperclip's UsageSummary puts cache writes in inputTokens. */
  cachedInputTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
}

interface DatabaseLike {
  prepare(sql: string): {
    all(...params: unknown[]): Array<Record<string, unknown>>;
  };
  close(): void;
}

type SqliteModule = { DatabaseSync: new (path: string, options?: { readOnly?: boolean }) => DatabaseLike };

const require = createRequire(import.meta.url);

/** Resolve `node:sqlite`, which is built in from Node 22.5 and stable in 24. */
function loadSqlite(): SqliteModule | null {
  try {
    return require("node:sqlite") as SqliteModule;
  } catch {
    return null;
  }
}

/**
 * Locate the Hermes ledger that holds a session.
 *
 * The profile a run used is not knowable from the parent process: the child may
 * carry its own `HERMES_HOME`, and the control plane launched from a different
 * profile. The session id itself is the key, so candidate ledgers are searched
 * and the one containing the session wins. A direct hit on `HERMES_HOME` (or
 * `~/.hermes`) is tried first, then every `profiles/<name>/state.db`.
 */
export function findLedgerForSession(
  sessionId: string | null | undefined,
  preferredHome?: string | null,
): string | null {
  if (!sessionId) return null;

  const roots: string[] = [];
  // The run's effective home comes first: an adapter config can point the
  // child at a HERMES_HOME the parent process never sees.
  const preferred = preferredHome?.trim();
  if (preferred) roots.push(preferred);
  const explicit = process.env.HERMES_HOME?.trim();
  if (explicit && explicit !== preferred) roots.push(explicit);
  const defaultRoot = path.join(process.env.HOME ?? "", ".hermes");
  roots.push(defaultRoot);

  const candidates: string[] = [];
  for (const root of roots) {
    candidates.push(path.join(root, "state.db"));
    const profilesDir = path.join(root, "profiles");
    try {
      for (const entry of readdirSync(profilesDir, { withFileTypes: true })) {
        if (entry.isDirectory()) candidates.push(path.join(profilesDir, entry.name, "state.db"));
      }
    } catch {
      // No profiles directory: nothing to add for this root.
    }
  }

  // Pick the ledger that actually holds usage for this session. A ledger
  // without the session, or one holding only an empty row, must not win over a
  // ledger that has the tokens.
  let best: { path: string; volume: number } | null = null;
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    const usage = readSessionUsage(sessionId, candidate);
    if (!usage) continue;
    const volume = usage.inputTokens + usage.cachedInputTokens + usage.cacheWriteTokens + usage.outputTokens;
    if (volume > 0 && (!best || volume > best.volume)) best = { path: candidate, volume };
  }
  return best?.path ?? null;
}

function counter(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : 0;
}

const SELECT_TOTALS = `SELECT SUM(api_call_count) AS api_calls,
       SUM(input_tokens) AS input_tokens,
       SUM(output_tokens) AS output_tokens,
       SUM(cache_read_tokens) AS cache_read_tokens,
       SUM(cache_write_tokens) AS cache_write_tokens
  FROM session_model_usage
 WHERE session_id = ?`;

/** Read cumulative totals for one session, or null when unreadable. */
export function readSessionUsage(
  sessionId: string | null | undefined,
  dbPath: string | null | undefined,
): UsageTotals | null {
  if (!sessionId || !dbPath || !existsSync(dbPath)) {
    if (process.env.HERMES_LEDGER_DEBUG) {
      console.error(`[ledger] skipped: session=${Boolean(sessionId)} path=${dbPath ?? "none"} exists=${dbPath ? existsSync(dbPath) : false}`);
    }
    return null;
  }
  const sqlite = loadSqlite();
  if (!sqlite) {
    if (process.env.HERMES_LEDGER_DEBUG) console.error("[ledger] node:sqlite not available");
    return null;
  }

  let db: DatabaseLike | undefined;
  try {
    db = new sqlite.DatabaseSync(dbPath, { readOnly: true });
    const [row] = db.prepare(SELECT_TOTALS).all(sessionId);
    if (!row) return null;
    return {
      inputTokens: counter(row.input_tokens),
      cachedInputTokens: counter(row.cache_read_tokens),
      cacheWriteTokens: counter(row.cache_write_tokens),
      outputTokens: counter(row.output_tokens),
    };
  } catch {
    // Locked, missing table or schema drift: unknown, not zero.
    return null;
  } finally {
    try {
      db?.close();
    } catch {
      // A failing close must not mask the read result.
    }
  }
}

function subtract(after: UsageTotals, before: UsageTotals | null): UsageTotals {
  const base = before ?? { inputTokens: 0, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 0 };
  return {
    inputTokens: Math.max(0, after.inputTokens - base.inputTokens),
    cachedInputTokens: Math.max(0, after.cachedInputTokens - base.cachedInputTokens),
    cacheWriteTokens: Math.max(0, after.cacheWriteTokens - base.cacheWriteTokens),
    outputTokens: Math.max(0, after.outputTokens - base.outputTokens),
  };
}

/**
 * Measure what a run added to the ledger.
 *
 * `before` is the snapshot taken when the run started. A run against a fresh
 * session has no prior rows, so the delta equals the whole session.
 */
export function readRunUsageDelta(
  sessionId: string | null | undefined,
  dbPath: string | null | undefined,
  before: UsageTotals | null,
): UsageTotals | null {
  const after = readSessionUsage(sessionId, dbPath);
  if (!after) return null;
  return subtract(after, before);
}

/** Resolve the ledger path of one known Hermes home, without searching. */
export function hermesStateDbPath(home?: string | null): string | null {
  // A blank value means "not configured", not "no ledger": fall back to the
  // default root the same way Hermes does.
  const configured = home !== undefined ? home : process.env.HERMES_HOME;
  const base =
    configured && configured.trim().length > 0
      ? configured.trim()
      : path.join(process.env.HOME ?? "", ".hermes");
  if (!base) return null;
  return path.join(base, "state.db");
}

const DEFAULT_POLL_DELAYS_MS = [0, 1000, 2000, 3000, 5000, 8000, 10000, 10000];
const DEFAULT_MAX_DISCOVERY_ATTEMPTS = 3;

export interface CompleteLedgerRead {
  /** The run's usage delta; null when completion could not be established. */
  usage: UsageTotals | null;
  ledgerPath: string | null;
  complete: boolean;
}

/**
 * Read a run's usage from the ledger, waiting until Hermes' background writer
 * has finished. Hermes flushes its rows after the child exits, so the totals
 * are polled: three equal non-zero reads are the completion evidence. A
 * cached helper row can carry cache tokens too, so no single count can prove
 * the final write. When the window ends without that evidence the usage is
 * unknown — publishing partial totals would charge a fraction as if it were
 * all. Discovery is retried while unknown (a fresh session's first row creates
 * the entry), bounded so a missing layout does not stall the run.
 */
export async function readRunUsageWhenComplete(
  sessionId: string,
  options: {
    before?: UsageTotals | null;
    preferredHome?: string | null;
    delaysMs?: number[];
    maxDiscoveryAttempts?: number;
    sleep?: (ms: number) => Promise<void>;
  } = {},
): Promise<CompleteLedgerRead> {
  const delays = options.delaysMs ?? DEFAULT_POLL_DELAYS_MS;
  const maxDiscovery = options.maxDiscoveryAttempts ?? DEFAULT_MAX_DISCOVERY_ATTEMPTS;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  let ledgerPath = findLedgerForSession(sessionId, options.preferredHome);
  let runUsage: UsageTotals | null = null;
  let previous = "";
  let stableReads = 0;
  let discoveryAttempts = 0;
  let complete = false;

  for (const delayMs of delays) {
    if (delayMs > 0) await sleep(delayMs);
    ledgerPath ??= findLedgerForSession(sessionId, options.preferredHome);
    if (!ledgerPath) {
      if (++discoveryAttempts >= maxDiscovery) break;
      continue;
    }
    runUsage = readRunUsageDelta(sessionId, ledgerPath, options.before ?? null);
    if (!runUsage) continue;
    const total =
      runUsage.inputTokens + runUsage.cachedInputTokens + runUsage.cacheWriteTokens + runUsage.outputTokens;
    const signature = JSON.stringify(runUsage);
    stableReads = total > 0 && signature === previous ? stableReads + 1 : 0;
    previous = signature;
    if (stableReads >= 2) {
      complete = true;
      break;
    }
  }

  return { usage: complete ? runUsage : null, ledgerPath, complete };
}
