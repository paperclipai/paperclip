import { sql } from "drizzle-orm";
import type { createDb } from "./client.js";

/**
 * Trigram (pg_trgm) search hardening — TON-2145 (follow-up to incident TON-2143).
 *
 * Background: comment / document / issue text columns carry GIN trigram indexes
 * (`gin_trgm_ops`). GIN index maintenance runs *inline on the write transaction*,
 * and computing trigrams calls into the `pg_trgm` shared library. If that library
 * becomes unloadable at runtime (e.g. the `$libdir/pg_trgm` resolution breaking
 * after a data-dir relocation + restart, as in TON-2143) then EVERY insert/update
 * with enough novel text aborts — turning a search-only dependency into a
 * company-wide write outage (HTTP 500 on every comment/doc/issue write).
 *
 * Goal of this module: a trigram/extension load failure must DEGRADE SEARCH, not
 * 500 the primary write. We cannot make Postgres skip maintenance of a single
 * index for one statement, so the only way to *complete the write* while the
 * library is broken is to remove the offending trigram indexes. We therefore:
 *   1. classify the failure (conservatively — real bugs must still surface),
 *   2. emit a loud, durable degraded-search signal,
 *   3. drop the trigram GIN indexes ONCE (idempotently) so writes stop touching
 *      the broken library, and
 *   4. retry the write, which now succeeds.
 *
 * Search keeps working in a degraded (non-trigram) mode: the company-search
 * service already falls back to `LIKE`/sequential matching for everything except
 * fuzzy identifier similarity, so dropping the trigram indexes loses fuzziness
 * and speed, not correctness. The trigram indexes are restored by an operator
 * after fixing the extension (the doctor probe below flags exactly this state),
 * via `REINDEX` / re-running migrations.
 */

type Db = Pick<ReturnType<typeof createDb>, "execute">;

/** pino-compatible structured logger; all fields optional so callers can pass a partial. */
export interface SearchIndexLogger {
  info?: (obj: unknown, msg?: string) => void;
  warn?: (obj: unknown, msg?: string) => void;
  error?: (obj: unknown, msg?: string) => void;
}

export const PG_TRGM_EXTENSION = "pg_trgm";

/**
 * The GIN trigram indexes maintained inline on write transactions. Names mirror the
 * migrations (0051, 0079) and the Drizzle schema. Used both for degradation (drop)
 * and to document what "degraded search" disables.
 */
export const TRIGRAM_SEARCH_INDEXES: ReadonlyArray<{
  index: string;
  table: string;
  column: string;
}> = [
  { index: "issue_comments_body_search_idx", table: "issue_comments", column: "body" },
  { index: "issues_title_search_idx", table: "issues", column: "title" },
  { index: "issues_identifier_search_idx", table: "issues", column: "identifier" },
  { index: "issues_description_search_idx", table: "issues", column: "description" },
  { index: "documents_title_search_idx", table: "documents", column: "title" },
  { index: "documents_latest_body_search_idx", table: "documents", column: "latest_body" },
  {
    index: "document_annotation_comments_body_search_idx",
    table: "document_annotation_comments",
    column: "body",
  },
];

function collectErrorMessages(error: unknown): string {
  const messages: string[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < 6 && current != null; depth++) {
    if (current instanceof Error) {
      messages.push(current.message);
      current = (current as { cause?: unknown }).cause;
      continue;
    }
    if (typeof current === "object") {
      const record = current as Record<string, unknown>;
      // postgres-js surfaces detail / hint / where alongside message.
      for (const key of ["message", "detail", "hint", "where", "internalQuery"]) {
        const value = record[key];
        if (typeof value === "string") messages.push(value);
      }
      current = record.cause;
      continue;
    }
    if (typeof current === "string") messages.push(current);
    break;
  }
  return messages.join("\n").toLowerCase();
}

/**
 * Is this error "the trigram search machinery is unavailable at runtime" rather than
 * a genuine data / constraint error? Deliberately conservative: we only degrade when
 * the error clearly points at the `pg_trgm` library or its trigram operators, so real
 * bugs (unique violations, not-null, etc.) still propagate as failures.
 */
export function isTrigramIndexUnavailableError(error: unknown): boolean {
  const haystack = collectErrorMessages(error);
  if (!haystack) return false;

  // The TON-2143 smoking gun: `could not access file "pg_trgm": No such file or directory`.
  // Match the library being un-loadable (any of the ways Postgres reports a failed dlopen).
  if (haystack.includes("pg_trgm")) {
    return (
      haystack.includes("could not access file") ||
      haystack.includes("could not load library") ||
      haystack.includes("no such file") ||
      haystack.includes("could not open") ||
      haystack.includes("cannot open shared object") ||
      haystack.includes("access file")
    );
  }

  // Trigram operator class / support functions missing or failing to resolve.
  if (
    haystack.includes("gin_trgm_ops") ||
    haystack.includes("gin_extract_value_trgm") ||
    haystack.includes("gin_extract_query_trgm") ||
    haystack.includes("show_trgm")
  ) {
    return true;
  }

  return false;
}

export interface SearchDegradationState {
  degraded: boolean;
  reason: string | null;
  since: string | null;
  droppedIndexes: string[];
}

const degradationState: SearchDegradationState = {
  degraded: false,
  reason: null,
  since: null,
  droppedIndexes: [],
};

let degradeInFlight: Promise<void> | null = null;

/** Snapshot of whether trigram search has been degraded this process. */
export function getSearchDegradation(): SearchDegradationState {
  return { ...degradationState, droppedIndexes: [...degradationState.droppedIndexes] };
}

/** Test-only: reset the process-global degradation singleton between cases. */
export function __resetSearchDegradationForTests(): void {
  degradationState.degraded = false;
  degradationState.reason = null;
  degradationState.since = null;
  degradationState.droppedIndexes = [];
  degradeInFlight = null;
}

/**
 * Idempotently enter degraded-search mode: drop the trigram GIN indexes so writes stop
 * invoking the broken `pg_trgm` library. Index names come from a fixed allowlist (never
 * user input), so the raw DDL is safe. Concurrent callers share a single in-flight drop.
 */
export function enterDegradedSearchMode(
  db: Db,
  opts: { reason: string; now: string; logger?: SearchIndexLogger },
): Promise<SearchDegradationState> {
  const snapshot = (): SearchDegradationState => getSearchDegradation();
  if (degradationState.degraded) return Promise.resolve(snapshot());
  if (degradeInFlight) return degradeInFlight.then(snapshot);

  degradeInFlight = (async () => {
    const dropped: string[] = [];
    const failed: string[] = [];
    for (const { index } of TRIGRAM_SEARCH_INDEXES) {
      try {
        await db.execute(sql.raw(`DROP INDEX IF EXISTS "${index}"`));
        dropped.push(index);
      } catch (dropError) {
        failed.push(index);
        opts.logger?.error?.(
          { err: dropError, index },
          "Failed to drop trigram index while degrading search (TON-2145)",
        );
      }
    }

    // Only claim degraded if we actually removed at least one trigram index. If EVERY drop
    // failed (e.g. lock_timeout on the required ACCESS EXCLUSIVE lock), the indexes are still
    // live — the write cannot be made non-fatal this attempt, so we must NOT record a false
    // degraded state. Leaving `degraded` false lets the next failing write retry the drop
    // (the lock contention may have cleared). (TON-2145, raised in PR #7482 review.)
    if (dropped.length === 0) {
      opts.logger?.error?.(
        { reason: opts.reason, failedIndexes: failed, since: opts.now },
        "SEARCH DEGRADE FAILED: pg_trgm unloadable AND every trigram DROP INDEX failed; " +
          "trigram indexes remain live so this write cannot complete. Will retry the drop on " +
          "the next failing write (TON-2145, incident TON-2143).",
      );
      return;
    }

    degradationState.degraded = true;
    degradationState.reason = opts.reason;
    degradationState.since = opts.now;
    degradationState.droppedIndexes = dropped;
    opts.logger?.error?.(
      { reason: opts.reason, droppedIndexes: dropped, failedIndexes: failed, since: opts.now },
      "SEARCH DEGRADED: pg_trgm unloadable at runtime; dropped trigram GIN indexes to keep " +
        "comment/document/issue writes non-fatal. Restore search by fixing the extension and " +
        "re-running migrations / REINDEX (TON-2145, see incident TON-2143).",
    );
  })().finally(() => {
    degradeInFlight = null;
  });

  return degradeInFlight.then(snapshot);
}

/**
 * Run a write whose transaction maintains trigram indexes. If it fails *because* the
 * trigram machinery is unavailable, degrade search (drop the indexes) and retry once so
 * the write completes. Any other error propagates unchanged.
 *
 * The operation MUST be re-runnable (a thunk that builds a fresh query / transaction),
 * because the first attempt's transaction is aborted by the failure.
 */
export async function withSearchIndexFallback<T>(
  db: Db,
  operation: () => Promise<T>,
  opts: { operationName: string; now?: () => string; logger?: SearchIndexLogger },
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (!isTrigramIndexUnavailableError(error)) throw error;

    const now = opts.now?.() ?? new Date().toISOString();
    opts.logger?.error?.(
      { err: error, operation: opts.operationName },
      "Trigram search-index maintenance failed on write path; degrading search and retrying " +
        "so the write is non-fatal (TON-2145)",
    );
    const degradation = await enterDegradedSearchMode(db, {
      reason: `trigram_unavailable:${opts.operationName}`,
      now,
      logger: opts.logger,
    });

    // If degradation could not remove any trigram index (every DROP failed), the indexes are
    // still live and a retry would just re-throw the same trigram error. Surface the original
    // failure honestly instead of looping or pretending the write succeeded. (TON-2145, PR
    // #7482 review.)
    if (degradation.droppedIndexes.length === 0) {
      throw error;
    }

    // At least one trigram index was dropped, so retry once. (If the write still touches a
    // table whose index could not be dropped, this re-throws and propagates — best effort.)
    return await operation();
  }
}

export interface ExtensionRuntimeHealth {
  extension: string;
  /** Present in pg_extension (CREATE EXTENSION has run). */
  installedInCatalog: boolean;
  /** The shared library actually loads / executes at runtime. */
  loadableAtRuntime: boolean;
  error?: string;
}

function rowCount(result: unknown): number {
  if (Array.isArray(result)) return result.length;
  if (result && typeof result === "object" && Array.isArray((result as { rows?: unknown[] }).rows)) {
    return (result as { rows: unknown[] }).rows.length;
  }
  return 0;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/**
 * Doctor probe: detect the dangerous "installed in catalog but not loadable at runtime"
 * state for pg_trgm — exactly the TON-2143 failure mode. Returns a structured health row;
 * `installedInCatalog && !loadableAtRuntime` is the flag operators must act on.
 */
export async function probeTrigramExtension(db: Db): Promise<ExtensionRuntimeHealth> {
  let installed = false;
  try {
    const rows = await db.execute(
      sql`SELECT 1 AS present FROM pg_extension WHERE extname = ${PG_TRGM_EXTENSION}`,
    );
    installed = rowCount(rows) > 0;
  } catch (error) {
    return {
      extension: PG_TRGM_EXTENSION,
      installedInCatalog: false,
      loadableAtRuntime: false,
      error: errorMessage(error),
    };
  }

  if (!installed) {
    return { extension: PG_TRGM_EXTENSION, installedInCatalog: false, loadableAtRuntime: false };
  }

  // Force the shared library to load by invoking a pg_trgm function. If the library is
  // unloadable this throws the same "could not access file" error seen on the write path.
  try {
    await db.execute(sql`SELECT show_trgm('healthcheck') AS probe`);
    return { extension: PG_TRGM_EXTENSION, installedInCatalog: true, loadableAtRuntime: true };
  } catch (error) {
    return {
      extension: PG_TRGM_EXTENSION,
      installedInCatalog: true,
      loadableAtRuntime: false,
      error: errorMessage(error),
    };
  }
}

export interface SearchHealthReport {
  status: "ok" | "degraded";
  extensions: ExtensionRuntimeHealth[];
  degradation: SearchDegradationState;
}

/**
 * Compose the search-subsystem health used by the doctor / health route: probe expected
 * extensions and fold in any active in-process degradation.
 */
export async function getSearchHealthReport(db: Db): Promise<SearchHealthReport> {
  const trgm = await probeTrigramExtension(db);
  const degradation = getSearchDegradation();
  const healthy =
    !degradation.degraded && (!trgm.installedInCatalog || trgm.loadableAtRuntime);
  return {
    status: healthy ? "ok" : "degraded",
    extensions: [trgm],
    degradation,
  };
}
