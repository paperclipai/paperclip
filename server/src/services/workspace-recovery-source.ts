import { and, eq, inArray, ne, or, sql } from "drizzle-orm";
import { environmentLeases, environments, heartbeatRuns, issueRecoveryActions, nativeRunFinalizations, type Db } from "@paperclipai/db";
import { adapterExecutionControls } from "./adapter-execution-control.js";
import { readNativeWorkspaceSyncReference } from "./native-runtime/native-workspace-sync.js";
import { SystemRecoveryFailure } from "./system-recovery-state.js";
import type { NativeWorkspaceFinalizationOwnership } from "./native-runtime/native-workspace-finalization-ownership.js";
import { readStopOnlyCleanup } from "./sandbox-stop-and-retain.js";

export const workspaceExportCauses = ["native_workspace_sync_out_unrecoverable", "native_workspace_sync_out_retry_exhausted"];
export const terminalWorkspaceRunStates = ["failed", "interrupted", "timed_out", "cancelled", "succeeded"];
export type WorkspaceRecoverySourceIdentity = { companyId: string; issueId: string; runId: string; actionId: string };

export function workspaceRecoverySourceEligible(includeCompleted = false) {
  const actionEligible = sql`(${issueRecoveryActions.status} in ('active', 'escalated') or
    (${issueRecoveryActions.status} = 'resolved' and (
      (${issueRecoveryActions.evidence}#>>'{automaticRecovery,policy}' = 'preserve_without_replay_v1'
        and ${issueRecoveryActions.evidence}#>>'{automaticRecovery,replay}' = 'blocked'
        and ${issueRecoveryActions.evidence}#>>'{automaticRecovery,runId}' = ${heartbeatRuns.id}::text) or
      (${issueRecoveryActions.evidence}#>>'{historicalWorkspaceSource,schema}' = 'paperclip.historical-workspace-source.v1'
        and ${issueRecoveryActions.evidence}#>>'{historicalWorkspaceSource,runId}' = ${heartbeatRuns.id}::text))))`;
  return and(
    sql`${issueRecoveryActions.evidence} ? 'systemRecovery'`,
    includeCompleted ? sql`(${actionEligible} or ${issueRecoveryActions.evidence}#>>'{systemRecovery,state}' = 'complete')` : actionEligible,
    sql`coalesce(${heartbeatRuns.nativeIssueId}::text, ${heartbeatRuns.issueId}::text, ${heartbeatRuns.contextSnapshot}->>'issueId') = ${issueRecoveryActions.sourceIssueId}::text`,
    sql`${issueRecoveryActions.evidence}#>>'{systemRecovery,sourceRunId}' = ${heartbeatRuns.id}::text`,
    sql`${issueRecoveryActions.evidence}#>>'{workspaceRecovery,runId}' = ${heartbeatRuns.id}::text`,
    sql`${issueRecoveryActions.evidence}#>>'{systemRecovery,policyVersion}' = '1'`,
    sql`${issueRecoveryActions.evidence}#>>'{systemRecovery,schema}' = 'paperclip.system-recovery.v1'`,
    sql`${issueRecoveryActions.evidence}#>>'{workspaceRecovery,schema}' = 'paperclip.workspace-recovery.v1'`,
    sql`(${issueRecoveryActions.evidence}->'workspaceRestoreRecovery'->>'schema' = 'paperclip.workspace-restore-recovery.v1'
      or ${issueRecoveryActions.evidence}->'historicalWorkspaceSource'->>'schema' = 'paperclip.historical-workspace-source.v1'
      or ${issueRecoveryActions.cause} in ('native_workspace_sync_out_unrecoverable', 'native_workspace_sync_out_retry_exhausted'))`,
  );
}

/** The preservation owner may reopen only its exact stop-only allocation.
 * This does not release the source's ordinary execution or destruction fence. */
export async function ownedWorkspaceRecoveryLease(db: Db, input: WorkspaceRecoverySourceIdentity & {
  leaseId: string; environmentId: string; ownership: NativeWorkspaceFinalizationOwnership;
}) {
  await input.ownership.assertHeld();
  const inspected = await inspectWorkspaceRecoverySource(db, input);
  const source = inspected.sources.find(item => item.lease.id === input.leaseId);
  if (!source || source.environment.id !== input.environmentId || source.lease.status !== "pending_cleanup"
    || source.lease.metadata?.pendingCleanupInFlight !== true
    || source.lease.metadata?.pendingCleanupAttemptId !== input.ownership.token
    || !readStopOnlyCleanup(source.lease)) {
    throw new SystemRecoveryFailure("source_binding_invalid", "service_required");
  }
  await input.ownership.assertHeld();
  return source;
}

/** Resolve only the immutable source recorded by the failed run. Never discover
 * a candidate by recency, mutable adapter configuration, or a provider search. */
export async function inspectWorkspaceRecoverySource(db: Db, input: WorkspaceRecoverySourceIdentity) {
  const invalid = () => new SystemRecoveryFailure("source_binding_invalid", "service_required");
  const [run] = await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, input.companyId), eq(heartbeatRuns.id, input.runId)));
  const [action] = await db.select().from(issueRecoveryActions).where(and(eq(issueRecoveryActions.companyId, input.companyId),
    eq(issueRecoveryActions.sourceIssueId, input.issueId), eq(issueRecoveryActions.id, input.actionId)));
  if (!run || !action || action.evidence.runId !== run.id || !terminalWorkspaceRunStates.includes(run.status) ||
      (run.nativeIssueId ?? run.issueId ?? run.contextSnapshot?.issueId) !== input.issueId) throw invalid();
  const rawReference = run.runnerProfileJson?.nativeWorkspaceSync;
  const reference = readNativeWorkspaceSyncReference(rawReference);
  if (rawReference != null && !reference) throw invalid();
  const recorded = run.resultJson?.workspaceRestoreRecovery as { schema?: unknown; leaseIds?: unknown } | undefined;
  if (recorded != null && recorded.schema !== "paperclip.workspace-restore-recovery.v1") throw invalid();
  const historical = action.evidence.historicalWorkspaceSource as { schema?: unknown; runId?: unknown; leaseIds?: unknown } | undefined;
  if (historical != null && (historical.schema !== "paperclip.historical-workspace-source.v1" || historical.runId !== run.id)) throw invalid();
  const leaseIds = recorded ? recorded.leaseIds
    : reference && workspaceExportCauses.includes(action.cause) ? [reference.leaseId]
    : historical?.leaseIds;
  if (!Array.isArray(leaseIds) || leaseIds.length === 0)
    throw new SystemRecoveryFailure("historical_source_missing", "use_alternative_strategy");
  if (leaseIds.some(id => typeof id !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) ||
      new Set(leaseIds).size !== leaseIds.length || (reference && !leaseIds.includes(reference.leaseId))) throw invalid();
  const [coordinator] = await db.select().from(nativeRunFinalizations).where(and(
    eq(nativeRunFinalizations.companyId, input.companyId), eq(nativeRunFinalizations.runId, run.id)));
  if (coordinator?.leaseOwner || adapterExecutionControls.has(run.id) ||
      (run.controllerLeaseExpiresAt && run.controllerLeaseExpiresAt > new Date()))
    throw new SystemRecoveryFailure("agent_stop_unconfirmed", "recheck_evidence");
  const sources = [];
  for (const leaseId of leaseIds as string[]) {
    const [lease] = await db.select().from(environmentLeases).where(and(eq(environmentLeases.companyId, input.companyId),
      eq(environmentLeases.id, leaseId), eq(environmentLeases.heartbeatRunId, run.id)));
    const descriptor = reference?.leaseId === leaseId ? reference : null;
    const remoteCwd = lease?.metadata?.remoteCwd;
    if (!lease || lease.issueId !== input.issueId || !lease.environmentId || !lease.providerLeaseId ||
        !lease.provider || lease.provider === "local" || !["retain_on_failure", "ephemeral"].includes(lease.leasePolicy) ||
        typeof remoteCwd !== "string" || !remoteCwd.startsWith("/") ||
        (descriptor && (lease.providerLeaseId !== descriptor.providerLeaseId || remoteCwd !== descriptor.remoteCwd ||
          (lease.executionWorkspaceId && lease.executionWorkspaceId !== descriptor.workspaceId)))) throw invalid();
    const [other] = await db.select({ id: environmentLeases.id }).from(environmentLeases).where(and(
      ne(environmentLeases.id, lease.id), eq(environmentLeases.provider, lease.provider),
      eq(environmentLeases.providerLeaseId, lease.providerLeaseId))).limit(1);
    if (other) throw new SystemRecoveryFailure("allocation_ownership_ambiguous", "service_required");
    // Snapshot export writes only a new staging directory. A native baseline
    // merge additionally needs exclusive ownership of its host destination.
    if (descriptor) {
      const [writer] = await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(and(
        eq(heartbeatRuns.companyId, input.companyId), inArray(heartbeatRuns.status, ["queued", "running"]),
        sql`not exists (select 1 from ${issueRecoveryActions} a
          where a.company_id = ${input.companyId} and a.source_issue_id = ${input.issueId}
          and a.evidence->>'runId' = ${run.id}
          and a.evidence#>>'{explicitUserContinuation,runId}' = ${heartbeatRuns.id}::text
          and a.evidence#>>'{explicitUserContinuation,readiness,mode}' = 'fresh_isolated_workspace')`,
        or(eq(heartbeatRuns.nativeIssueId, input.issueId), eq(heartbeatRuns.issueId, input.issueId),
          sql`${heartbeatRuns.contextSnapshot}->>'issueId' = ${input.issueId}`,
          sql`${heartbeatRuns.contextSnapshot}->>'executionWorkspaceId' = ${descriptor.workspaceId}`))).limit(1);
      if (writer) throw new SystemRecoveryFailure("workspace_writer_active", "recheck_evidence");
    }
    const [environment] = await db.select().from(environments).where(eq(environments.id, lease.environmentId));
    if (!environment) throw new SystemRecoveryFailure("source_unavailable", "service_required");
    sources.push({ lease, environment, reference: descriptor, remoteCwd });
  }
  return { run, action, sources };
}
