import { isDeepStrictEqual } from "node:util";
import { and, eq, sql } from "drizzle-orm";
import { environmentLeases, executionWorkspaces, heartbeatRuns, issues, workspaceOperations, type Db } from "@paperclipai/db";
import { readRemoteWorkspaceAuthority } from "@paperclipai/shared";
import { readNativeWorkspaceSyncReference, type NativeWorkspaceSyncReference } from "./native-runtime/native-workspace-sync.js";

export type LegacyWorkspaceRecoverySource = {
  runId: string; issueId: string; reference: NativeWorkspaceSyncReference | null;
  recoveryAllocations?: { leaseId: string; providerLeaseId: string; remoteCwd: string }[] | null;
  unresolvedFinalization?: { phase: string; leaseOwner: string | null; leaseExpiresAt: string | null };
};
export const LEGACY_WORKSPACE_RECOVERY_MIGRATION = "paperclip.legacy-workspace-recovery-migration.v1";

/** Offline migration preserves an unresolved coordinator, but it cannot replay
 * an old execution against a local copyback destination that is no longer its
 * authority. File recovery and explicit task continuation remain available. */
export function legacyWorkspaceRecoveryNotMigrated() {
  return sql`${heartbeatRuns.runnerProfileJson}->'legacyWorkspaceRecoveryMigration' is null`;
}

/** Child tasks can explicitly reuse an ancestor's workspace. The run's own
 * task remains the scope for its recovery files; migration never rebinds it. */
export async function isLegacyWorkspaceTaskRelated(db: Pick<Db, "select">, input: {
  companyId: string; issueId: string | null; sourceIssueId: string | null;
}) {
  let current = input.issueId;
  const visited = new Set<string>();
  while (current && visited.size < 32 && !visited.has(current)) {
    if (current === input.sourceIssueId) return true;
    visited.add(current);
    const [issue] = await db.select({ parentId: issues.parentId }).from(issues)
      .where(and(eq(issues.companyId, input.companyId), eq(issues.id, current)));
    current = issue?.parentId ?? null;
  }
  return false;
}

/** Record every declared source, or none: partial preservation cannot release
 * the task's recovery hold. The recovery owner separately verifies provenance,
 * provider termination and archive bytes before writing its receipts. */
export async function readLegacyWorkspaceRecoveryAllocations(db: Pick<Db, "select">, run: {
  id: string; companyId: string; nativeIssueId: string | null; resultJson: Record<string, unknown> | null;
}): Promise<LegacyWorkspaceRecoverySource["recoveryAllocations"]> {
  const recovery = run.resultJson?.workspaceRestoreRecovery as { schema?: unknown; leaseIds?: unknown } | undefined;
  const ids = recovery?.leaseIds;
  if (recovery?.schema !== "paperclip.workspace-restore-recovery.v1" || !Array.isArray(ids) || !ids.length
    || ids.some(id => typeof id !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id))
    || new Set(ids).size !== ids.length || !run.nativeIssueId) return null;
  const allocations = [];
  for (const id of [...ids].sort()) {
    const [lease] = await db.select({ providerLeaseId: environmentLeases.providerLeaseId, metadata: environmentLeases.metadata })
      .from(environmentLeases).where(and(eq(environmentLeases.companyId, run.companyId), eq(environmentLeases.id, id),
        eq(environmentLeases.heartbeatRunId, run.id), eq(environmentLeases.issueId, run.nativeIssueId)));
    if (!lease?.providerLeaseId || typeof lease.metadata?.remoteCwd !== "string" || !lease.metadata.remoteCwd.startsWith("/")) return null;
    allocations.push({ leaseId: id as string, providerLeaseId: lease.providerLeaseId, remoteCwd: lease.metadata.remoteCwd });
  }
  return allocations;
}

/** This receipt changes where recovery may save files; it never certifies that
 * a provider stopped or that its files were recovered. The recovery owner must
 * still validate allocation provenance and termination before exporting. */
export async function readMigratedLegacyWorkspaceSource(db: Pick<Db, "select">, input: {
  companyId: string; runId: string; reference: NativeWorkspaceSyncReference | null;
}): Promise<LegacyWorkspaceRecoverySource | null> {
  const [run] = await db.select({ id: heartbeatRuns.id, companyId: heartbeatRuns.companyId,
    nativeIssueId: heartbeatRuns.nativeIssueId,
    resultJson: sql<Record<string, unknown>>`jsonb_build_object('workspaceRestoreRecovery', ${heartbeatRuns.resultJson}->'workspaceRestoreRecovery')`,
    runnerProfileJson: sql<Record<string, unknown>>`jsonb_build_object(
      'legacyWorkspaceRecoveryMigration', ${heartbeatRuns.runnerProfileJson}->'legacyWorkspaceRecoveryMigration',
      'finalizedWorkspaceRecoveryMigration', ${heartbeatRuns.runnerProfileJson}->'finalizedWorkspaceRecoveryMigration',
      'nativeWorkspaceSync', ${heartbeatRuns.runnerProfileJson}->'nativeWorkspaceSync',
      'remoteWorkspace', ${heartbeatRuns.runnerProfileJson}->'remoteWorkspace')`,
  }).from(heartbeatRuns).where(and(
    eq(heartbeatRuns.companyId, input.companyId), eq(heartbeatRuns.id, input.runId),
  ));
  const runMarker = run?.runnerProfileJson?.[input.reference?.state === "finalized"
    ? "finalizedWorkspaceRecoveryMigration" : "legacyWorkspaceRecoveryMigration"] as { workspaceId?: unknown } | undefined;
  if (input.reference?.state === "finalized" && runMarker == null) return null;
  if (input.reference?.state === "finalized" && !isDeepStrictEqual(input.reference, readNativeWorkspaceSyncReference(run?.runnerProfileJson?.nativeWorkspaceSync)))
    throw new Error("legacy_workspace_migration_receipt_invalid");
  const workspaceId = input.reference?.workspaceId ?? runMarker?.workspaceId;
  if (typeof workspaceId !== "string") return null;
  const [workspace] = await db.select({ metadata: executionWorkspaces.metadata }).from(executionWorkspaces).where(and(
    eq(executionWorkspaces.companyId, input.companyId), eq(executionWorkspaces.id, workspaceId),
  ));
  if (!readRemoteWorkspaceAuthority(workspace?.metadata)) {
    if (input.reference?.state === "finalized" && runMarker != null) throw new Error("legacy_workspace_migration_receipt_invalid");
    return null;
  }
  const marker = workspace?.metadata?.legacyWorkspaceRecoveryMigration as { schema?: unknown; operationId?: unknown } | undefined;
  if (marker?.schema !== LEGACY_WORKSPACE_RECOVERY_MIGRATION || typeof marker.operationId !== "string")
    throw new Error("legacy_workspace_migration_receipt_invalid");
  if (!isDeepStrictEqual(runMarker, {
    schema: LEGACY_WORKSPACE_RECOVERY_MIGRATION, operationId: marker.operationId, workspaceId,
  })) throw new Error("legacy_workspace_migration_receipt_invalid");
  const [operation] = await db.select({ metadata: workspaceOperations.metadata }).from(workspaceOperations).where(and(
    eq(workspaceOperations.companyId, input.companyId), eq(workspaceOperations.executionWorkspaceId, workspaceId),
    eq(workspaceOperations.id, marker.operationId), eq(workspaceOperations.phase, "remote_workspace_migration"),
    eq(workspaceOperations.status, "succeeded"),
  ));
  const sources = operation?.metadata?.legacyRecoverySources;
  const source = Array.isArray(sources) ? sources.find(source => source && typeof source === "object"
    && source.runId === input.runId && typeof source.issueId === "string" && isDeepStrictEqual(source.reference, input.reference)) : null;
  if (source && source.issueId !== run?.nativeIssueId) throw new Error("legacy_workspace_migration_receipt_invalid");
  if (source && !input.reference && (run?.runnerProfileJson?.nativeWorkspaceSync != null
    || run?.runnerProfileJson?.remoteWorkspace != null
    || !isDeepStrictEqual(source.recoveryAllocations ?? null, run ? await readLegacyWorkspaceRecoveryAllocations(db, run) : null)))
    throw new Error("legacy_workspace_migration_receipt_invalid");
  if (source?.recoveryAllocations) {
    for (const allocation of source.recoveryAllocations) {
      const [lease] = await db.select({ providerLeaseId: environmentLeases.providerLeaseId, metadata: environmentLeases.metadata })
        .from(environmentLeases).where(and(eq(environmentLeases.companyId, input.companyId),
          eq(environmentLeases.id, allocation.leaseId), eq(environmentLeases.heartbeatRunId, input.runId),
          eq(environmentLeases.issueId, source.issueId)));
      if (!lease || lease.providerLeaseId !== allocation.providerLeaseId || lease.metadata?.remoteCwd !== allocation.remoteCwd)
        throw new Error("legacy_workspace_migration_receipt_invalid");
    }
  }
  if (!source) throw new Error("legacy_workspace_migration_receipt_invalid");
  return source as LegacyWorkspaceRecoverySource;
}

export async function hasMigratedLegacyWorkspaceSource(...args: Parameters<typeof readMigratedLegacyWorkspaceSource>) {
  return Boolean(await readMigratedLegacyWorkspaceSource(...args));
}
