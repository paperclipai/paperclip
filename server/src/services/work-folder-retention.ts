import { createHash } from "node:crypto";
import { and, desc, eq, sql } from "drizzle-orm";
import { environmentLeases, workFolderRuns, type Db } from "@paperclipai/db";

export function workFolderSandboxKey(lease: { id: string; companyId: string; environmentId: string | null; provider: string | null; providerLeaseId: string | null }) {
  return lease.providerLeaseId ? createHash("sha256").update(JSON.stringify([lease.companyId, lease.environmentId, lease.provider, lease.providerLeaseId])).digest("hex") : lease.id;
}

/** A periodic checkpoint is not permission to discard edits made after it. */
export async function retainUnsavedWorkFolderLease(db: Db, lease: { id: string; companyId: string }) {
  const [row] = await db.select().from(environmentLeases).where(and(eq(environmentLeases.id, lease.id), eq(environmentLeases.companyId, lease.companyId)));
  if (!row) return false;
  const sandboxKey = workFolderSandboxKey(row);
  const [run] = await db.select({ manifest: workFolderRuns.manifest, state: workFolderRuns.state })
    .from(workFolderRuns).where(and(eq(workFolderRuns.companyId, lease.companyId),
      sql`(${workFolderRuns.manifest}->>'sandboxKey' = ${sandboxKey} or ${workFolderRuns.manifest}->>'leaseId' = ${lease.id})`))
    .orderBy(desc(workFolderRuns.updatedAt)).limit(1);
  if (!run || (run.state === "saved" && run.manifest.finalCheckpointAt)) return false;
  await db.update(environmentLeases).set({ status: "retained", expiresAt: null,
    failureReason: "work_folder_save_required", cleanupStatus: "failed",
    metadata: sql`coalesce(${environmentLeases.metadata}, '{}'::jsonb) || '{"workFolderRecoveryRequired":true}'::jsonb`,
  }).where(and(eq(environmentLeases.id, lease.id), eq(environmentLeases.companyId, lease.companyId)));
  return true;
}
