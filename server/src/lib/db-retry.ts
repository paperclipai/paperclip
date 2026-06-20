// Retry a DB operation that failed with a *transient* Postgres error
// (serialization failure, deadlock, connection blip). These errors mean the
// transaction rolled back without committing, so re-running the operation is
// safe — no partial write to reconcile. Non-transient errors (unique violation,
// constraint, validation) are re-thrown immediately so callers handle them.
//
// Motivation: agents that hit a transient 5xx on a write used to blind-bisect
// their payload, re-sending the growing transcript every turn at full token
// cost. Absorbing the blip here means the agent never sees it.

// Postgres SQLSTATE codes treated as transient + retryable.
const TRANSIENT_PG_CODES = new Set<string>([
  "40001", // serialization_failure
  "40P01", // deadlock_detected
  "08000", // connection_exception
  "08003", // connection_does_not_exist
  "08006", // connection_failure
  "08001", // sqlclient_unable_to_establish_sqlconnection
  "08004", // sqlserver_rejected_establishment_of_sqlconnection
  "57P01", // admin_shutdown
]);

// Node socket-level error codes that also indicate a transient connection drop.
const TRANSIENT_NODE_CODES = new Set<string>(["ECONNRESET", "EPIPE", "ETIMEDOUT", "ECONNREFUSED"]);

export function isTransientDbError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const code = (error as { code?: unknown }).code;
  if (typeof code !== "string") return false;
  return TRANSIENT_PG_CODES.has(code) || TRANSIENT_NODE_CODES.has(code);
}

export interface TransientRetryOptions {
  maxAttempts?: number;
  // Base backoff in ms; actual delay is baseDelayMs * attempt (linear).
  baseDelayMs?: number;
}

export async function withTransientRetry<T>(
  fn: () => Promise<T>,
  options: TransientRetryOptions = {},
): Promise<T> {
  const maxAttempts = options.maxAttempts ?? 3;
  const baseDelayMs = options.baseDelayMs ?? 25;
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (attempt >= maxAttempts || !isTransientDbError(error)) throw error;
      await new Promise((resolve) => setTimeout(resolve, baseDelayMs * attempt));
    }
  }
  throw lastError;
}
