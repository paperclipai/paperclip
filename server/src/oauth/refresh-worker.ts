import { sql } from "drizzle-orm";
import { backoffSeconds } from "./backoff.js";
import { refreshConnection, type RefreshSecretService } from "./refresh.js";
import { buildCredentialBrokerCtx } from "./apply-credential-broker-resolver.js";
import { resolveCredentialBroker } from "../plugins/credential-broker-registry.js";
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
 */
export async function runRefreshTick(deps: RefreshWorkerDeps): Promise<void> {
  // Drained from the transaction so the BYO HTTP fan-out runs *after*
  // COMMIT — keeping 10s-per-target fetches out of the window where we
  // hold `pg_try_advisory_xact_lock` and a pooled connection. Worst-case
  // hold time was 100 rows × 8 targets × 10 s = 8 000 s before this fix.
  const pendingByoPushes: Array<{
    row: {
      id: string;
      companyId: string;
      brokerTargets?: unknown[] | null;
    };
    accessToken: string;
  }> = [];

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
    const broker = await resolveCredentialBroker(
      buildCredentialBrokerCtx({
        db: deps.db,
        registry: deps.registry,
        logger: oauthLogger,
      }),
    );
    for (const row of eligible) {
      try {
        const result = await refreshFn({
          connectionId: row.id,
          db: tx,
          registry: deps.registry,
          secretService: deps.secretService,
        });
        // After a successful rotation, push the new access token into
        // the credential broker's bearer cache so any live sessions
        // see the fresh value on their next outbound request.
        // Failures here are non-fatal — the DB write is the source of
        // truth; if the broker push fails, dispatched runs will pick up
        // the new token on the next mintSession (or via the 401-driven
        // retry path in M4).
        if (result && result.outcome === "success") {
          if (broker) {
            try {
              await broker.pushCredential({
                companyId: (row as { companyId: string }).companyId,
                connectionId: row.id,
                field: "access",
                value: result.accessToken,
              });
            } catch (pushErr) {
              oauthLogger.warn(
                {
                  connectionId: row.id,
                  err: { message: (pushErr as Error).message },
                },
                "credential-broker pushCredential failed after refresh",
              );
            }
          }
          // BYO push targets — defer the HTTP fan-out until after the
          // transaction commits so external endpoints can't hold the
          // advisory lock or starve the connection pool.
          const targets = (row as { brokerTargets?: unknown[] | null })
            .brokerTargets;
          if (targets && targets.length > 0) {
            pendingByoPushes.push({
              row: {
                id: row.id,
                companyId: (row as { companyId: string }).companyId,
                brokerTargets: targets,
              },
              accessToken: result.accessToken,
            });
          }
        }
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

  // Post-commit BYO fan-out. The advisory lock has been released and the
  // pooled connection returned, so a slow operator broker can't block the
  // next tick. Pushes remain best-effort; the DB row is source of truth.
  for (const pending of pendingByoPushes) {
    await pushToByoBrokerTargets({
      row: pending.row,
      accessToken: pending.accessToken,
      secretService: deps.secretService,
    });
  }
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

interface ByoBrokerTarget {
  id: string;
  url: string;
  authTokenSecretId: string;
  addedAt: string;
}

/**
 * Best-effort fan-out: POST the rotated access token to each registered
 * BYO broker push target. Failures log without propagating — the DB
 * row is the source of truth; operators whose brokers are temporarily
 * unreachable pick up the new value via their next mintSession path
 * or on demand from their own backoff loop.
 */
async function pushToByoBrokerTargets(input: {
  row: { id: string; companyId: string; brokerTargets?: unknown[] | null };
  accessToken: string;
  secretService: RefreshSecretService;
}): Promise<void> {
  const targets =
    (input.row.brokerTargets as ByoBrokerTarget[] | null | undefined) ?? [];
  if (targets.length === 0) return;
  for (const target of targets) {
    try {
      const authToken = await input.secretService.resolveSecretValue(
        input.row.companyId,
        target.authTokenSecretId,
        "latest",
      );
      const ctrl = new AbortController();
      const timeoutId = setTimeout(() => ctrl.abort(), 10_000);
      try {
        const response = await fetch(target.url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${authToken}`,
          },
          body: JSON.stringify({
            connectionId: input.row.id,
            field: "access",
            value: input.accessToken,
          }),
          signal: ctrl.signal,
        });
        if (!response.ok) {
          oauthLogger.warn(
            {
              connectionId: input.row.id,
              targetId: target.id,
              status: response.status,
            },
            "BYO broker target rejected push",
          );
        }
      } finally {
        clearTimeout(timeoutId);
      }
    } catch (err) {
      oauthLogger.warn(
        {
          connectionId: input.row.id,
          targetId: target.id,
          err: { message: (err as Error).message },
        },
        "BYO broker target push failed",
      );
    }
  }
}
