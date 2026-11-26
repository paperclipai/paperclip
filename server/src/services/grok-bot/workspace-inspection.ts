import { and, eq, inArray, isNotNull, or, sql } from "drizzle-orm";
import { dotRunnerAssignments, environmentLeases, heartbeatRuns, issueRecoveryActions, issues, nativeRunFinalizations, type Db } from "@paperclipai/db";
import { authorizeExternalBotOperator } from "../external-bot-authority.js";
import { logActivity } from "../activity-log.js";
import { McpOAuthError } from "../public-mcp/oauth.js";
import { hasRemoteTerminationReceipt } from "../remote-execution-termination.js";
import { hasRequiredWorkspaceRecovery, nativeRunHasNoWorkspaceAccess } from "../workspace-restore-recovery-state.js";

/** Old Runner synchronization descriptors could incorrectly require a file
 * export for a Bot explicitly admitted without workspace access. Keep the old
 * execution fenced and its no-replay hold; inspection only retires that false
 * file obligation. Native Runner cleanup never certifies global Grok exit. */
export async function grokWorkspaceInspectionCandidates(db: Db, companyId: string, agentId: string) {
  const runs = await db.select().from(heartbeatRuns).where(and(
    eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.agentId, agentId),
    eq(heartbeatRuns.driverKind, "grok_bot_mcp"), isNotNull(heartbeatRuns.finishedAt),
    inArray(heartbeatRuns.status, ["cancelled", "failed", "timed_out", "interrupted"]),
    sql`${heartbeatRuns.resultJson}->'workspaceRestoreRecovery'->>'schema' = 'paperclip.workspace-restore-recovery.v1'`,
  ));
  return runs.filter(run => nativeRunHasNoWorkspaceAccess(run) && hasRequiredWorkspaceRecovery(run.resultJson));
}

export async function inspectGrokWorkspaceObligations(db: Db, companyId: string, agentId: string, operatorId: string) {
  for (const selected of await grokWorkspaceInspectionCandidates(db, companyId, agentId)) {
    // Independent task transactions keep the native task/coordinator/run lock
    // order out of the routine writer's binding/routine lock order. A partial
    // inspection grants no authority and never schedules work.
    await db.transaction(async tx => {
      const database = tx as unknown as Db;
      await authorizeExternalBotOperator(database, companyId, operatorId);
      const issueId = selected.nativeIssueId ?? selected.issueId;
      if (!issueId) return;
      const [task] = await tx.select().from(issues).where(and(
        eq(issues.companyId, companyId), eq(issues.id, issueId),
      )).for("update");
      const [coordinator] = await tx.select().from(nativeRunFinalizations).where(and(
        eq(nativeRunFinalizations.companyId, companyId), eq(nativeRunFinalizations.runId, selected.id),
        eq(nativeRunFinalizations.issueId, issueId),
      )).for("update");
      const [run] = await tx.select().from(heartbeatRuns).where(and(
        eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.agentId, agentId), eq(heartbeatRuns.id, selected.id),
      )).for("update");
      if (!run || !hasRequiredWorkspaceRecovery(run.resultJson)) return;
      const fail = () => new McpOAuthError("access_denied", "The stopped task still needs verified Runner cleanup before inspection can clear its file obligation.", 409);
      if (!task || !nativeRunHasNoWorkspaceAccess(run) || run.driverKind !== "grok_bot_mcp"
        || !run.finishedAt || !["cancelled", "failed", "timed_out", "interrupted"].includes(run.status)
        || !coordinator || coordinator.phase !== "terminal_failure" || coordinator.leaseOwner
        || coordinator.failureDetail?.successorRunId) throw fail();
      const [active] = await tx.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(and(
        eq(heartbeatRuns.companyId, companyId), inArray(heartbeatRuns.status, ["running", "queued", "scheduled_retry"]),
        or(eq(heartbeatRuns.nativeIssueId, issueId), eq(heartbeatRuns.issueId, issueId)),
      )).limit(1);
      const work = await tx.select().from(dotRunnerAssignments).where(and(
        eq(dotRunnerAssignments.companyId, companyId), eq(dotRunnerAssignments.agentId, agentId),
        eq(dotRunnerAssignments.runId, run.id),
      ));
      const leases = await tx.select().from(environmentLeases).where(and(
        eq(environmentLeases.companyId, companyId), eq(environmentLeases.heartbeatRunId, run.id),
      ));
      if (active || !work.length || work.some(row => row.status !== "fenced") || !leases.length
        || !leases.every(lease => lease.issueId === issueId && hasRemoteTerminationReceipt(lease))) throw fail();
      const actions = await tx.select().from(issueRecoveryActions).where(and(
        eq(issueRecoveryActions.companyId, companyId), eq(issueRecoveryActions.sourceIssueId, issueId),
        or(sql`${issueRecoveryActions.evidence}->>'runId' = ${run.id}`,
          sql`${issueRecoveryActions.evidence}->>'sourceRunId' = ${run.id}`),
      )).for("update");
      const inspection = { schema: "paperclip.grok-workspace-inspection.v1", runId: run.id,
        inspectedBy: operatorId, inspectedAt: new Date().toISOString(), workspaceAccess: "none",
        remoteTerminationConfirmed: false, runnerLeaseIds: leases.map(lease => lease.id),
        previousWorkspaceRestoreFailure: run.resultJson?.workspaceRestoreFailure,
        previousWorkspaceRestoreRecovery: run.resultJson?.workspaceRestoreRecovery };
      const retireFileObligation = (value: Record<string, unknown>) => {
        const { workspaceRestoreFailure: _failure, workspaceRestoreRecovery: _recovery, ...rest } = value;
        return { ...rest, externalWorkspaceInspection: inspection };
      };
      await tx.update(heartbeatRuns).set({ resultJson: retireFileObligation(run.resultJson!) }).where(eq(heartbeatRuns.id, run.id));
      for (const action of actions) {
        await tx.update(issueRecoveryActions).set({ evidence: retireFileObligation(action.evidence), updatedAt: new Date(),
          nextAction: "Inspect Grok and verify its connection before sending a new task message. The old work will not be replayed.",
        }).where(eq(issueRecoveryActions.id, action.id));
      }
      await logActivity(database, { companyId, actorType: "user", actorId: operatorId,
        action: "grok.workspace_obligation_inspected", entityType: "issue", entityId: issueId,
        agentId, runId: run.id, details: inspection });
    });
  }
}
