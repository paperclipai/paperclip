import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { environmentLeases, executionWorkspaces, heartbeatRuns, nativeRunResults, type Db } from "@paperclipai/db";
import { readRemoteWorkspaceAuthority, remoteWorkspaceRunReferenceSchema } from "@paperclipai/shared";
import { persistActivity } from "../activity-log.js";
import { hasNativeExecutionStartEvidence } from "../native-runtime/native-restart-recovery.js";
import {
  findNativePredecessorRetirementUnproven, REPLACE_BEFORE_REUSE_KEY, REPLACE_BEFORE_REUSE_SCHEMA,
  type PredecessorRetirementFallback, type ReplaceBeforeReuseMarker,
} from "../native-runtime/predecessor-retirement.js";
import { FAILED_BEFORE_PROVIDER_TURN_KEY, FAILED_BEFORE_PROVIDER_TURN_SCHEMA, findNativeFailedBeforeProviderTurn,
  readFailedBeforeProviderTurnRecord } from "../native-runtime/failed-before-provider-turn.js";
import { abandonUnverifiedRemoteWorkspaceEpoch } from "../remote-workspace-epoch-abandonment.js";
import { releaseUnchangedRemoteWorkspaceWriter } from "../remote-workspaces.js";

type Run = Pick<typeof heartbeatRuns.$inferSelect, "id" | "companyId">;

/**
 * A run failed before provider work because the previous run's warm owner on
 * its reused sandbox could not be retired. Mark each reusable lease this run
 * holds on that sandbox, so the next acquisition takes the existing
 * replacement path instead of resuming it. That path still requires a clean,
 * committed workspace save and a verified harness backup; otherwise the next
 * acquisition resumes the sandbox as before. Nothing here touches the
 * workspace: `releaseUnchangedFallbackWorkspace` settles it once the run ended.
 *
 * Returns null, changing nothing, when this run may have started provider
 * work or holds no reusable lease on that sandbox. The run then keeps today's
 * preservation and its Retry.
 */
export async function preparePredecessorRetirementFallback(db: Db, run: Run, error: unknown)
  : Promise<PredecessorRetirementFallback | null> {
  const beforeProviderTurn = findNativeFailedBeforeProviderTurn(error);
  const failure = findNativePredecessorRetirementUnproven(error) ?? beforeProviderTurn;
  if (!failure) return null;
  if (!beforeProviderTurn && await hasNativeExecutionStartEvidence(db, { companyId: run.companyId, id: run.id })) return null;
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
      beforeProviderTurn ? inArray(environmentLeases.leasePolicy, ["reuse_by_environment", "reuse_by_execution_workspace"])
        : eq(environmentLeases.leasePolicy, "reuse_by_environment"), isNotNull(environmentLeases.providerLeaseId),
    )).for("update")).filter(lease => !failure.providerLeaseId || lease.providerLeaseId === failure.providerLeaseId);
    if (leases.length === 0 && !beforeProviderTurn) return null;
    if (beforeProviderTurn) await tx.update(heartbeatRuns).set({ runnerProfileJson: sql`coalesce(${heartbeatRuns.runnerProfileJson}, '{}'::jsonb) || ${JSON.stringify({
      [FAILED_BEFORE_PROVIDER_TURN_KEY]: { schema: FAILED_BEFORE_PROVIDER_TURN_SCHEMA, cause: beforeProviderTurn.code, proof: beforeProviderTurn.proof,
        technicalCause: beforeProviderTurn.technicalCause } })}::jsonb` })
      .where(and(eq(heartbeatRuns.companyId, run.companyId), eq(heartbeatRuns.id, run.id)));
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

/**
 * After the failed run ended: hand its prepared remote workspace on at the
 * saved version, but only through the shared unchanged-files proof (no runner
 * command, workspace operation such as a provisioning command, execution event
 * or result recorded). True when nothing of this run's is left to save. False
 * keeps the workspace dirty, so the caller preserves it as today and the
 * marked sandbox is never replaced.
 */
export async function releaseUnchangedFallbackWorkspace(db: Db, run: Run): Promise<boolean> {
  const [current] = await db.select({ profile: heartbeatRuns.runnerProfileJson }).from(heartbeatRuns)
    .where(and(eq(heartbeatRuns.companyId, run.companyId), eq(heartbeatRuns.id, run.id)));
  if (!current || current.profile?.nativeWorkspaceSync != null) return false;
  if (current.profile?.remoteWorkspace == null) return true;
  const reference = remoteWorkspaceRunReferenceSchema.safeParse(current.profile.remoteWorkspace);
  if (!reference.success) return false;
  if (reference.data.state !== "prepared") return true;
  return db.transaction(async tx => {
    const [workspace] = await tx.select().from(executionWorkspaces).where(and(
      eq(executionWorkspaces.companyId, run.companyId), eq(executionWorkspaces.id, reference.data.workspaceId))).for("update");
    let authority: ReturnType<typeof readRemoteWorkspaceAuthority>;
    try { authority = readRemoteWorkspaceAuthority(workspace?.metadata); } catch { return false; }
    if (!workspace || !authority) return false;
    // Another writer took the workspace on, so another run already continues
    // the task. Do not queue a second attempt beside it.
    if (authority.writerRunId !== run.id) return false;
    // The heartbeat that owns this writer is the caller, and it started no runner.
    if (await releaseUnchangedRemoteWorkspaceWriter(tx, { workspace, authority, callerOwnsWriter: true })) return true;
    if (!readFailedBeforeProviderTurnRecord(current.profile) || !authority.location || authority.epoch !== reference.data.epoch) return false;
    const [writer] = await tx.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(and(
      eq(heartbeatRuns.companyId, run.companyId), eq(heartbeatRuns.id, run.id))).for("update", { skipLocked: true });
    if (!writer) return false;
    await tx.transaction(savepoint => abandonUnverifiedRemoteWorkspaceEpoch(savepoint, { companyId: run.companyId,
      workspaceId: workspace.id, runId: run.id, epoch: authority.epoch, snapshotId: authority.snapshotId, location: authority.location! }));
    return true;
  });
}
