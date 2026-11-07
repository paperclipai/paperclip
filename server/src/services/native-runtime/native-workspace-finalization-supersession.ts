import { and, asc, eq, ne, sql } from "drizzle-orm";
import { workspaceOperations, type Db } from "@paperclipai/db";
import { persistActivity, publishActivity, type ActivityPublication } from "../activity-log.js";
import { isNativeWorkspaceFinalizationOperationActive } from "../workspace-operations.js";
import { notifyTerminalWorkspaceWork } from "../terminal-workspace-work.js";

export const SUPERSEDED_NATIVE_FINALIZATION_REASON = "superseded_workspace_finalization";

/**
 * Settle earlier `running` native workspace-finalization operations for one run
 * once a later attempt for that run has reached a terminal status (RC-64).
 *
 * The caller must hold the run's native workspace-finalization ownership. That
 * ownership is the proof that no other controller is executing an export for
 * this run: it holds the advisory lock and has claimed the durable owner receipt,
 * which requires the previous controller to have released it or to have been
 * proven stopped (same-host process proof, platform proof, or a completed
 * copyback barrier). The only remaining live executor could be this process,
 * which the in-process registry rules out. Age is never used.
 */
export async function settleSupersededNativeWorkspaceFinalizations(db: Db, input: {
  companyId: string;
  runId: string;
  issueId: string;
  superseding: { id: string; status: string };
}): Promise<string[]> {
  if (input.superseding.status === "running") return [];
  const candidates = await db.select().from(workspaceOperations).where(and(
    eq(workspaceOperations.companyId, input.companyId),
    eq(workspaceOperations.heartbeatRunId, input.runId),
    eq(workspaceOperations.issueId, input.issueId),
    eq(workspaceOperations.phase, "workspace_finalize"),
    eq(workspaceOperations.status, "running"),
    ne(workspaceOperations.id, input.superseding.id),
    sql`${workspaceOperations.metadata}->>'owningService' = 'native_workspace_finalizer'`,
    // Keep PostgreSQL timestamp precision when proving which attempt is later.
    sql`${workspaceOperations.createdAt} < (select created_at from workspace_operations where id = ${input.superseding.id}::uuid)`,
  )).orderBy(asc(workspaceOperations.createdAt), asc(workspaceOperations.id));

  const settled: string[] = [];
  for (const candidate of candidates) {
    if (isNativeWorkspaceFinalizationOperationActive({
      operationId: candidate.id, companyId: input.companyId, runId: input.runId, issueId: input.issueId,
    })) continue;
    const metadata = candidate.metadata ?? {};
    // Independent obligations are never retired by a later export.
    if (metadata.uncertain === true || metadata.uncertain === "true" || metadata.saveWork != null) continue;
    const now = new Date();
    const provenance = {
      schema: "paperclip.native-workspace-finalization-supersession.v1",
      reason: SUPERSEDED_NATIVE_FINALIZATION_REASON,
      proof: "native_workspace_finalization_ownership",
      previousStatus: candidate.status,
      supersedingOperationId: input.superseding.id,
      supersedingStatus: input.superseding.status,
      runId: input.runId,
      reconciledAt: now.toISOString(),
    };
    const message = "Workspace finalization was interrupted before it finished; "
      + `a later finalization attempt (${input.superseding.id}) ${input.superseding.status}.\n`;
    let publication: ActivityPublication | undefined;
    const updated = await db.transaction(async (tx) => {
      const [row] = await tx.update(workspaceOperations).set({
        status: "failed",
        finishedAt: now,
        updatedAt: now,
        stderrExcerpt: `${candidate.stderrExcerpt ?? ""}${message}`.slice(-4096),
        metadata: { ...metadata, supersededFinalization: provenance },
      }).where(and(
        eq(workspaceOperations.id, candidate.id),
        eq(workspaceOperations.companyId, input.companyId),
        eq(workspaceOperations.status, "running"),
      )).returning({ id: workspaceOperations.id, executionWorkspaceId: workspaceOperations.executionWorkspaceId });
      if (!row) return null;
      await notifyTerminalWorkspaceWork(tx, row.executionWorkspaceId
        ? `workspace:${row.executionWorkspaceId}` : `issue:${input.issueId}`);
      const activity = await persistActivity(tx as unknown as Db, {
        companyId: input.companyId, actorType: "system", actorId: "native-workspace-finalizer",
        action: "workspace_operation.reconciled", entityType: "workspace_operation", entityId: candidate.id,
        runId: input.runId, issueId: input.issueId, details: provenance,
      });
      publication = activity.publication;
      return row;
    });
    if (!updated) continue;
    if (publication) publishActivity(publication);
    settled.push(candidate.id);
  }
  return settled;
}
