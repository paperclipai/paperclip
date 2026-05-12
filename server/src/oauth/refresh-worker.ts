import { sql } from "drizzle-orm";
import { backoffSeconds } from "./backoff.js";
import { refreshConnection, type RefreshSecretService } from "./refresh.js";
import { oauthLogger } from "./logger.js";
import type { ProviderRegistry } from "./registry.js";

// Postgres advisory lock key. Picked to be a stable, distinct constant that
// fits in signed int64 (`pg_try_advisory_xact_lock(bigint)`). Any process that
// acquires this key inside its transaction acts as the worker leader for the
// tick. We use the *transaction-scoped* variant so Postgres releases the lock
// automatically at COMMIT/ROLLBACK — session-scoped advisory locks are tied
// to the connection that took them, and postgres-js (the Drizzle driver in
// this repo, see packages/db/src/client.ts) maintains a multi-connection
// pool, so a session-scoped lock + unlock can land on different pool
// connections and leak the held lock across ticks.
const ADVISORY_LOCK_KEY = 0x074a17b4_c0bbac1en;
const BATCH_LIMIT = 100;
const TICK_INTERVAL_MS = 60_000;

export interface RefreshWorkerDeps {
  // db: Drizzle handle. Loosely typed so this module does not pull the full
  // @paperclipai/db Db type — same convention as refresh.ts and the routes.
  db: any;
  registry: ProviderRegistry;
  // Same shape as RefreshDeps.secretService — typed explicitly so a missing
  // method is a compile error instead of being silently swallowed by `any`.
  secretService: RefreshSecretService;
  // Optional injection for tests; defaults to the real refreshConnection.
  refreshFn?: typeof refreshConnection;
}

/**
 * Run a single refresh tick.
 *
 * The whole tick runs inside one Postgres transaction so the
 * `pg_try_advisory_xact_lock` we acquire stays bound to the same backend
 * connection until COMMIT/ROLLBACK auto-releases it. Do NOT replace this
 * with `pg_try_advisory_lock`/`pg_advisory_unlock` — under the postgres-js
 * pool those calls can land on different connections and leak the lock
 * across subsequent ticks (the original bug this fix targets).
 *
 * `refreshConnection` itself opens a transaction; passing `tx` from the
 * outer transaction makes Drizzle nest it as a savepoint, so a per-row
 * failure rolls back only that row's work, not the whole tick.
 *
 * Connections with NULL `accessTokenExpiresAt` are intentionally excluded:
 * they represent providers that did not return an expiry, so the worker has no
 * safe proactive refresh threshold. Lazy runtime resolution also treats NULL as
 * non-expiring. If a future provider supports refresh but omits `expires_in`,
 * add a provider `refresh.expirySeconds` default before enabling worker refresh.
 */
export async function runRefreshTick(deps: RefreshWorkerDeps): Promise<void> {
  await deps.db.transaction(async (tx: any) => {
    const lockResult = await tx.execute(
      sql`SELECT pg_try_advisory_xact_lock(${ADVISORY_LOCK_KEY}::bigint) as result`,
    );
    // postgres-js returns an iterable RowList directly; node-postgres wraps in {rows}.
    // Read both shapes so the worker is portable across drizzle drivers.
    const lockRows = Array.isArray(lockResult)
      ? lockResult
      : ((lockResult as { rows?: unknown[] }).rows ?? []);
    const acquired = Boolean(
      (lockRows[0] as { result?: unknown } | undefined)?.result,
    );
    if (!acquired) return;

    const candidates = await tx.query.oauthConnections.findMany({
      where: (
        t: any,
        { and: A, eq: E, isNotNull: NN, lt: L, sql: S }: any,
      ) =>
        A(
          E(t.status, "active"),
          NN(t.refreshTokenSecretId),
          NN(t.accessTokenExpiresAt),
          L(t.accessTokenExpiresAt, S`now() + interval '5 minutes'`),
        ),
      orderBy: (t: any, { asc: A }: any) => [A(t.accessTokenExpiresAt)],
      limit: BATCH_LIMIT,
    });

    const now = Date.now();
    const eligible = candidates.filter((row: any) => {
      if (!row.lastErrorAt) return true;
      const minRetryAt =
        row.lastErrorAt.getTime() +
        backoffSeconds(row.refreshAttemptCount) * 1000;
      return minRetryAt <= now;
    });

    const refreshFn = deps.refreshFn ?? refreshConnection;
    for (const row of eligible) {
      try {
        await refreshFn({
          connectionId: row.id,
          db: tx,
          registry: deps.registry,
          secretService: deps.secretService,
        });
      } catch (err) {
        oauthLogger.error(
          {
            connectionId: row.id,
            err: { message: (err as Error).message },
          },
          "worker refresh threw",
        );
      }
    }
    // No explicit unlock — pg_try_advisory_xact_lock releases at COMMIT/ROLLBACK.
  });
}

export function startRefreshWorker(
  deps: RefreshWorkerDeps,
): { stop: () => void } {
  let stopped = false;
  let timeout: NodeJS.Timeout;
  const tick = async () => {
    if (stopped) return;
    try {
      await runRefreshTick(deps);
    } catch (err) {
      oauthLogger.error(
        { err: { message: (err as Error).message } },
        "refresh worker tick failed",
      );
    }
    if (!stopped) timeout = setTimeout(tick, TICK_INTERVAL_MS);
  };
  timeout = setTimeout(tick, TICK_INTERVAL_MS);
  return {
    stop: () => {
      stopped = true;
      clearTimeout(timeout);
    },
  };
}
