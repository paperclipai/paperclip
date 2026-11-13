import { environmentLeases, executionWorkspaces, heartbeatRuns, issues, nativeRunFinalizations, nativeRunResults, type Db } from "@paperclipai/db";
import { and, eq, exists, sql } from "drizzle-orm";
import { hasRequiredWorkspaceRecovery, nativeRunHasNoWorkspaceAccess } from "../workspace-restore-recovery-state.js";
import { recordRequiredWorkspaceRestoreFailure } from "../legacy-execution-recovery.js";
import { readNativeWorkspaceSyncReference } from "./native-workspace-sync.js";
import { abandonedWorkspaceFilesHeldOnLease } from "../remote-workspace-abandoned-files-hold.js";
import { matchPreparedRemoteWorkspaceSource, preparedRemoteWorkspaceSource, type WorkspaceSourceLease } from "../remote-workspace-lifecycle.js";

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

function nativeWorkspaceRunProjection() {
  const input = sql`${heartbeatRuns.runnerProfileJson}->'nativeExecutionInput'`;
  return {
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
      'provider', jsonb_build_object('kind', ${input}#>'{provider,kind}', 'bridgeRevision', ${input}#>'{provider,bridgeRevision}'))`,
    controllerBootId: heartbeatRuns.controllerBootId,
    contextIssueId: sql<string | null>`${heartbeatRuns.contextSnapshot}->>'issueId'`,
    remoteReference: sql<unknown>`${heartbeatRuns.runnerProfileJson}->'remoteWorkspace'`,
  };
}

function nativeWorkspaceSourcePending(run: Pick<typeof heartbeatRuns.$inferSelect,
  "id" | "companyId" | "agentId" | "issueId" | "nativeIssueId" | "runtimeMode" | "driverKind"> & {
    reference: unknown; executionScope: Record<string, unknown>; observedRemoteWorkspace: boolean;
  }, lease: WorkspaceSourceLease) {
  if (run.runtimeMode !== "native") return false;
  if (run.observedRemoteWorkspace) return true;
  if (nativeRunHasNoWorkspaceAccess({ ...run, runnerProfileJson: { nativeExecutionInput: run.executionScope } })) return false;
  const reference = readNativeWorkspaceSyncReference(run.reference);
  return reference?.state === "prepared" && reference.leaseId === lease.id
    && reference.providerLeaseId === lease.providerLeaseId;
}

export async function nativeWorkspaceExportPendingForLease(db: Db, lease: WorkspaceSourceLease,
  options: { destructive?: boolean } = {}): Promise<boolean> {
  if (!lease.provider || lease.provider === "local" || !lease.providerLeaseId) return false;
  const held = () => options.destructive === false ? Promise.resolve(false) : abandonedWorkspaceFilesHeldOnLease(db, lease);
  if (!lease.heartbeatRunId) return await held();
  const [run] = await db.select(nativeWorkspaceRunProjection()).from(heartbeatRuns).where(and(
    eq(heartbeatRuns.id, lease.heartbeatRunId), eq(heartbeatRuns.companyId, lease.companyId),
    eq(heartbeatRuns.runtimeMode, "native"),
  )).limit(1);
  if (run?.observedRemoteWorkspace) return true;
  if (await preparedRemoteWorkspaceSource(db, lease)) return true;
  if (run && nativeWorkspaceSourcePending(run, lease)) return true;
  return await held();
}

export async function nativeWorkspaceExportPendingForResource(db: Db, lease: WorkspaceSourceLease, resumingRunId: string | null) {
  if (!lease.provider || !lease.providerLeaseId || lease.provider === "local") return false;
  const sources = await db.select({ lease: { id: environmentLeases.id, companyId: environmentLeases.companyId,
    heartbeatRunId: environmentLeases.heartbeatRunId, provider: environmentLeases.provider, providerLeaseId: environmentLeases.providerLeaseId,
    issueId: environmentLeases.issueId, executionWorkspaceId: environmentLeases.executionWorkspaceId,
    environmentId: environmentLeases.environmentId, metadata: environmentLeases.metadata },
    run: nativeWorkspaceRunProjection(),
    workspace: { id: executionWorkspaces.id, companyId: executionWorkspaces.companyId, sourceIssueId: executionWorkspaces.sourceIssueId,
      mode: executionWorkspaces.mode, metadata: executionWorkspaces.metadata },
  }).from(environmentLeases).innerJoin(heartbeatRuns, and(eq(heartbeatRuns.companyId, environmentLeases.companyId),
    eq(heartbeatRuns.id, environmentLeases.heartbeatRunId))).leftJoin(executionWorkspaces, and(
      eq(executionWorkspaces.companyId, heartbeatRuns.companyId),
      sql`${executionWorkspaces.id}::text = ${heartbeatRuns.runnerProfileJson}#>>'{remoteWorkspace,workspaceId}'`,
    )).where(and(eq(environmentLeases.provider, lease.provider), eq(environmentLeases.providerLeaseId, lease.providerLeaseId)));
  for (const source of sources) {
    if (source.lease.id === lease.id && source.lease.heartbeatRunId === resumingRunId) continue;
    const remote = matchPreparedRemoteWorkspaceSource({ lease: source.lease, run: { ...source.run,
      issueId: source.run.nativeIssueId ?? source.run.issueId ?? source.run.contextIssueId,
      reference: source.run.remoteReference, legacyReference: source.run.reference } }, source.workspace);
    if (remote || nativeWorkspaceSourcePending(source.run, source.lease)) return true;
  }
  return false;
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
