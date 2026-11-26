import { and, eq, ne, sql } from "drizzle-orm";
import { environmentLeases, type Db } from "@paperclipai/db";
import type { EnvironmentLease } from "@paperclipai/shared";
import { logger } from "../middleware/logger.js";
import { supersedeReusableSandboxLease } from "./environment-lease-handoff.js";

/**
 * Takes a reused sandbox whose disk is full out of reuse for this workspace.
 *
 * An earlier run on the same sandbox can leave it full (its own files, a save
 * that could not finish). Every later run that resumes it fails the same way,
 * so the task never recovers. A sandbox made for this run has nothing of an
 * earlier run; a new one has the same disk, so this returns false for it and
 * the refusal stays with the board.
 *
 * It never throws: a failed write keeps the restore's own refusal.
 */
export async function retireFullReusableSandbox(db: Db, lease: EnvironmentLease, runId: string): Promise<boolean> {
  if (lease.leasePolicy !== "reuse_by_environment" || !lease.providerLeaseId || lease.heartbeatRunId !== runId) return false;
  try {
    const [earlier] = await db.select({ id: environmentLeases.id }).from(environmentLeases).where(and(
      eq(environmentLeases.companyId, lease.companyId),
      eq(environmentLeases.providerLeaseId, lease.providerLeaseId),
      ne(environmentLeases.id, lease.id),
      sql`${environmentLeases.provider} is not distinct from ${lease.provider ?? null}`,
    )).limit(1);
    if (!earlier) return false;
    const [current] = await db.select().from(environmentLeases)
      .where(and(eq(environmentLeases.id, lease.id), eq(environmentLeases.companyId, lease.companyId)));
    if (!current || current.status !== "active" || current.heartbeatRunId !== runId || !current.metadata?.reusableSandboxLease) return false;
    return await supersedeReusableSandboxLease(db, current, { reason: "sandbox_disk_full", supersededByRunId: runId });
  } catch (error) {
    logger.warn({ err: error, runId, leaseId: lease.id }, "Could not take a full reused sandbox out of reuse; the restore refusal stands");
    return false;
  }
}
