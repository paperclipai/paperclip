/**
 * PostgreSQL advisory lock service.
 *
 * Replaces the in-memory `startLocksByAgent` Map with cluster-wide
 * Postgres advisory locks so that multiple Paperclip server processes
 * can safely coordinate heartbeat starts for the same agent.
 *
 * Uses pg_advisory_xact_lock (transaction-scoped) so locks are
 * automatically released on commit/rollback — no manual unlock needed.
 */

import type { Db } from "@paperclipai/db";
import { sql as rawSql } from "drizzle-orm";

/**
 * Converts a string identifier (e.g. agent UUID) into two 32-bit integers
 * suitable for pg_advisory_xact_lock(key1, key2).
 *
 * Using two-key form avoids collisions with other advisory lock users
 * since key1 acts as a namespace.
 */
function hashToLockKeys(namespace: number, id: string): [number, number] {
  let hash = 0;
  for (let i = 0; i < id.length; i++) {
    hash = ((hash << 5) - hash + id.charCodeAt(i)) | 0;
  }
  return [namespace, hash];
}

// Namespace constants to avoid collision with other advisory lock users.
const LOCK_NS_AGENT_START = 0x50435f41; // "PC_A" — Paperclip Agent start lock

/**
 * Runs `fn` while holding a transaction-scoped advisory lock for the
 * given agent. If another connection already holds the lock for the
 * same agent, this call blocks until that lock is released.
 *
 * Because pg_advisory_xact_lock is transaction-scoped, the lock is
 * automatically freed when the transaction commits or rolls back —
 * even if the process crashes.
 */
export async function withAgentAdvisoryLock<T>(db: Db, agentId: string, fn: () => Promise<T>): Promise<T> {
  const [ns, key] = hashToLockKeys(LOCK_NS_AGENT_START, agentId);

  return db.transaction(async (tx) => {
    // Acquire the lock — blocks until available.
    await tx.execute(rawSql`SELECT pg_advisory_xact_lock(${ns}, ${key})`);
    return fn();
  });
}

/**
 * Non-blocking variant. Returns `null` immediately if the lock is
 * already held by another session, instead of waiting.
 */
export async function tryAgentAdvisoryLock<T>(db: Db, agentId: string, fn: () => Promise<T>): Promise<T | null> {
  const [ns, key] = hashToLockKeys(LOCK_NS_AGENT_START, agentId);

  return db.transaction(async (tx) => {
    const result = await tx.execute(rawSql`SELECT pg_try_advisory_xact_lock(${ns}, ${key}) AS acquired`);
    const acquired = (result as unknown as Array<{ acquired: boolean }>)[0]?.acquired;
    if (!acquired) return null;
    return fn();
  });
}
