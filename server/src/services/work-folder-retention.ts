import { createHash } from "node:crypto";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { environmentLeases, workFolderRuns, type Db } from "@paperclipai/db";

export function workFolderSandboxKey(lease: { id: string; companyId: string; environmentId: string | null; provider: string | null; providerLeaseId: string | null }) {
  return lease.providerLeaseId ? createHash("sha256").update(JSON.stringify([lease.companyId, lease.environmentId, lease.provider, lease.providerLeaseId])).digest("hex") : lease.id;
}

/**
 * True means this physical resource must not be torn down by the caller.
 * A transferred old lease is protected without mutating or resurrecting its row.
 * A periodic checkpoint is not permission to discard edits made after it.
 */
export async function retainUnsavedWorkFolderLease(db: Db, lease: { id: string; companyId: string }) {
  const [row] = await db.select().from(environmentLeases).where(and(eq(environmentLeases.id, lease.id), eq(environmentLeases.companyId, lease.companyId)));
  if (!row) return false;
  // This old row no longer owns the physical resource. Protect it from stale
  // teardown callers without resurrecting the retired lease or changing its owner.
  if (row.metadata?.reusableLeaseReplacedByRunId) return true;
  const sandboxKey = workFolderSandboxKey(row);
  const [run] = await db.select({ manifest: workFolderRuns.manifest, state: workFolderRuns.state })
    .from(workFolderRuns).where(and(eq(workFolderRuns.companyId, lease.companyId),
      sql`(${workFolderRuns.manifest}->>'sandboxKey' = ${sandboxKey} or ${workFolderRuns.manifest}->>'leaseId' = ${lease.id})`))
    .orderBy(desc(workFolderRuns.updatedAt)).limit(1);
  if (!run || (run.state === "saved" && run.manifest.finalCheckpointAt)) return false;
  await db.update(environmentLeases).set({ status: "retained", expiresAt: null,
    failureReason: "work_folder_save_required", cleanupStatus: "failed",
    metadata: sql`coalesce(${environmentLeases.metadata}, '{}'::jsonb) || '{"workFolderRecoveryRequired":true}'::jsonb`,
  }).where(and(eq(environmentLeases.id, lease.id), eq(environmentLeases.companyId, lease.companyId),
    inArray(environmentLeases.status, ["active", "released", "retained", "failed", "pending_cleanup", "expired"]),
    sql`not (coalesce(${environmentLeases.metadata}, '{}'::jsonb) ? 'reusableLeaseReplacedByRunId')`,
    sql`${environmentLeases.heartbeatRunId} is not distinct from ${row.heartbeatRunId}`,
  )).returning({ id: environmentLeases.id });
  // Losing the conditional update can mean a new owner won the handoff.
  // The unsaved resource is still protected; never authorize stale teardown.
  return true;
}
