import { and, asc, eq, gt, inArray, isNotNull, not, or, sql } from "drizzle-orm";
import { environmentLeases, heartbeatRuns, issues, issueRecoveryActions, nativeRunFinalizations, nativeRunResults, workspaceOperations, type Db } from "@paperclipai/db";
import { issueRecoveryActionService } from "../issue-recovery-actions.js";
import type { NativeRecoveryNoticeScope } from "../native-recovery-notice-notifications.js";
import { nativeRunnerOwnershipNotHeldCondition } from "./native-runner-ownership.js";
import { pendingNativeStatusEffectsCondition } from "./native-pending-effect-work.js";
import { pendingNativeRunProjectionCondition } from "./native-run-projection.js";
import { completedWorkspaceRecoveryCondition } from "../workspace-recovery-receipt.js";

const workspaceExportFailureCauses = ["native_workspace_sync_out_unrecoverable", "native_workspace_sync_out_retry_exhausted"];

function recoveredExportNotice(runId: string | typeof nativeRunFinalizations.runId) {
  return and(
    inArray(issueRecoveryActions.cause, workspaceExportFailureCauses),
    completedWorkspaceRecoveryCondition(runId),
  );
}

function completedExportRetryNotice(runId: string | typeof nativeRunFinalizations.runId) {
  return and(
    inArray(issueRecoveryActions.cause, workspaceExportFailureCauses),
    sql`${issueRecoveryActions.wakePolicy}->>'kind' = 'resume_native_run'`,
    sql`${issueRecoveryActions.wakePolicy}->>'runId' = ${runId}::text`,
    sql`exists (select 1 from ${heartbeatRuns} retry_run
      join ${nativeRunFinalizations} retry_final on retry_final.company_id = retry_run.company_id
        and retry_final.run_id = retry_run.id and retry_final.issue_id = retry_run.native_issue_id
      join ${nativeRunResults} retry_result on retry_result.company_id = retry_run.company_id
        and retry_result.run_id = retry_run.id and retry_result.issue_id = retry_run.native_issue_id
        and retry_result.id = retry_final.result_id and retry_result.schema_status = 'accepted'
        and retry_result.completion_contract_id = retry_run.completion_contract_id
      join ${environmentLeases} retry_lease on retry_lease.company_id = retry_run.company_id
        and retry_lease.heartbeat_run_id = retry_run.id and retry_lease.issue_id = retry_run.native_issue_id
        and retry_lease.id::text = ${issueRecoveryActions.evidence}#>>'{workspaceExportRetry,leaseId}'
      where retry_run.company_id = ${issueRecoveryActions.companyId}
        and retry_run.native_issue_id = ${issueRecoveryActions.sourceIssueId} and retry_run.id::text = ${runId}::text
        and retry_run.runtime_mode = 'native' and retry_run.status in ('succeeded', 'failed', 'cancelled', 'interrupted', 'timed_out')
        and retry_run.native_phase = 'committed' and retry_final.phase = 'committed'
        and ${issueRecoveryActions.evidence}#>>'{workspaceExportRetry,runId}' = retry_run.id::text
        and ${issueRecoveryActions.evidence}#>>'{workspaceExportRetry,resultId}' = retry_result.id::text
        and ${issueRecoveryActions.evidence}#>>'{workspaceExportRetry,status}' = 'queued'
        and ${issueRecoveryActions.evidence}#>>'{workspaceExportRetry,requestId}' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        and retry_run.result_json->'workspaceExportRetry' = ${issueRecoveryActions.evidence}->'workspaceExportRetry'
        and retry_run.runner_profile_json#>>'{nativeWorkspaceSync,schema}' in
          ('paperclip.native-workspace-sync/v1', 'paperclip.native-workspace-sync/v2', 'paperclip.native-workspace-sync/v3')
        and retry_run.runner_profile_json#>>'{nativeWorkspaceSync,state}' = 'finalized'
        and retry_run.runner_profile_json#>>'{nativeWorkspaceSync,finalHostSha256}' ~ '^[0-9a-f]{64}$'
        and retry_run.runner_profile_json#>>'{nativeWorkspaceSync,leaseId}' = retry_lease.id::text
        and retry_run.runner_profile_json#>>'{nativeWorkspaceSync,providerLeaseId}' = retry_lease.provider_lease_id
        and coalesce(retry_run.runner_profile_json->'nativeWorkspaceFinalizationOwner', 'null'::jsonb) = 'null'::jsonb
        and exists (select 1 from ${workspaceOperations} op where op.company_id = retry_run.company_id
          and op.issue_id = retry_run.native_issue_id and op.heartbeat_run_id = retry_run.id
          and op.phase = 'workspace_finalize' and op.status = 'succeeded'
          and op.metadata->>'owningService' = 'native_workspace_finalizer'
          and op.metadata#>>'{workspaceSync,schema}' = retry_run.runner_profile_json#>>'{nativeWorkspaceSync,schema}'
          and op.metadata#>>'{workspaceSync,workspaceId}' = retry_run.runner_profile_json#>>'{nativeWorkspaceSync,workspaceId}'
          and op.metadata#>>'{workspaceSync,leaseId}' = retry_lease.id::text))`,
  );
}

function matchingNotice(runId: string | typeof nativeRunFinalizations.runId) {
  return and(
    eq(issueRecoveryActions.kind, "active_run_watchdog"),
    inArray(issueRecoveryActions.status, ["active", "escalated"]),
    sql`${issueRecoveryActions.evidence}->>'runId' = ${runId}::text`,
    or(and(not(inArray(issueRecoveryActions.cause, workspaceExportFailureCauses)),
      sql`${issueRecoveryActions.wakePolicy}->>'kind' = 'resume_native_run'`),
      eq(issueRecoveryActions.cause, "native_workspace_finalization_owner_unverified"),
      recoveredExportNotice(runId), completedExportRetryNotice(runId)),
  );
}

export function pendingNativeRecoveryNotices(db: Db, scope?: NativeRecoveryNoticeScope, after?: string) {
  return db.select({ id: nativeRunFinalizations.runId, companyId: nativeRunFinalizations.companyId,
    issueId: nativeRunFinalizations.issueId })
    .from(nativeRunFinalizations)
    .innerJoin(heartbeatRuns, and(eq(heartbeatRuns.id, nativeRunFinalizations.runId),
      eq(heartbeatRuns.companyId, nativeRunFinalizations.companyId), eq(heartbeatRuns.nativeIssueId, nativeRunFinalizations.issueId)))
    .innerJoin(issues, and(eq(issues.id, nativeRunFinalizations.issueId), eq(issues.companyId, nativeRunFinalizations.companyId)))
    .innerJoin(nativeRunResults, and(eq(nativeRunResults.id, nativeRunFinalizations.resultId),
      eq(nativeRunResults.companyId, nativeRunFinalizations.companyId), eq(nativeRunResults.issueId, nativeRunFinalizations.issueId),
      eq(nativeRunResults.runId, nativeRunFinalizations.runId), eq(nativeRunResults.schemaStatus, "accepted")))
    .where(and(eq(nativeRunFinalizations.phase, "committed"), isNotNull(nativeRunFinalizations.resultId),
      eq(heartbeatRuns.runtimeMode, "native"), nativeRunnerOwnershipNotHeldCondition(),
      not(pendingNativeStatusEffectsCondition(db)), not(pendingNativeRunProjectionCondition(db)),
      sql`exists (${db.select({ id: issueRecoveryActions.id }).from(issueRecoveryActions).where(and(
        eq(issueRecoveryActions.companyId, nativeRunFinalizations.companyId),
        eq(issueRecoveryActions.sourceIssueId, nativeRunFinalizations.issueId), matchingNotice(nativeRunFinalizations.runId)))})`,
      scope ? eq(nativeRunFinalizations.companyId, scope.companyId) : undefined,
      scope?.issueId ? eq(nativeRunFinalizations.issueId, scope.issueId) : undefined,
      scope?.runId ? eq(nativeRunFinalizations.runId, scope.runId) : undefined,
      after ? gt(nativeRunFinalizations.runId, after) : undefined,
    )).orderBy(asc(nativeRunFinalizations.runId)).limit(100);
}



export async function resolveCommittedNativeRecoveryNotices(db: Db,
  scope: { companyId: string; issueId: string; runId: string }, onlyWhenSettled = false) {
  const [pending] = await db.select({ id: issueRecoveryActions.id }).from(issueRecoveryActions).where(and(
    eq(issueRecoveryActions.companyId, scope.companyId), eq(issueRecoveryActions.sourceIssueId, scope.issueId),
    matchingNotice(scope.runId))).limit(1);
  if (!pending) return;
  return db.transaction(async transaction => {
    const tx = transaction as unknown as Db;


    const [coordinator] = await tx.select({ phase: nativeRunFinalizations.phase, resultId: nativeRunFinalizations.resultId })
      .from(nativeRunFinalizations).where(and(eq(nativeRunFinalizations.companyId, scope.companyId),
        eq(nativeRunFinalizations.issueId, scope.issueId), eq(nativeRunFinalizations.runId, scope.runId))).for("update");
    if (!coordinator || coordinator.phase !== "committed" || !coordinator.resultId) return;
    const [issue] = await tx.select({ id: issues.id }).from(issues).where(and(
      eq(issues.companyId, scope.companyId), eq(issues.id, scope.issueId))).for("update");
    if (!issue) return;
    const [run] = await tx.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(and(
      eq(heartbeatRuns.id, scope.runId), eq(heartbeatRuns.companyId, scope.companyId),
      eq(heartbeatRuns.nativeIssueId, scope.issueId), eq(heartbeatRuns.runtimeMode, "native"),
      nativeRunnerOwnershipNotHeldCondition())).for("update");
    if (!run) return;
    const actions = await tx.select({ id: issueRecoveryActions.id,
      exportSettled: sql<boolean>`coalesce(${or(recoveredExportNotice(scope.runId), completedExportRetryNotice(scope.runId))}, false)` }).from(issueRecoveryActions).where(and(
      eq(issueRecoveryActions.companyId, scope.companyId), eq(issueRecoveryActions.sourceIssueId, scope.issueId),
      matchingNotice(scope.runId))).for("update");
    if ((onlyWhenSettled || actions.some(action => action.exportSettled)) && !(await pendingNativeRecoveryNotices(tx, scope)).length) return;
    for (const action of actions) await issueRecoveryActionService(tx).resolveActiveForIssue({
      companyId: scope.companyId, sourceIssueId: scope.issueId, actionId: action.id,
      status: "resolved", outcome: "restored",
      resolutionNote: "The accepted native result and workspace finalization committed successfully; this run needs no further finalization retry.",
    });
  });
}
