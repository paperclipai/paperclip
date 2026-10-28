import { environmentLeases, heartbeatRuns, nativeRunFinalizations, nativeRunResults, type Db } from "@paperclipai/db";
import { and, eq, exists, sql } from "drizzle-orm";
import { nativeRunHasNoWorkspaceAccess } from "../workspace-restore-recovery-state.js";
import { readNativeWorkspaceSyncReference } from "./native-workspace-sync.js";

type WorkspaceSourceLease = Pick<typeof environmentLeases.$inferSelect,
  "id" | "companyId" | "heartbeatRunId" | "provider" | "providerLeaseId">;

export async function nativeWorkspaceExportPendingForLease(db: Db, lease: WorkspaceSourceLease): Promise<boolean> {
  if (!lease.heartbeatRunId || !lease.provider || lease.provider === "local" || !lease.providerLeaseId) return false;
  const input = sql`${heartbeatRuns.runnerProfileJson}->'nativeExecutionInput'`;
  const [run] = await db.select({
    id: heartbeatRuns.id, companyId: heartbeatRuns.companyId, agentId: heartbeatRuns.agentId,
    issueId: heartbeatRuns.issueId, nativeIssueId: heartbeatRuns.nativeIssueId,
    runtimeMode: heartbeatRuns.runtimeMode, driverKind: heartbeatRuns.driverKind,
    reference: sql<unknown>`${heartbeatRuns.runnerProfileJson}->'nativeWorkspaceSync'`,
    executionScope: sql<Record<string, unknown>>`jsonb_build_object(
      'schema', ${input}->'schema', 'binding', ${input}->'binding', 'workspace', ${input}->'workspace',
      'provider', jsonb_build_object('kind', ${input}#>'{provider,kind}'))`,
  }).from(heartbeatRuns).where(and(
    eq(heartbeatRuns.id, lease.heartbeatRunId), eq(heartbeatRuns.companyId, lease.companyId),
    eq(heartbeatRuns.runtimeMode, "native"),
  )).limit(1);
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
