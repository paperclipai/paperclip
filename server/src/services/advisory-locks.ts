import { sql } from "drizzle-orm";
import { postgres } from "@paperclipai/db";
import type { Db } from "@paperclipai/db";

/**
 * Advisory-lock keyspace is global per database and shared with every other
 * tool that uses advisory locks (Rails migrations, job queues, …). The
 * two-int form with a fixed application namespace partitions Paperclip's
 * locks away from them, and `hashtext` collisions then require both ints
 * to match. Key cardinality must stay low (locks live in shared memory,
 * bounded by max_locks_per_transaction * max_connections) — lock names are
 * coordination points (a handful), never per-row keys.
 */
const PAPERCLIP_LOCK_NAMESPACE = 0x70_63_6c_70; // "pclp"

/**
 * Run `fn` inside a transaction holding `pg_advisory_xact_lock` on the
 * namespaced key. Blocks until the lock is granted. Transaction scope makes
 * this safe under transaction-pooling poolers (PgBouncer) and leak-proof:
 * the lock releases on commit OR rollback, with no manual unlock to lose.
 *
 * The transaction (and therefore one pooled connection) stays open for the
 * duration of `fn` — keep critical sections short; long-running work
 * (backups, migrations) belongs on `trySessionAdvisoryLock` instead.
 */
export async function withAdvisoryXactLock<T>(db: Db, name: string, fn: (tx: unknown) => Promise<T>): Promise<T> {
  return await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${PAPERCLIP_LOCK_NAMESPACE}, hashtext(${name}))`);
    return await fn(tx);
  });
}

/**
 * Non-blocking variant: if the lock is held elsewhere, returns
 * `{ acquired: false }` without running `fn`.
 */
export async function tryAdvisoryXactLock<T>(
  db: Db,
  name: string,
  fn: (tx: unknown) => Promise<T>,
): Promise<{ acquired: false } | { acquired: true; result: T }> {
  return await db.transaction(async (tx) => {
    const rows = await tx.execute(
      sql`SELECT pg_try_advisory_xact_lock(${PAPERCLIP_LOCK_NAMESPACE}, hashtext(${name})) AS acquired`,
    );
    const acquired = Boolean((rows as Array<{ acquired: boolean }>)[0]?.acquired);
    if (!acquired) return { acquired: false } as const;
    return { acquired: true, result: await fn(tx) } as const;
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
