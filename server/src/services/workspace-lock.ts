import path from "node:path";
import { and, eq, lt, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { workspaceLocks } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";

export type WorkspaceLockHolder = {
  runId: string;
  agentId: string;
  issueId: string | null;
  cwdPath: string;
  acquiredAt: Date;
  expiresAt: Date;
};

export type AcquireWorkspaceLockInput = {
  companyId: string;
  cwdPath: string;
  runId: string;
  agentId: string;
  issueId: string | null;
  expiresAt: Date;
};

export type AcquireWorkspaceLockResult =
  | { acquired: true; lock: typeof workspaceLocks.$inferSelect; staleReclaimed: WorkspaceLockHolder | null }
  | { acquired: false; holder: WorkspaceLockHolder };

/**
 * Resolves a workspace cwd to its absolute, canonical form.
 * Two heartbeats targeting the same physical directory must produce the same key,
 * even if one passes a relative path and another an absolute one.
 */
export function normalizeWorkspaceCwd(cwd: string): string {
  if (typeof cwd !== "string" || cwd.length === 0) {
    throw new Error("normalizeWorkspaceCwd requires a non-empty string");
  }
  return path.resolve(cwd);
}

function rowToHolder(row: typeof workspaceLocks.$inferSelect): WorkspaceLockHolder {
  return {
    runId: row.runId,
    agentId: row.agentId,
    issueId: row.issueId,
    cwdPath: row.cwdPath,
    acquiredAt: row.acquiredAt,
    expiresAt: row.expiresAt,
  };
}

/**
 * Lazily reclaim any expired lock for `cwdPath`. Returns the reclaimed holder if one was deleted.
 * Emits a structured warning so the `paperclip.workspace_lock.stale_reclaim` event is visible
 * in telemetry/log dashboards.
 */
export async function sweepStaleWorkspaceLockForCwd(
  db: Db,
  cwdPath: string,
  now: Date = new Date(),
): Promise<WorkspaceLockHolder | null> {
  const reclaimed = await db
    .delete(workspaceLocks)
    .where(and(eq(workspaceLocks.cwdPath, cwdPath), lt(workspaceLocks.expiresAt, now)))
    .returning()
    .then((rows) => rows[0] ?? null);

  if (reclaimed) {
    const holder = rowToHolder(reclaimed);
    logger.warn(
      {
        event: "paperclip.workspace_lock.stale_reclaim",
        cwdPath: holder.cwdPath,
        reclaimedRunId: holder.runId,
        reclaimedAgentId: holder.agentId,
        reclaimedIssueId: holder.issueId,
        acquiredAt: holder.acquiredAt.toISOString(),
        expiredAt: holder.expiresAt.toISOString(),
        now: now.toISOString(),
      },
      "reclaimed stale workspace lock",
    );
    return holder;
  }
  return null;
}

/**
 * Try to acquire the lock for `cwdPath`. Atomic via a unique index on `cwd_path`.
 *
 * Behavior:
 *   - First, lazy-sweep any stale lock on this cwd (expires_at < now).
 *   - INSERT new lock. On UNIQUE conflict, SELECT the live holder and return acquired:false.
 *   - Caller is responsible for releasing the lock on every termination path.
 */
export async function acquireWorkspaceLock(
  db: Db,
  input: AcquireWorkspaceLockInput,
  now: Date = new Date(),
): Promise<AcquireWorkspaceLockResult> {
  const staleReclaimed = await sweepStaleWorkspaceLockForCwd(db, input.cwdPath, now);

  try {
    const inserted = await db
      .insert(workspaceLocks)
      .values({
        companyId: input.companyId,
        cwdPath: input.cwdPath,
        runId: input.runId,
        agentId: input.agentId,
        issueId: input.issueId,
        acquiredAt: now,
        expiresAt: input.expiresAt,
      })
      .returning()
      .then((rows) => rows[0] ?? null);

    if (!inserted) {
      throw new Error("workspace_locks insert returned no rows");
    }

    return { acquired: true, lock: inserted, staleReclaimed };
  } catch (err) {
    const holderRow = await db
      .select()
      .from(workspaceLocks)
      .where(eq(workspaceLocks.cwdPath, input.cwdPath))
      .then((rows) => rows[0] ?? null);

    if (!holderRow) {
      // Conflict raced with a concurrent release; surface the underlying error.
      throw err;
    }

    return { acquired: false, holder: rowToHolder(holderRow) };
  }
}

/**
 * Release the lock held by `runId`. Returns the released cwd_path so callers can
 * promote queued waiters for that path.
 */
export async function releaseWorkspaceLock(
  db: Db,
  runId: string,
): Promise<{ cwdPath: string; companyId: string } | null> {
  const released = await db
    .delete(workspaceLocks)
    .where(eq(workspaceLocks.runId, runId))
    .returning({ cwdPath: workspaceLocks.cwdPath, companyId: workspaceLocks.companyId })
    .then((rows) => rows[0] ?? null);
  return released ?? null;
}

/**
 * Test/debug helper: returns the holder for a cwd, if any.
 */
export async function getWorkspaceLockHolder(
  db: Db,
  cwdPath: string,
): Promise<WorkspaceLockHolder | null> {
  const row = await db
    .select()
    .from(workspaceLocks)
    .where(eq(workspaceLocks.cwdPath, cwdPath))
    .then((rows) => rows[0] ?? null);
  return row ? rowToHolder(row) : null;
}

/**
 * Test/debug helper: count of locks held company-wide. Useful for assertions.
 */
export async function countActiveWorkspaceLocks(db: Db): Promise<number> {
  const rows = await db.select({ n: sql<number>`count(*)` }).from(workspaceLocks);
  return Number(rows[0]?.n ?? 0);
}
