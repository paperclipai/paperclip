import { environmentLeases, heartbeatRuns, nativeRunFinalizations, nativeRunResults, type Db } from "@paperclipai/db";
import { and, eq, exists, sql } from "drizzle-orm";
import { nativeRunHasNoWorkspaceAccess } from "../workspace-restore-recovery-state.js";
import { readNativeWorkspaceSyncReference } from "./native-workspace-sync.js";

type WorkspaceSourceLease = Pick<typeof environmentLeases.$inferSelect,
  "id" | "companyId" | "heartbeatRunId" | "provider" | "providerLeaseId">;

function nativeWorkspaceRunProjection() {
  const input = sql`${heartbeatRuns.runnerProfileJson}->'nativeExecutionInput'`;
  return {
    id: heartbeatRuns.id, companyId: heartbeatRuns.companyId, agentId: heartbeatRuns.agentId,
    issueId: heartbeatRuns.issueId, nativeIssueId: heartbeatRuns.nativeIssueId,
    runtimeMode: heartbeatRuns.runtimeMode, driverKind: heartbeatRuns.driverKind,
    reference: sql<unknown>`${heartbeatRuns.runnerProfileJson}->'nativeWorkspaceSync'`,
    executionScope: sql<Record<string, unknown>>`jsonb_build_object(
      'schema', ${input}->'schema', 'binding', ${input}->'binding', 'workspace', ${input}->'workspace',
      'provider', jsonb_build_object('kind', ${input}#>'{provider,kind}', 'bridgeRevision', ${input}#>'{provider,bridgeRevision}'))`,
  };
}

function nativeWorkspaceSourcePending(run: Pick<typeof heartbeatRuns.$inferSelect,
  "id" | "companyId" | "agentId" | "issueId" | "nativeIssueId" | "runtimeMode" | "driverKind"> & {
    reference: unknown; executionScope: Record<string, unknown>;
  }, lease: WorkspaceSourceLease) {
  if (nativeRunHasNoWorkspaceAccess({ ...run, runnerProfileJson: { nativeExecutionInput: run.executionScope } })) return false;
  const reference = readNativeWorkspaceSyncReference(run.reference);
  return reference?.state === "prepared" && reference.leaseId === lease.id
    && reference.providerLeaseId === lease.providerLeaseId;
}

export async function nativeWorkspaceExportPendingForLease(db: Db, lease: WorkspaceSourceLease): Promise<boolean> {
  if (!lease.heartbeatRunId || !lease.provider || lease.provider === "local" || !lease.providerLeaseId) return false;
  const [run] = await db.select(nativeWorkspaceRunProjection()).from(heartbeatRuns).where(and(
    eq(heartbeatRuns.id, lease.heartbeatRunId), eq(heartbeatRuns.companyId, lease.companyId),
    eq(heartbeatRuns.runtimeMode, "native"),
  )).limit(1);
  return Boolean(run && nativeWorkspaceSourcePending(run, lease));
}

export async function nativeWorkspaceExportPendingForResource(db: Db, lease: WorkspaceSourceLease, resumingRunId: string | null) {
  if (!lease.provider || !lease.providerLeaseId || lease.provider === "local") return false;
  const sources = await db.select({ lease: { id: environmentLeases.id, companyId: environmentLeases.companyId,
    heartbeatRunId: environmentLeases.heartbeatRunId, provider: environmentLeases.provider, providerLeaseId: environmentLeases.providerLeaseId },
    run: nativeWorkspaceRunProjection(),
  }).from(environmentLeases).innerJoin(heartbeatRuns, and(eq(heartbeatRuns.companyId, environmentLeases.companyId),
    eq(heartbeatRuns.id, environmentLeases.heartbeatRunId))).where(and(
    eq(environmentLeases.provider, lease.provider), eq(environmentLeases.providerLeaseId, lease.providerLeaseId),
    eq(heartbeatRuns.runtimeMode, "native"), sql`${heartbeatRuns.runnerProfileJson}#>>'{nativeWorkspaceSync,state}' = 'prepared'`,
  ));
  for (const source of sources) {
    if (source.lease.id === lease.id && source.lease.heartbeatRunId === resumingRunId) continue;
    if (nativeWorkspaceSourcePending(source.run, source.lease)) return true;
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
