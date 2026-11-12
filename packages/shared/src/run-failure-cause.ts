/**
 * `resultJson.failureCause` on a failed heartbeat run: a short code that says
 * why a run with a generic error code (such as `adapter_failed`) failed, for
 * example a SQLSTATE (`40001`), a transport code (`ECONNRESET`), a provider
 * status (`provider_http_429`) or an error class name.
 *
 * The shape is closed and bounded: one identifier token of at most 80
 * characters. It never carries message text, SQL, prompts, paths or secrets.
 * Rows written before the field existed have no cause and read as `null`.
 */
export const RUN_FAILURE_CAUSE_MAX_LENGTH = 80;
export const RUN_FAILURE_CAUSE_PATTERN = /^[A-Za-z0-9_.:-]{1,80}$/;

/** The stored cause when it has the closed shape, else `null` (absent, legacy or malformed). */
export function normalizeRunFailureCause(value: unknown): string | null {
  return typeof value === "string" && RUN_FAILURE_CAUSE_PATTERN.test(value) ? value : null;
}

/** `resultJson.failureCause` from a run's stored result, validated. */
export function readRunFailureCause(resultJson: unknown): string | null {
  if (typeof resultJson !== "object" || resultJson === null || Array.isArray(resultJson)) return null;
  return normalizeRunFailureCause((resultJson as Record<string, unknown>).failureCause);
}

// Drizzle wraps a failed statement as "Failed query: <sql>\nparams: <args>".
const FAILED_QUERY_MARKER = /\bFailed query:/i;
// Unwrapped statement text: a parameter placeholder plus a statement shape.
const SQL_PLACEHOLDER = /\$\d+\b/;
const SQL_STATEMENT = /\b(?:select\b[\s\S]*?\bfrom\b|insert\s+into\b|update\b[\s\S]*?\bset\b|delete\s+from\b|with\b[\s\S]*?\bas\s*\()/i;

/**
 * Run error text for the board with any SQL statement and its parameters
 * removed. Text before the statement (the caller's own wrapper) is kept and the
 * statement is replaced by "Database query failed (<cause>)". Text without SQL
 * is returned unchanged.
 */
export function withoutSqlStatementText(message: string, cause?: string | null): string {
  let start = message.search(FAILED_QUERY_MARKER);
  if (start < 0 && SQL_PLACEHOLDER.test(message)) start = SQL_STATEMENT.exec(message)?.index ?? -1;
  if (start < 0) return message;
  const prefix = message.slice(0, start).replace(/[\s:;,-]+$/, "").trim();
  const safeCause = normalizeRunFailureCause(cause);
  const replacement = `Database query failed${safeCause ? ` (${safeCause})` : ""}`;
  return prefix ? `${prefix}: ${replacement}` : replacement;
}
