import { and, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { environmentLeases, heartbeatRuns, issueRecoveryActions, nativeRunFinalizations, type Db } from "@paperclipai/db";
import { remoteWorkspaceRunReferenceSchema } from "@paperclipai/shared";
import { SUPERSEDED_WORKSPACE_EXPORT_KEY, SUPERSEDED_WORKSPACE_EXPORT_SCHEMA } from "../workspace-recovery-fallback-discovery.js";
import { hasRemoteTerminationReceipt } from "../remote-execution-termination.js";
import { hasRequiredWorkspaceRecovery } from "../workspace-restore-recovery-state.js";

/** The finalizer's verdict for a result a newer run already decided (see native-run-finalizer). */
const SUPERSEDED = "native_finalization_superseded";
/** How long a just-ended run's source may wait for its sandbox stop receipt before the check rests. */
const STOP_RECEIPT_WAIT_MS = 60 * 60_000;
const STOP_RECEIPT_RECHECK_MS = 60_000;

type Coordinator = Pick<typeof nativeRunFinalizations.$inferSelect, "resultId" | "phase" | "failureCode" | "failureDetail">;

/**
 * A finalizer retired as superseded while it was exporting the run's
 * workspace. The result is never applied, but the run's files were not saved
 * either, and the run still holds its workspace as the writer.
 */
export function isSupersededWorkspaceExport(coordinator: Coordinator) {
  const detail = coordinator.failureDetail;
  return Boolean(coordinator.resultId) && coordinator.phase === "terminal_failure" && coordinator.failureCode === SUPERSEDED
    && typeof detail?.workspaceFinalizeAttempt === "number";
}

/**
 * Names the retained-file hold of a superseded export, so that a spent
 * re-export budget continues the task from its last save (the retained-source
 * fallback) instead of waiting for a person: no result waits for these files.
 */
export async function markSupersededWorkspaceExportHold(db: Db, run: Pick<typeof heartbeatRuns.$inferSelect, "id" | "companyId">) {
  const marker = { schema: SUPERSEDED_WORKSPACE_EXPORT_SCHEMA, runId: run.id };
  await db.update(issueRecoveryActions).set({ evidence: sql`${issueRecoveryActions.evidence}
    || ${JSON.stringify({ [SUPERSEDED_WORKSPACE_EXPORT_KEY]: marker })}::jsonb` })
    .where(and(eq(issueRecoveryActions.companyId, run.companyId),
      eq(issueRecoveryActions.fingerprint, `native-workspace:${run.id}`),
      sql`${issueRecoveryActions.evidence}->>'runId' = ${run.id}`,
      sql`${issueRecoveryActions.evidence}->'workspaceRestoreRecovery' is not null`,
      sql`not (${issueRecoveryActions.evidence} ? ${SUPERSEDED_WORKSPACE_EXPORT_KEY})`));
}

/**
 * An ended run whose superseded export left its files unsaved and its
 * workspace held, with no retained-file obligation recorded yet. Rows written
 * by releases before this rule match too, so the new build settles them itself.
 */
export function supersededWorkspaceExportUnpreservedCondition() {
  return and(eq(nativeRunFinalizations.phase, "terminal_failure"), eq(nativeRunFinalizations.failureCode, SUPERSEDED),
    isNotNull(nativeRunFinalizations.resultId), isNull(nativeRunFinalizations.leaseOwner),
    sql`${nativeRunFinalizations.failureDetail} ? 'workspaceFinalizeAttempt'`,
    eq(heartbeatRuns.runtimeMode, "native"), eq(heartbeatRuns.status, "failed"),
    sql`${heartbeatRuns.runnerProfileJson}#>>'{remoteWorkspace,state}' = 'prepared'`,
    sql`${heartbeatRuns.runnerProfileJson}->'nativeWorkspaceSync' is null`,
    sql`coalesce(${heartbeatRuns.resultJson}, '{}'::jsonb)->'workspaceRestoreRecovery' is null`,
    sql`exists (select 1 from execution_workspaces workspace where workspace.company_id = ${heartbeatRuns.companyId}
      and workspace.id::text = ${heartbeatRuns.runnerProfileJson}#>>'{remoteWorkspace,workspaceId}'
      and workspace.metadata#>>'{remoteWorkspace,writerRunId}' = ${heartbeatRuns.id}::text
      and workspace.metadata#>>'{remoteWorkspace,dirty}' = 'true')`);
}

/**
 * Records the retained-file obligation of an ended superseded export (the
 * system workspace recovery then re-exports it from the retained sandbox).
 * Returns when to check again: only while a just-ended run's sandbox has not
 * yet confirmed its stop, the one precondition that arrives by itself.
 */
export async function preserveSupersededWorkspaceExport(db: Db, runId: string,
  preserve: (db: Db, run: typeof heartbeatRuns.$inferSelect) => Promise<unknown>): Promise<{ recheckAt: number | null }> {
  const [row] = await db.select({ run: heartbeatRuns }).from(nativeRunFinalizations)
    .innerJoin(heartbeatRuns, and(eq(heartbeatRuns.id, nativeRunFinalizations.runId),
      eq(heartbeatRuns.companyId, nativeRunFinalizations.companyId)))
    .where(and(eq(nativeRunFinalizations.runId, runId), supersededWorkspaceExportUnpreservedCondition()));
  if (!row) return { recheckAt: null };
  const preserved = await preserve(db, row.run) as typeof heartbeatRuns.$inferSelect | undefined;
  if (preserved && hasRequiredWorkspaceRecovery(preserved.resultJson)) return { recheckAt: null };
  const reference = remoteWorkspaceRunReferenceSchema.safeParse(row.run.runnerProfileJson?.remoteWorkspace);
  if (!reference.success) return { recheckAt: null };
  const [lease] = await db.select().from(environmentLeases).where(and(eq(environmentLeases.companyId, row.run.companyId),
    eq(environmentLeases.id, reference.data.leaseId), eq(environmentLeases.heartbeatRunId, row.run.id),
    inArray(environmentLeases.status, ["active", "pending_cleanup", "released"])));
  const ended = row.run.finishedAt?.getTime() ?? 0;
  return { recheckAt: lease && !hasRemoteTerminationReceipt(lease) && Date.now() < ended + STOP_RECEIPT_WAIT_MS
    ? Date.now() + STOP_RECEIPT_RECHECK_MS : null };
}
