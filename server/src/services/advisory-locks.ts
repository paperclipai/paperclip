import { sql } from "drizzle-orm";
import { PAPERCLIP_LOCK_NAMESPACE, postgres } from "@paperclipai/db";
import type { Db } from "@paperclipai/db";

/**
 * Advisory-lock keyspace is global per database and shared with every other
 * tool that uses advisory locks (Rails migrations, job queues, …). The
 * two-int form with a fixed application namespace partitions Paperclip's
 * locks away from them, and `hashtext` collisions then require both ints
 * to match.
 *
 * Shared-memory footprint is bounded by locks HELD CONCURRENTLY (capped by
 * max_locks_per_transaction * max_connections), not by the space of names:
 * a transaction-scoped lock exists only while its transaction is open, and
 * open transactions are bounded by the connection pool. Per-entity names
 * (e.g. one per agent or company) are therefore fine for xact-scoped locks;
 * what must stay bounded is the number of locks held at once — never take
 * advisory locks in unbounded batches, and keep session-scoped locks
 * (which outlive transactions) to a fixed handful.
 */

/**
 * Run `fn` inside a transaction holding `pg_advisory_xact_lock` on the
 * namespaced key. Blocks until the lock is granted. Transaction scope makes
 * this safe under transaction-pooling poolers (PgBouncer) and leak-proof:
 * the lock releases on commit OR rollback, with no manual unlock to lose.
 *
 * The transaction (and therefore one pooled connection) stays open for the
 * duration of `fn` — long-running callbacks hold that pooled connection for
 * their entire duration, so keep critical sections bounded; at call sites
 * where the protected work is heavier (e.g. skill refresh), state the bound
 * in a comment. Truly long-running work (backups, migrations) belongs on
 * `trySessionAdvisoryLock` instead.
 *
 * `fn` deliberately receives nothing: the lock's transaction is a mutex
 * side-channel only, and the work inside `fn` runs its DB operations on the
 * outer pool (its own connections), not inside the lock's transaction.
 */
export async function withAdvisoryXactLock<T>(db: Db, name: string, fn: () => Promise<T>): Promise<T> {
  return await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${PAPERCLIP_LOCK_NAMESPACE}, hashtext(${name}))`);
    return await fn();
  });
}

/**
 * Non-blocking variant: if the lock is held elsewhere, returns
 * `{ acquired: false }` without running `fn`. Like `withAdvisoryXactLock`,
 * `fn` runs its DB work on the outer pool — the lock transaction is only a
 * mutex side-channel.
 */
export async function tryAdvisoryXactLock<T>(
  db: Db,
  name: string,
  fn: () => Promise<T>,
): Promise<{ acquired: false } | { acquired: true; result: T }> {
  return await db.transaction(async (tx) => {
    const rows = await tx.execute(
      sql`SELECT pg_try_advisory_xact_lock(${PAPERCLIP_LOCK_NAMESPACE}, hashtext(${name})) AS acquired`,
    );
    const acquired = Boolean((rows as unknown as Array<{ acquired: boolean }>)[0]?.acquired);
    if (!acquired) return { acquired: false } as const;
    return { acquired: true, result: await fn() } as const;
  });
}

/**
 * Session-scoped lock on a DEDICATED direct connection, for operations that
 * span multiple transactions or run external processes (migrations,
 * pg_dump backups). The lock lives exactly as long as the connection:
 * `release()` ends the connection (guaranteed release), and a crashed
 * process releases implicitly when Postgres drops the socket.
 *
 * Caveat (documented, deliberate): session locks do not survive
 * transaction-pooling poolers — this helper always dials the URL directly.
 */
export async function trySessionAdvisoryLock(
  connectionString: string,
  name: string,
): Promise<{ acquired: false } | { acquired: true; release: () => Promise<void> }> {
  const lockSql = postgres(connectionString, { max: 1, onnotice: () => {} });
  try {
    const rows = await lockSql`SELECT pg_try_advisory_lock(${PAPERCLIP_LOCK_NAMESPACE}, hashtext(${name})) AS acquired`;
    if (!rows[0]?.acquired) {
      await lockSql.end({ timeout: 5 });
      return { acquired: false };
    }
    return {
      acquired: true,
      release: async () => {
        await lockSql.end({ timeout: 5 });
      },
    };
  } catch (err) {
    await lockSql.end({ timeout: 5 }).catch(() => {});
    throw err;
  }
}
