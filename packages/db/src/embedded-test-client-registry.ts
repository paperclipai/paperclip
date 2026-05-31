// Registry that lets embedded-Postgres test teardown close client pools BEFORE
// stopping the server.
//
// Without this, postgres.js emits an unhandled `write CONNECTION_CLOSED`
// rejection when a stopped embedded server drops a socket that a pooled
// connection is still using (e.g. its lazy `pg_type` array-type bootstrap
// query). Vitest then fails the whole process with exit code 1 even though
// every test passed. See createDb() in client.ts and
// startEmbeddedPostgresTestDatabase() in test-embedded-postgres.ts.
//
// Inert in production: no URL is ever registered (only the embedded test
// helper calls trackTestDatabase), so registerTrackedClient() is a single
// empty-Map lookup that returns immediately and createDb() is unaffected.

// Structural type so this module stays dependency-free; postgres.js `Sql`
// clients satisfy it (and so would any other closable pool).
type ClosableClient = { end: (options?: { timeout?: number }) => Promise<void> };

const clientsByUrl = new Map<string, Set<ClosableClient>>();

/** Mark a connection string as belonging to an embedded test database. */
export function trackTestDatabase(url: string): void {
  if (!clientsByUrl.has(url)) clientsByUrl.set(url, new Set());
}

/**
 * Register a client opened against `url` if that URL is a tracked test
 * database. No-op (and no retained reference) for any non-test URL.
 */
export function registerTrackedClient(url: string, client: ClosableClient): void {
  clientsByUrl.get(url)?.add(client);
}

/**
 * Gracefully end and forget every client opened against a tracked test
 * database. Errors are swallowed — teardown is best-effort and a client may
 * already be closed.
 */
export async function endTrackedClients(url: string): Promise<void> {
  const clients = clientsByUrl.get(url);
  if (!clients) return;
  clientsByUrl.delete(url);
  await Promise.allSettled([...clients].map((client) => client.end({ timeout: 5 })));
}
