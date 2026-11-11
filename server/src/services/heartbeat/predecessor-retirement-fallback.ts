import { and, eq, isNotNull, sql } from "drizzle-orm";
import { environmentLeases, executionWorkspaces, heartbeatRuns, nativeRunResults, type Db } from "@paperclipai/db";
import { readRemoteWorkspaceAuthority, remoteWorkspaceRunReferenceSchema } from "@paperclipai/shared";
import { persistActivity } from "../activity-log.js";
import { hasNativeExecutionStartEvidence } from "../native-runtime/native-restart-recovery.js";
import {
  findNativePredecessorRetirementUnproven, REPLACE_BEFORE_REUSE_KEY, REPLACE_BEFORE_REUSE_SCHEMA,
  type ReplaceBeforeReuseMarker,
} from "../native-runtime/predecessor-retirement.js";
import { abandonUnverifiedRemoteWorkspaceEpoch } from "../remote-workspace-epoch-abandonment.js";

/** Durable record on a run whose next attempt drops its reused sandbox. */
export const PREDECESSOR_RETIREMENT_FALLBACK_KEY = "predecessorRetirementFallback";

export type PredecessorRetirementFallback = {
  version: 1;
  providerWorkStarted: false;
  predecessorRunId: string | null;
  replacedProviderLeaseIds: string[];
};

type Run = Pick<typeof heartbeatRuns.$inferSelect, "id" | "companyId">;

/**
 * A run failed before provider work because the previous run's warm owner on
 * its reused sandbox could not be retired. Prepare the next attempt to start on
 * a fresh sandbox instead of failing the task:
 *
 * - each reusable lease this run holds on that sandbox is marked, so the next
 *   acquisition takes the existing replacement path (it still requires a clean,
 *   committed workspace save and a verified harness backup, and otherwise
 *   resumes as before);
 * - this run's prepared workspace epoch is ended without applying it. The run
 *   did no provider work, so the last committed save is its content.
 *
 * Returns null, changing nothing, when this run may have started provider
 * work, holds no reusable lease on that sandbox, or holds a workspace writer
 * this run cannot prove it never wrote. The run then keeps today's
 * preservation and its Retry.
 */
export async function preparePredecessorRetirementFallback(db: Db, run: Run, error: unknown)
  : Promise<PredecessorRetirementFallback | null> {
  const failure = findNativePredecessorRetirementUnproven(error);
  if (!failure) return null;
  if (await hasNativeExecutionStartEvidence(db, { companyId: run.companyId, id: run.id })) return null;
  const [result] = await db.select({ id: nativeRunResults.id }).from(nativeRunResults)
    .where(and(eq(nativeRunResults.companyId, run.companyId), eq(nativeRunResults.runId, run.id))).limit(1);
  if (result) return null;
  return db.transaction(async tx => {
    const [current] = await tx.select().from(heartbeatRuns)
      .where(and(eq(heartbeatRuns.companyId, run.companyId), eq(heartbeatRuns.id, run.id))).for("update");
    // The native executor may already have settled the run as a terminal failure.
    if (!current || !["running", "failed"].includes(current.status) || current.runnerProfileJson?.nativeWorkspaceSync != null) return null;
    const leases = (await tx.select().from(environmentLeases).where(and(
      eq(environmentLeases.companyId, run.companyId), eq(environmentLeases.heartbeatRunId, run.id),
      eq(environmentLeases.leasePolicy, "reuse_by_environment"), isNotNull(environmentLeases.providerLeaseId),
    )).for("update")).filter(lease => !failure.providerLeaseId || lease.providerLeaseId === failure.providerLeaseId);
    if (leases.length === 0) return null;

    const reference = remoteWorkspaceRunReferenceSchema.safeParse(current.runnerProfileJson?.remoteWorkspace);
    if (reference.success && reference.data.state === "prepared") {
      const [workspace] = await tx.select({ metadata: executionWorkspaces.metadata }).from(executionWorkspaces).where(and(
        eq(executionWorkspaces.companyId, run.companyId), eq(executionWorkspaces.id, reference.data.workspaceId)));
      let authority: ReturnType<typeof readRemoteWorkspaceAuthority>;
      try { authority = readRemoteWorkspaceAuthority(workspace?.metadata); } catch { return null; }
      if (authority?.writerRunId === run.id) {
        if (!authority.location || authority.epoch !== reference.data.epoch) return null;
        await abandonUnverifiedRemoteWorkspaceEpoch(tx, { companyId: run.companyId, workspaceId: reference.data.workspaceId,
          runId: run.id, epoch: authority.epoch, snapshotId: authority.snapshotId, location: authority.location });
      } else if (authority?.dirty) {
        return null;
      }
    }

    const marker: ReplaceBeforeReuseMarker = { schema: REPLACE_BEFORE_REUSE_SCHEMA, runId: run.id,
      predecessorRunId: failure.predecessorRunId, recordedAt: new Date().toISOString() };
    for (const lease of leases) {
      await tx.update(environmentLeases).set({
        metadata: sql`coalesce(${environmentLeases.metadata}, '{}'::jsonb) || ${JSON.stringify({ [REPLACE_BEFORE_REUSE_KEY]: marker })}::jsonb`,
        updatedAt: new Date(),
      }).where(and(eq(environmentLeases.id, lease.id), eq(environmentLeases.companyId, run.companyId)));
    }
    const replacedProviderLeaseIds = leases.map(lease => lease.providerLeaseId!);
    await persistActivity(tx as unknown as Db, { companyId: run.companyId, actorType: "system", actorId: "native-runtime",
      action: "environment.lease_replacement_requested", entityType: "heartbeat_run", entityId: run.id, runId: run.id,
      details: { reason: failure.code, predecessorRunId: failure.predecessorRunId, providerLeaseIds: replacedProviderLeaseIds } });
    return { version: 1 as const, providerWorkStarted: false as const, predecessorRunId: failure.predecessorRunId,
      replacedProviderLeaseIds };
  });
}

export function readPredecessorRetirementFallback(resultJson: unknown): PredecessorRetirementFallback | null {
  if (typeof resultJson !== "object" || resultJson === null) return null;
  const value = (resultJson as Record<string, unknown>)[PREDECESSOR_RETIREMENT_FALLBACK_KEY];
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  return record.version === 1 && record.providerWorkStarted === false ? record as PredecessorRetirementFallback : null;
}
