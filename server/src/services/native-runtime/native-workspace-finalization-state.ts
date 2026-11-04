import { environmentLeases, executionWorkspaces, heartbeatRuns, issues, nativeRunFinalizations, nativeRunResults, type Db } from "@paperclipai/db";
import { and, eq, exists, sql } from "drizzle-orm";
import { remoteWorkspaceRunReferenceSchema } from "@paperclipai/shared";
import { hasRequiredWorkspaceRecovery, nativeRunHasNoWorkspaceAccess } from "../workspace-restore-recovery-state.js";
import { recordRequiredWorkspaceRestoreFailure } from "../legacy-execution-recovery.js";
import { readNativeWorkspaceSyncReference } from "./native-workspace-sync.js";
import { preparedRemoteWorkspaceSource, type WorkspaceSourceLease } from "../remote-workspace-lifecycle.js";

/** File-only recovery for setup that never reached native admission. The live
 * preparer must still own its controller; orphan repair accepts terminal runs
 * only. This records no provider result and never starts a provider turn. */
export async function preserveRemoteWorkspacePreparationFailure(db: Db, lease: WorkspaceSourceLease,
  options: { assertOwned?: () => Promise<void> } = {}) {
  const candidate = await preparedRemoteWorkspaceSource(db, lease);
  if (!candidate || candidate.run.runtimeMode !== "legacy") return null;
  // This callback renews the run on the liveness connection. Finish it before
  // locking that row; the captured owner is rechecked under the lock below.
  await options.assertOwned?.();
  return db.transaction(async tx => {
    await tx.execute(sql`select set_config('statement_timeout', '15000', true), set_config('lock_timeout', '1000', true)`);
    const [task] = await tx.select({ id: issues.id }).from(issues).where(and(
      eq(issues.companyId, lease.companyId), eq(issues.id, candidate.issueId))).for("update");
    const [run] = await tx.select().from(heartbeatRuns).where(and(
      eq(heartbeatRuns.companyId, lease.companyId), eq(heartbeatRuns.id, candidate.run.id))).for("update");
    if (!task || !run || run.runtimeMode !== "legacy" || run.runnerProfileJson?.nativeExecutionInput != null
      || options.assertOwned && (run.controllerBootId !== candidate.run.controllerBootId
        || run.controllerBootId !== null && (!run.controllerLeaseExpiresAt || run.controllerLeaseExpiresAt.getTime() <= Date.now()))
      || (!options.assertOwned && (!["failed", "cancelled", "timed_out", "interrupted"].includes(run.status)
        || run.controllerLeaseExpiresAt && run.controllerLeaseExpiresAt.getTime() > Date.now()))) return null;
    const [coordinator] = await tx.select({ id: nativeRunFinalizations.runId }).from(nativeRunFinalizations)
      .where(and(eq(nativeRunFinalizations.companyId, lease.companyId), eq(nativeRunFinalizations.runId, run.id)));
    if (coordinator) return null;
    await tx.select({ id: executionWorkspaces.id }).from(executionWorkspaces).where(and(
      eq(executionWorkspaces.companyId, lease.companyId), eq(executionWorkspaces.id, candidate.reference.workspaceId))).for("update");
    await tx.select({ id: environmentLeases.id }).from(environmentLeases).where(and(
      eq(environmentLeases.companyId, lease.companyId), eq(environmentLeases.id, lease.id))).for("update");
    const current = await preparedRemoteWorkspaceSource(tx as unknown as Db, lease);
    if (!current || current.issueId !== task.id || current.run.id !== run.id) return null;
    if (options.assertOwned && run.controllerBootId !== null
      && (!run.controllerLeaseExpiresAt || run.controllerLeaseExpiresAt.getTime() <= Date.now())) return null;
    if (hasRequiredWorkspaceRecovery(run.resultJson)) return run;
    return await recordRequiredWorkspaceRestoreFailure(tx as unknown as Db, run,
      { workspaceRestoreFailure: "restore_failed" }, current.lease);
  });
}

export async function nativeWorkspaceExportPendingForLease(db: Db, lease: WorkspaceSourceLease): Promise<boolean> {
  if (!lease.heartbeatRunId || !lease.provider || lease.provider === "local" || !lease.providerLeaseId) return false;
  if (await preparedRemoteWorkspaceSource(db, lease)) return true;
  const input = sql`${heartbeatRuns.runnerProfileJson}->'nativeExecutionInput'`;
  const [run] = await db.select({
    id: heartbeatRuns.id, companyId: heartbeatRuns.companyId, agentId: heartbeatRuns.agentId,
    issueId: heartbeatRuns.issueId, nativeIssueId: heartbeatRuns.nativeIssueId,
    runtimeMode: heartbeatRuns.runtimeMode, driverKind: heartbeatRuns.driverKind,
    reference: sql<unknown>`${heartbeatRuns.runnerProfileJson}->'nativeWorkspaceSync'`,
    observedRemoteWorkspace: sql<boolean>`${heartbeatRuns.status} = 'failed'
      and ${heartbeatRuns.runnerProfileJson}->'remoteWorkspace' is not null
      and ${heartbeatRuns.runnerProfileJson}->'remoteWorkspace' <> 'null'::jsonb
      and exists (select 1 from ${nativeRunFinalizations}
        where ${nativeRunFinalizations.companyId} = ${heartbeatRuns.companyId}
          and ${nativeRunFinalizations.runId} = ${heartbeatRuns.id}
          and ${nativeRunFinalizations.issueId} = ${heartbeatRuns.nativeIssueId}
          and ${nativeRunFinalizations.phase} = 'observed' and ${nativeRunFinalizations.resultId} is null)`,
    executionScope: sql<Record<string, unknown>>`jsonb_build_object(
      'schema', ${input}->'schema', 'binding', ${input}->'binding', 'workspace', ${input}->'workspace',
      'provider', jsonb_build_object('kind', ${input}#>'{provider,kind}'))`,
  }).from(heartbeatRuns).where(and(
    eq(heartbeatRuns.id, lease.heartbeatRunId), eq(heartbeatRuns.companyId, lease.companyId),
    eq(heartbeatRuns.runtimeMode, "native"),
  )).limit(1);
  if (run?.observedRemoteWorkspace) return true;
  if (!run || nativeRunHasNoWorkspaceAccess({ ...run, runnerProfileJson: { nativeExecutionInput: run.executionScope } })) return false;
  const reference = readNativeWorkspaceSyncReference(run.reference);
  return reference?.state === "prepared" && reference.leaseId === lease.id
    && reference.providerLeaseId === lease.providerLeaseId;
}

/**
 * An accepted result transfers recovery to the workspace finalizer. A dead
 * provider PID cannot authorize discarding its unfinished workspace suffix,
 * including the interval before physical copyback acquires its owner receipt.
 * The heartbeat's display phase and arbitrary profile JSON are not evidence.
 */
export function pendingNativeWorkspaceFinalizationCondition(db: Db) {
  return and(
    eq(heartbeatRuns.runtimeMode, "native"),
    exists(db.select({ runId: nativeRunFinalizations.runId })
      .from(nativeRunFinalizations)
      .innerJoin(nativeRunResults, and(
        eq(nativeRunResults.id, nativeRunFinalizations.resultId),
        eq(nativeRunResults.runId, nativeRunFinalizations.runId),
        eq(nativeRunResults.companyId, nativeRunFinalizations.companyId),
        eq(nativeRunResults.issueId, nativeRunFinalizations.issueId),
        eq(nativeRunResults.schemaStatus, "accepted"),
      ))
      .where(and(
        eq(nativeRunFinalizations.runId, heartbeatRuns.id),
        eq(nativeRunFinalizations.companyId, heartbeatRuns.companyId),
        eq(nativeRunFinalizations.issueId, heartbeatRuns.nativeIssueId),
        eq(nativeRunFinalizations.phase, "workspace_finalizing"),
      ))),
  )!;
}
