import { retiredReusableLeasePredecessors } from "./environment-lease-handoff.js";
import { and, eq, inArray, ne, or, sql } from "drizzle-orm";
import { environmentLeases, environments, heartbeatRuns, issueRecoveryActions, nativeRunFinalizations, nativeRunResults, type Db } from "@paperclipai/db";
import { adapterExecutionControls } from "./adapter-execution-control.js";
import { readNativeWorkspaceSyncReference } from "./native-runtime/native-workspace-sync.js";
import { SystemRecoveryFailure } from "./system-recovery-state.js";
import type { NativeWorkspaceFinalizationOwnership } from "./native-runtime/native-workspace-finalization-ownership.js";
import { readStopOnlyCleanup } from "./sandbox-stop-and-retain.js";
import { ENVIRONMENT_LEASE_POLICIES, type EnvironmentLeasePolicy,
  type WorkspaceSourceVerificationFailure } from "@paperclipai/shared";

export const workspaceExportCauses = ["native_workspace_sync_out_unrecoverable", "native_workspace_sync_out_retry_exhausted"];
export const terminalWorkspaceRunStates = ["failed", "interrupted", "timed_out", "cancelled", "succeeded"];
export type WorkspaceRecoverySourceIdentity = { companyId: string; issueId: string; runId: string; actionId: string };

export function workspaceSourceBindingFailure(reason: WorkspaceSourceVerificationFailure["reason"], policy?: unknown) {
  const observedLeasePolicy = typeof policy === "string" && (ENVIRONMENT_LEASE_POLICIES as readonly string[]).includes(policy)
    ? policy as EnvironmentLeasePolicy : "unrecognized";
  return new SystemRecoveryFailure("source_binding_invalid", "service_required", undefined, {
    reason, ...(reason === "lease_policy_not_retained" ? { observedLeasePolicy } : {}),
  });
}

export class WorkspaceSourceInspectionLimit extends Error {}

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
  if (!source) throw workspaceSourceBindingFailure("recovery_lease_not_selected");
  if (source.environment.id !== input.environmentId) throw workspaceSourceBindingFailure("recovery_environment_mismatch");
  if (source.lease.status !== "pending_cleanup" || source.lease.metadata?.pendingCleanupInFlight !== true)
    throw workspaceSourceBindingFailure("recovery_lease_not_claimed");
  if (source.lease.metadata?.pendingCleanupAttemptId !== input.ownership.token)
    throw workspaceSourceBindingFailure("recovery_owner_mismatch");
  if (!readStopOnlyCleanup(source.lease)) throw workspaceSourceBindingFailure("recovery_stop_intent_missing");
  await input.ownership.assertHeld();
  return source;
}

/** Resolve only the immutable source recorded by the failed run. Never discover
 * a candidate by recency, mutable adapter configuration, or a provider search. */
export async function inspectWorkspaceRecoverySource(db: Db, input: WorkspaceRecoverySourceIdentity,
  options: { maximumSources?: number } = {}) {
  const invalid = workspaceSourceBindingFailure;
  const [run] = await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, input.companyId), eq(heartbeatRuns.id, input.runId)));
  const [action] = await db.select().from(issueRecoveryActions).where(and(eq(issueRecoveryActions.companyId, input.companyId),
    eq(issueRecoveryActions.sourceIssueId, input.issueId), eq(issueRecoveryActions.id, input.actionId)));
  if (!run) throw invalid("source_run_missing");
  if (!action) throw invalid("recovery_action_missing");
  if (action.evidence.runId !== run.id) throw invalid("recovery_action_run_mismatch");
  if (!terminalWorkspaceRunStates.includes(run.status)) throw invalid("source_run_not_terminal");
  if ((run.nativeIssueId ?? run.issueId ?? run.contextSnapshot?.issueId) !== input.issueId) throw invalid("source_issue_mismatch");
  const rawReference = run.runnerProfileJson?.nativeWorkspaceSync;
  const reference = readNativeWorkspaceSyncReference(rawReference);
  if (rawReference != null && !reference) throw invalid("native_reference_invalid");
  const recorded = run.resultJson?.workspaceRestoreRecovery as { schema?: unknown; leaseIds?: unknown } | undefined;
  if (recorded != null && recorded.schema !== "paperclip.workspace-restore-recovery.v1") throw invalid("restore_reference_invalid");
  const historical = action.evidence.historicalWorkspaceSource as { schema?: unknown; runId?: unknown; leaseIds?: unknown } | undefined;
  if (historical != null && (historical.schema !== "paperclip.historical-workspace-source.v1" || historical.runId !== run.id)) throw invalid("historical_reference_invalid");
  const leaseIds = recorded ? recorded.leaseIds
    : reference && workspaceExportCauses.includes(action.cause) ? [reference.leaseId]
    : historical?.leaseIds;
  if (!Array.isArray(leaseIds) || leaseIds.length === 0)
    throw new SystemRecoveryFailure("historical_source_missing", "use_alternative_strategy");
  if (options.maximumSources !== undefined && leaseIds.length > options.maximumSources)
    throw new WorkspaceSourceInspectionLimit();
  if (leaseIds.some(id => typeof id !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) ||
      new Set(leaseIds).size !== leaseIds.length || (reference && !leaseIds.includes(reference.leaseId))) throw invalid("lease_reference_invalid");
  const [coordinator] = await db.select().from(nativeRunFinalizations).where(and(
    eq(nativeRunFinalizations.companyId, input.companyId), eq(nativeRunFinalizations.runId, run.id)));
  if (coordinator?.leaseOwner || adapterExecutionControls.has(run.id) ||
      (run.controllerLeaseExpiresAt && run.controllerLeaseExpiresAt > new Date()))
    throw new SystemRecoveryFailure("agent_stop_unconfirmed", "recheck_evidence");
  // Reusable allocations can still owe copyback for a completed native result.
  // This authorizes only preservation of the exact descriptor, never reuse for
  // agent execution. Stop verification and physical ownership checks remain below.
  const acceptedExportResult = reference && workspaceExportCauses.includes(action.cause)
    && run.runtimeMode === "native" && coordinator?.issueId === input.issueId
    && coordinator.resultId && run.completionContractId
    ? (await db.select({ id: nativeRunResults.id }).from(nativeRunResults).where(and(
      eq(nativeRunResults.companyId, input.companyId), eq(nativeRunResults.issueId, input.issueId),
      eq(nativeRunResults.runId, run.id), eq(nativeRunResults.id, coordinator.resultId),
      eq(nativeRunResults.completionContractId, run.completionContractId),
      eq(nativeRunResults.schemaStatus, "accepted"),
      sql`${nativeRunResults.resultJson}#>>'{terminal,runTerminalState}' = 'succeeded'`,
    )).limit(1))[0] : null;
  const sources = [];
  for (const leaseId of leaseIds as string[]) {
    const [lease] = await db.select().from(environmentLeases).where(and(eq(environmentLeases.companyId, input.companyId),
      eq(environmentLeases.id, leaseId), eq(environmentLeases.heartbeatRunId, run.id)));
    const descriptor = reference?.leaseId === leaseId ? reference : null;
    const remoteCwd = lease?.metadata?.remoteCwd;
    if (!lease) throw invalid("source_lease_not_bound");
    if (lease.issueId !== input.issueId) throw invalid("lease_issue_mismatch");
    if (!lease.environmentId) throw invalid("lease_environment_missing");
    if (!lease.providerLeaseId) throw invalid("lease_allocation_missing");
    if (!lease.provider || lease.provider === "local") throw invalid("lease_provider_invalid");
    const reusableExport = descriptor && acceptedExportResult
      && ["reuse_by_environment", "reuse_by_execution_workspace"].includes(lease.leasePolicy);
    if (!["retain_on_failure", "ephemeral"].includes(lease.leasePolicy) && !reusableExport)
      throw invalid("lease_policy_not_retained", lease.leasePolicy);
    if (typeof remoteCwd !== "string" || !remoteCwd.startsWith("/")) throw invalid("lease_cwd_invalid");
    if (descriptor && lease.providerLeaseId !== descriptor.providerLeaseId) throw invalid("allocation_reference_mismatch");
    if (descriptor && remoteCwd !== descriptor.remoteCwd) throw invalid("cwd_reference_mismatch");
    if (descriptor && lease.executionWorkspaceId && lease.executionWorkspaceId !== descriptor.workspaceId)
      throw invalid("workspace_reference_mismatch");
    const history = await db.select().from(environmentLeases).where(and(
      ne(environmentLeases.id, lease.id), eq(environmentLeases.provider, lease.provider),
      eq(environmentLeases.providerLeaseId, lease.providerLeaseId)));
    const predecessors = retiredReusableLeasePredecessors(lease, history);
    if (!predecessors || (predecessors.length && (run.runtimeMode !== "native" || !descriptor || lease.metadata?.agentId !== run.agentId)))
      throw new SystemRecoveryFailure("allocation_ownership_ambiguous", "service_required");
    const predecessorRuns = predecessors.map(item => item.heartbeatRunId!);
    const priors = predecessorRuns.length ? await db.select().from(heartbeatRuns).where(and(
      eq(heartbeatRuns.companyId, input.companyId), inArray(heartbeatRuns.id, predecessorRuns))) : [];
    const priorOwners = predecessorRuns.length ? await db.select({ runId: nativeRunFinalizations.runId,
      phase: nativeRunFinalizations.phase, leaseOwner: nativeRunFinalizations.leaseOwner }).from(nativeRunFinalizations).where(and(
        eq(nativeRunFinalizations.companyId, input.companyId), inArray(nativeRunFinalizations.runId, predecessorRuns),
        eq(nativeRunFinalizations.issueId, input.issueId))) : [];
    for (const predecessor of predecessors) {
      const prior = priors.find(item => item.id === predecessor.heartbeatRunId);
      const priorReference = readNativeWorkspaceSyncReference(prior?.runnerProfileJson?.nativeWorkspaceSync);
      const priorOwner = priorOwners.find(item => item.runId === predecessor.heartbeatRunId);
      if (!prior || prior.runtimeMode !== "native" || prior.agentId !== run.agentId || prior.nativeIssueId !== input.issueId ||
          !terminalWorkspaceRunStates.includes(prior.status) || adapterExecutionControls.has(prior.id) ||
          (prior.controllerLeaseExpiresAt && prior.controllerLeaseExpiresAt > new Date()) ||
          !priorOwner || priorOwner.leaseOwner || !["committed", "terminal_failure", "applied"].includes(priorOwner.phase) ||
          !priorReference || priorReference.state !== "finalized" || !priorReference.finalHostSha256 ||
          priorReference.leaseId !== predecessor.id || priorReference.providerLeaseId !== lease.providerLeaseId ||
          priorReference.workspaceId !== descriptor!.workspaceId || priorReference.remoteCwd !== remoteCwd)
        throw new SystemRecoveryFailure("allocation_ownership_ambiguous", "service_required");
    }
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
