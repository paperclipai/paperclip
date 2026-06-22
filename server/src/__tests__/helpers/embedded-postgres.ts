export {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
  type EmbeddedPostgresTestDatabase,
  type EmbeddedPostgresTestSupport,
} from "@paperclipai/db";

type DbWithClient = {
  $client?: { end?: (options?: { timeout?: number }) => Promise<unknown> } | undefined;
};

/**
 * Gracefully close a postgres-js client created by createDb() in a test.
 *
 * Always call this in afterAll BEFORE EmbeddedPostgresTestDatabase.cleanup()
 * (which stops the embedded server process). The heartbeat service dispatches
 * detached `void executeRun(...)` queries that can still be settling when a test
 * body resolves; force-destroying the socket (end({ timeout: 0 }), or stopping
 * the server with the client still attached) makes those detached queries reject
 * with a flaky "write CONNECTION_ENDED/CONNECTION_DESTROYED 127.0.0.1:<port>".
 * A bounded graceful timeout lets pending queries drain first.
 *
 * For suites that drive the heartbeat loop, also call `await heartbeat.drain()`
 * (per service instance) before this so in-flight executions finish first.
 */
export async function closeDbClient(db: DbWithClient | undefined | null): Promise<void> {
  await db?.$client?.end?.({ timeout: 5 });
}
