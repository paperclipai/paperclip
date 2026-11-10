import { ACCOUNTING_CONTENTION_CODE, ACCOUNTING_CONTENTION_MESSAGE, isAccountingContentionError } from "./accounting-transaction.js";

/** A database error's text carries its full statement and parameters. A run
 * failure shows a bounded cause instead; the server log keeps the SQLSTATE. */
export interface BoundedDatabaseFailure {
  message: string;
  /** Run error code when the failure has a dedicated one. */
  errorCode: string | null;
  sqlState: string | null;
  /** PostgreSQL's own message for that SQLSTATE (no statement text), for logs. */
  databaseMessage: string | null;
}

const SQLSTATE = /^[0-9A-Z]{5}$/;

/** The innermost PostgreSQL error in an error and at most five causes. */
function databaseCause(error: unknown): { sqlState: string; message: string | null } | null {
  let current = error, sqlState: string | null = null, message: string | null = null;
  for (let depth = 0; current && typeof current === "object" && depth < 6; depth++) {
    const row = current as { code?: unknown; message?: unknown; name?: unknown; cause?: unknown };
    if (typeof row.code === "string" && SQLSTATE.test(row.code)) {
      sqlState = row.code;
      if (row.name === "PostgresError" && typeof row.message === "string") message = row.message.slice(0, 200);
    }
    current = row.cause;
  }
  return sqlState ? { sqlState, message } : null;
}

export function databaseSqlState(error: unknown): string | null {
  return databaseCause(error)?.sqlState ?? null;
}

/** Only the thrown error's own text: a cause's SQL is never shown, and an
 * adapter failure that merely wraps a query error keeps its own message. */
function isRawQueryFailure(error: Error) {
  return error.name === "DrizzleQueryError" || error.message.startsWith("Failed query:");
}

export function boundedDatabaseFailure(error: unknown): BoundedDatabaseFailure | null {
  const cause = databaseCause(error), sqlState = cause?.sqlState ?? null, databaseMessage = cause?.message ?? null;
  if (isAccountingContentionError(error))
    return { message: ACCOUNTING_CONTENTION_MESSAGE, errorCode: ACCOUNTING_CONTENTION_CODE, sqlState, databaseMessage };
  if (!(error instanceof Error) || !isRawQueryFailure(error)) return null;
  return {
    message: `A database operation failed${sqlState ? ` (SQLSTATE ${sqlState})` : ""}, so this run stopped before `
      + "it could record its work. Retry the run.",
    errorCode: null,
    sqlState,
    databaseMessage,
  };
}
