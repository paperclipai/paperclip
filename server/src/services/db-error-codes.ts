/**
 * Postgres SQLSTATE classification for run-failure error codes.
 *
 * Extracted into a dependency-free module (AGE-815) so both the heartbeat
 * execution path — which derives a run's `errorCode` from a thrown drizzle/pg
 * error — and the recovery service — which decides whether a *persisted* failure
 * `errorCode` is a retryable transient-infra failure — share one source of truth
 * and cannot drift. `server/src/services/heartbeat.ts` imports the recovery
 * service, so the recovery service must not import heartbeat; this module breaks
 * that cycle.
 */

function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

/** `errorCode` recorded for a drizzle query failure with no surfaced SQLSTATE. */
export const DB_QUERY_FAILED_ERROR_CODE = "db_query_failed";

/** Prefix for an `errorCode` derived from a Postgres SQLSTATE, e.g. `pg_57P01`. */
export const PG_ERROR_CODE_PREFIX = "pg_";

/** Compose the dedicated `errorCode` for a known Postgres SQLSTATE. */
export function pgErrorCode(sqlState: string): string {
  return `${PG_ERROR_CODE_PREFIX}${sqlState}`;
}

/**
 * Postgres SQLSTATEs that denote a transient / retryable failure rather than a
 * deterministic programming or data error. Class `08` (connection exception)
 * covers every connection-level drop (`08000`, `08001`, `08003`, `08004`,
 * `08006`, `08007`, ...), so match the whole class by prefix; the enumerated
 * codes are the serialization / deadlock / lock / cancellation family plus the
 * operator-intervention restarts (`57P01` admin shutdown, `57P02` crash
 * shutdown, `57P03` cannot-connect-now) that a Neon connection drop / cold-start
 * failover surfaces — exactly the AGE-810 symptom (`57P01` / `08006`).
 *
 * Deterministic classes are deliberately absent so they still fail fast: `23xxx`
 * (integrity/constraint), `42xxx` (missing object / syntax), etc.
 */
const TRANSIENT_DB_SQLSTATES = new Set<string>([
  "40001", // serialization_failure
  "40P01", // deadlock_detected
  "55P03", // lock_not_available
  "57014", // query_canceled
  "57P01", // admin_shutdown (Neon connection drop / server restart)
  "57P02", // crash_shutdown
  "57P03", // cannot_connect_now (server starting up / failover)
]);

export function isTransientDbSqlState(code: string | null | undefined): boolean {
  if (!code) return false;
  if (code.startsWith("08")) return true; // connection_exception class
  return TRANSIENT_DB_SQLSTATES.has(code);
}

/**
 * Classify a *persisted* run `errorCode` string (not a thrown error) as a
 * transient DB failure. `db_query_failed` (a drizzle wrapper with no surfaced
 * SQLSTATE) is treated conservatively as transient so it keeps the pre-AGE-815
 * `adapter_failed` continuation-recovery behaviour; `pg_<sqlstate>` is transient
 * only for the transient SQLSTATE family, so deterministic DB failures
 * (`pg_23505`, `pg_42P01`, ...) now fail fast instead of being retried.
 */
export function isTransientDbErrorCode(errorCode: string | null | undefined): boolean {
  if (!errorCode) return false;
  if (errorCode === DB_QUERY_FAILED_ERROR_CODE) return true;
  if (errorCode.startsWith(PG_ERROR_CODE_PREFIX)) {
    return isTransientDbSqlState(errorCode.slice(PG_ERROR_CODE_PREFIX.length));
  }
  return false;
}

/**
 * Detect drizzle's `DrizzleQueryError` without importing drizzle internals:
 * it carries `name === "DrizzleQueryError"` and a `Failed query:` message prefix.
 */
function isDrizzleQueryError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  if ((err as { name?: unknown }).name === "DrizzleQueryError") return true;
  const message = (err as { message?: unknown }).message;
  return typeof message === "string" && message.startsWith("Failed query:");
}

/**
 * Unwrap drizzle's `DrizzleQueryError` to the underlying driver error.
 *
 * Drizzle wraps every failed query in a `DrizzleQueryError` whose `.message` is
 * only `Failed query: <sql>\nparams: <params>` and whose underlying driver error
 * (Postgres SQLSTATE `code` / `detail`, connection reset, admin shutdown, etc.)
 * is carried on `.cause`. Return the cause's message + SQLSTATE code + detail so
 * callers can both compose a diagnosable message and derive a dedicated error
 * code instead of discarding the real root cause.
 */
export function unwrapDbErrorCause(
  err: unknown,
): { message: string | null; code: string | null; detail: string | null } | null {
  const cause = (err as { cause?: unknown } | null | undefined)?.cause;
  if (!cause || cause === err) return null;
  const message = cause instanceof Error ? cause.message : readNonEmptyString(cause);
  const rawCode = (cause as { code?: unknown } | null | undefined)?.code;
  const rawDetail = (cause as { detail?: unknown } | null | undefined)?.detail;
  const code = typeof rawCode === "string" && rawCode ? rawCode : null;
  const detail = typeof rawDetail === "string" && rawDetail ? rawDetail : null;
  if (!message && !code && !detail) return null;
  return { message, code, detail };
}

/**
 * Dedicated `errorCode` for a DB-driver failure so it is not swallowed by the
 * generic `adapter_failed` / `setup_failed` bucket. `pg_<sqlstate>` when the
 * Postgres error code is known, else `db_query_failed` for a drizzle query
 * wrapper with no surfaced code. Returns `null` for non-DB errors so callers
 * fall back to their existing default.
 */
export function readDbFailureErrorCode(err: unknown): string | null {
  const cause = unwrapDbErrorCause(err);
  if (cause?.code) return pgErrorCode(cause.code);
  if (isDrizzleQueryError(err)) return DB_QUERY_FAILED_ERROR_CODE;
  return null;
}

/** True when a thrown error is a DB failure with a transient SQLSTATE. */
export function isTransientDbFailure(err: unknown): boolean {
  return isTransientDbSqlState(unwrapDbErrorCause(err)?.code);
}

/**
 * Produce a diagnosable message for a thrown run failure, appending the drizzle
 * cause chain (Postgres error code/detail when present) so intermittent DB
 * failures can be attributed instead of guessed at. See {@link unwrapDbErrorCause}.
 */
export function describeRunFailureError(err: unknown, fallback: string): string {
  const base = err instanceof Error ? err.message : readNonEmptyString(err);
  if (!base) return fallback;
  const cause = unwrapDbErrorCause(err);
  if (!cause) return base;

  const parts = [
    cause.message ?? undefined,
    cause.code ? `code=${cause.code}` : undefined,
    cause.detail ? `detail=${cause.detail}` : undefined,
  ].filter((part): part is string => Boolean(part));
  const causeText = parts.join(" ");
  if (!causeText || base.includes(causeText)) return base;
  return `${base} [cause: ${causeText}]`;
}
