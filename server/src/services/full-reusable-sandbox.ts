import { and, eq, ne, sql } from "drizzle-orm";
import { environmentLeases, type Db } from "@paperclipai/db";
import type { EnvironmentLease } from "@paperclipai/shared";
import { SUPERSEDED_REUSABLE_SANDBOX_KEY } from "./native-runtime/native-retired-backup-source.js";

/** A restore refusal whose reason is a full sandbox disk, at any restore stage. */
export function isRestoreSandboxDiskFullRefusal(error: unknown): boolean {
  return error instanceof Error && /; remote_workspace_restore_failed: stage=[a-z_]+ reason=sandbox_disk_full$/.test(error.message);
}

/**
 * Takes a reused sandbox whose disk is full out of reuse for this workspace.
 *
 * An earlier run on the same sandbox can leave it full (its own files, a save
 * that could not finish). Every later run that resumes it fails the same way,
 * so the task never recovers. A sandbox made for this run has nothing of an
 * earlier run; a new one has the same disk, so this returns false for it and
 * the refusal stays with the board.
 *
 * Removing the reuse scope makes the next acquisition treat the sandbox as
 * obsolete. The existing obsolete-lease path cleans it up and keeps every
 * protection (pending export, parked abandoned files, recovery holds). The
 * write is a compare-and-swap on this run's own active row.
 */
export async function retireFullReusableSandbox(db: Db, lease: EnvironmentLease, runId: string): Promise<boolean> {
  if (lease.leasePolicy !== "reuse_by_environment" || !lease.providerLeaseId || lease.heartbeatRunId !== runId) return false;
  const [earlier] = await db.select({ id: environmentLeases.id }).from(environmentLeases).where(and(
    eq(environmentLeases.companyId, lease.companyId),
    eq(environmentLeases.providerLeaseId, lease.providerLeaseId),
    ne(environmentLeases.id, lease.id),
    sql`${environmentLeases.provider} is not distinct from ${lease.provider ?? null}`,
  )).limit(1);
  if (!earlier) return false;
  const [current] = await db.select({ metadata: environmentLeases.metadata }).from(environmentLeases)
    .where(and(eq(environmentLeases.id, lease.id), eq(environmentLeases.companyId, lease.companyId)));
  if (!current?.metadata?.reusableSandboxLease) return false;
  const { reusableSandboxLease: scope, ...metadata } = current.metadata;
  const [claimed] = await db.update(environmentLeases).set({
    metadata: { ...metadata, [SUPERSEDED_REUSABLE_SANDBOX_KEY]: {
      schema: "paperclip.reusable-sandbox-lease-superseded.v1", reason: "sandbox_disk_full",
      supersededByRunId: runId, supersededByProviderLeaseId: null, reusableSandboxLease: scope,
      supersededAt: new Date().toISOString(),
    } },
    updatedAt: new Date(),
  }).where(and(
    eq(environmentLeases.id, lease.id), eq(environmentLeases.companyId, lease.companyId),
    eq(environmentLeases.status, "active"), eq(environmentLeases.heartbeatRunId, runId),
    eq(environmentLeases.leasePolicy, "reuse_by_environment"),
    sql`${environmentLeases.metadata} = ${JSON.stringify(current.metadata)}::jsonb`,
  )).returning({ id: environmentLeases.id });
  return Boolean(claimed);
}
