/** postgres.js transient connection codes, including wrapped Drizzle errors. */
const transientDbConnectionCodes = new Set([
  "CONNECT_TIMEOUT",
  "CONNECTION_CLOSED",
  "CONNECTION_ENDED",
  "CONNECTION_DESTROYED",
]);

export function isTransientDbConnectionError(error: unknown): boolean {
  for (let current: unknown = error; current instanceof Error; current = current.cause) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string" && transientDbConnectionCodes.has(code)) return true;
  }
  return false;
}

/**
 * Retry only an explicitly idempotent operation, such as a known read-only
 * lookup or receipt-protected synchronization. Neither a SQL prefix nor a
 * connection error message proves replay safety: a disconnected write may
 * already have committed. Callers own this proof for the entire callback.
 *
 * Two replays allow for a pool-wide recycle where the first replay draws
 * another stale socket. The pauses give the driver time to replace them.
 * Persistent failures still propagate after three total attempts.
 */
export async function retryIdempotentDatabaseOperation<T>(run: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await run();
    } catch (error) {
      if (attempt >= 2 || !isTransientDbConnectionError(error)) throw error;
      await new Promise((resolve) => setTimeout(resolve, 50 * (attempt + 1)));
    }
  }
}
