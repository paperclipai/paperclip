import { and, eq, gt, inArray, ne, notInArray, or, sql } from "drizzle-orm";
import { agentWakeupRequests, assets, environmentLeases, heartbeatRuns, issueAttachments, issueRecoveryActions, issues, nativeRunFinalizations, nativeRunResults, type Db } from "@paperclipai/db";
import { reconstructWorkspaceSchema, type ExecutionReconciliation } from "@paperclipai/shared";
import type { z } from "zod";
import { conflict } from "../../errors.js";
import { persistActivity, publishActivity } from "../activity-log.js";
import { markExecutionReconciliation } from "../execution-recovery-resolution.js";
import { hasRemoteTerminationReceipt } from "../remote-execution-termination.js";
import { legacyExecutionNeedsReconciliationWithEvidence } from "../legacy-execution-recovery.js";
import { readNativeWorkspaceSyncReference } from "./native-workspace-sync.js";
import { nativeSha256 } from "./canonical.js";
import { reconciledInterveningExecutions } from "./native-reconstruction-intervening-executions.js";

const causes = ["native_workspace_sync_out_unrecoverable", "native_workspace_sync_out_retry_exhausted"];
const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const changed = () => conflict("The lost workspace recovery changed. Refresh the task before continuing.", { code: "workspace_reconstruction_stale" });

export function unreconciledNativeExportPredicate() {
  return and(
    inArray(issueRecoveryActions.cause, causes),
    or(and(
      or(inArray(issueRecoveryActions.status, ["active", "escalated"]), and(
        eq(issueRecoveryActions.status, "resolved"), eq(issueRecoveryActions.resolutionNote, "new_source_execution_path"),
      )),
      sql`${issueRecoveryActions.evidence}->'executionReconciliation'->'workspaceReconstruction' is null`,
    ), and(eq(issueRecoveryActions.status, "resolved"),
      sql`${issueRecoveryActions.evidence}->'executionReconciliation'->'workspaceReconstruction'->>'schema' = 'paperclip.workspace-reconstruction.v1'`,
      sql`${issueRecoveryActions.evidence}->>'continuationDelivery' = 'pending'`,
    )),
    sql`exists (select 1 from ${heartbeatRuns} where ${heartbeatRuns.companyId} = ${issueRecoveryActions.companyId}
      and ${heartbeatRuns.nativeIssueId} = ${issueRecoveryActions.sourceIssueId}
      and ${heartbeatRuns.id}::text = ${issueRecoveryActions.evidence}->>'runId'
      and ${heartbeatRuns.runtimeMode} = 'native' and ${heartbeatRuns.status} = 'failed'
      and ${heartbeatRuns.runnerProfileJson}->'nativeWorkspaceSync'->>'state' = 'prepared')`,
  );
}

export async function validateNativeWorkspaceReconstruction(db: Db, input: {
  companyId: string; issueId: string; runId: string; actionId: string;
  successorRunId?: string;
  continuationRootRunId?: string;
  predecessorRunIds?: string[];
}) {
  const [issue] = await db.select().from(issues).where(and(eq(issues.companyId, input.companyId), eq(issues.id, input.issueId))).for("update");
  const [coordinator] = await db.select().from(nativeRunFinalizations).where(and(eq(nativeRunFinalizations.companyId, input.companyId), eq(nativeRunFinalizations.runId, input.runId))).for("update");
  const [run] = await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, input.companyId), eq(heartbeatRuns.id, input.runId))).for("update");
  const [action] = await db.select().from(issueRecoveryActions).where(and(eq(issueRecoveryActions.companyId, input.companyId), eq(issueRecoveryActions.sourceIssueId, input.issueId), eq(issueRecoveryActions.id, input.actionId))).for("update");
  if (!issue || !run || !coordinator || !action || run.runtimeMode !== "native" || run.nativeIssueId !== issue.id
    || run.status !== "failed" || run.nativePhase !== "terminal_failure" || coordinator.issueId !== issue.id
    || coordinator.phase !== "terminal_failure" || coordinator.leaseOwner || coordinator.failureDetail?.successorRunId
    || object(run.runnerProfileJson).nativeWorkspaceFinalizationOwner
    || action.kind !== "active_run_watchdog" || action.ownerType !== "board" || !causes.includes(action.cause)
    || action.evidence.runId !== run.id || coordinator.failureCode !== action.cause
    || !["active", "escalated", "resolved"].includes(action.status)
    || (action.status === "resolved" && action.resolutionNote !== "new_source_execution_path" && !object(action.evidence.executionReconciliation).workspaceReconstruction)
    || issue.assigneeAgentId !== run.agentId || action.returnOwnerAgentId !== run.agentId
    || !(input.successorRunId ? ["todo", "in_progress"] : ["blocked", "todo", "in_progress"]).includes(issue.status)
    || (issue.executionRunId && issue.executionRunId !== input.successorRunId)
    || (issue.checkoutRunId && issue.checkoutRunId !== input.successorRunId)) throw changed();
  const reference = readNativeWorkspaceSyncReference(object(run.runnerProfileJson).nativeWorkspaceSync);
  if (!reference || reference.state !== "prepared") throw changed();
  const leases = await db.select().from(environmentLeases).where(and(eq(environmentLeases.companyId, input.companyId), eq(environmentLeases.heartbeatRunId, run.id))).for("update");
  const lease = leases.find(row => row.id === reference.leaseId);
  if (!lease || lease.issueId !== issue.id || lease.providerLeaseId !== reference.providerLeaseId
    || !leases.every(hasRemoteTerminationReceipt) || object(lease.metadata?.remoteExecutionTermination).state !== "destroyed"
    || leases.some(row => row.metadata?.pendingCleanupInFlight === true)) {
    throw conflict("Paperclip has not confirmed destruction of the original workspace. Recover its files or retry its export first.", { code: "workspace_reconstruction_source_not_destroyed" });
  }
  const [otherLease] = await db.select({ id: environmentLeases.id }).from(environmentLeases).where(and(
    ne(environmentLeases.id, lease.id), eq(environmentLeases.provider, lease.provider!), eq(environmentLeases.providerLeaseId, lease.providerLeaseId!),
    inArray(environmentLeases.status, ["active", "retained", "pending_cleanup"]),
  )).limit(1);
  const newer = await db.select({ id: heartbeatRuns.id, companyId: heartbeatRuns.companyId, agentId: heartbeatRuns.agentId,
    nativeIssueId: heartbeatRuns.nativeIssueId, runtimeMode: heartbeatRuns.runtimeMode,
    status: heartbeatRuns.status, finishedAt: heartbeatRuns.finishedAt,
    runnerProfileJson: sql<Record<string, unknown>>`jsonb_build_object(
      'nativeWorkspaceSync', ${heartbeatRuns.runnerProfileJson}->'nativeWorkspaceSync',
      'nativeWorkspaceFinalizationOwner', ${heartbeatRuns.runnerProfileJson}->'nativeWorkspaceFinalizationOwner')`,
    resultJson: sql<Record<string, unknown>>`jsonb_build_object(
      'cancelledByActorType', ${heartbeatRuns.resultJson}->'cancelledByActorType',
      'cancelledByUserId', ${heartbeatRuns.resultJson}->'cancelledByUserId',
      'nativeCancellation', ${heartbeatRuns.resultJson}->'nativeCancellation',
      'workspaceRestoreFailure', ${heartbeatRuns.resultJson}->'workspaceRestoreFailure',
      'workspaceRestoreRecovery', ${heartbeatRuns.resultJson}->'workspaceRestoreRecovery')`,
  }).from(heartbeatRuns).where(and(
    eq(heartbeatRuns.companyId, input.companyId), ne(heartbeatRuns.id, run.id),
    input.successorRunId ? notInArray(heartbeatRuns.id, [input.successorRunId, ...(input.predecessorRunIds ?? [])]) : undefined,
    or(eq(heartbeatRuns.nativeIssueId, issue.id), sql`${heartbeatRuns.contextSnapshot}->>'issueId' = ${issue.id}`),
    or(gt(heartbeatRuns.createdAt, run.createdAt), inArray(heartbeatRuns.status, ["queued", "running"])),
  )).limit(65).for("update");
  const interveningExecutions = newer.length <= 64 ? await reconciledInterveningExecutions(db, run, newer) : null;
  const [otherAction] = await db.select({ id: issueRecoveryActions.id }).from(issueRecoveryActions).where(and(
    eq(issueRecoveryActions.companyId, input.companyId), eq(issueRecoveryActions.sourceIssueId, issue.id),
    ne(issueRecoveryActions.id, action.id), inArray(issueRecoveryActions.status, ["active", "escalated"]),
  )).limit(1);
  const [result] = await db.select().from(nativeRunResults).where(and(
    eq(nativeRunResults.companyId, input.companyId), eq(nativeRunResults.issueId, issue.id), eq(nativeRunResults.runId, run.id),
    eq(nativeRunResults.id, coordinator.resultId ?? "00000000-0000-0000-0000-000000000000"),
    eq(nativeRunResults.completionContractId, run.completionContractId ?? "00000000-0000-0000-0000-000000000000"), eq(nativeRunResults.schemaStatus, "accepted"),
  )).limit(1);
  if (otherLease || !interveningExecutions || otherAction || !result) throw changed();
  const decision = action.evidence.executionReconciliation as ExecutionReconciliation | undefined;
  if (decision?.workspaceReconstruction) {
    const reconstruction = decision.workspaceReconstruction;
    if ((!input.successorRunId && issue.status !== "todo") || decision.runId !== run.id || reconstruction.schema !== "paperclip.workspace-reconstruction.v1"
      || (input.successorRunId && (action.evidence.continuationRunId !== (input.continuationRootRunId ?? input.successorRunId) || action.evidence.continuationDelivery !== "delivered"))
      || reconstruction.leaseId !== lease.id || reconstruction.resultId !== result.id
      || reconstruction.descriptorSha256 !== reference.descriptorSha256 || !reconstruction.sources?.length
      || nativeSha256(reconstruction.interveningExecutions ?? []) !== nativeSha256(interveningExecutions)) throw changed();
    const files = await db.select({ attachmentId: issueAttachments.id, sha256: assets.sha256 }).from(issueAttachments)
      .innerJoin(assets, and(eq(assets.id, issueAttachments.assetId), eq(assets.companyId, input.companyId)))
      .where(and(eq(issueAttachments.companyId, input.companyId), eq(issueAttachments.issueId, input.issueId),
        inArray(issueAttachments.id, reconstruction.sources.map(source => source.attachmentId)))).for("share");
    if (files.length !== reconstruction.sources.length || reconstruction.sources.some(source => !files.some(file => file.attachmentId === source.attachmentId && file.sha256 === source.sha256))) throw changed();
  }
  return { issue, run, action, reference, lease, result, interveningExecutions };
}

export async function validateReconstructedWorkspaceDispatch(db: Db, run: typeof heartbeatRuns.$inferSelect) {
  const context = object(run.contextSnapshot);
  if (typeof context.workspaceReconstructionActionId !== "string") return;
  const actionId = context.workspaceReconstructionActionId;
  if (typeof context.issueId !== "string" || typeof context.previousRunId !== "string"
    || context.source !== "execution.reconciled" || context.recoveryActionId !== actionId || context.forceFreshSession !== true) throw changed();
  const predecessorRunIds: string[] = [];
  let root = run;
  while (root.retryOfRunId !== context.previousRunId) {
    if (!root.retryOfRunId || predecessorRunIds.length >= 64 || predecessorRunIds.includes(root.retryOfRunId)
      || root.invocationSource !== "automation" || root.triggerDetail !== "system" || !root.scheduledRetryReason
      || object(root.contextSnapshot).retryOfRunId !== root.retryOfRunId) throw changed();
    const [wake] = await db.select().from(agentWakeupRequests).where(and(eq(agentWakeupRequests.companyId, run.companyId),
      eq(agentWakeupRequests.agentId, run.agentId), eq(agentWakeupRequests.id, root.wakeupRequestId ?? "00000000-0000-0000-0000-000000000000"))).for("share");
    if (!wake || wake.runId !== root.id || wake.source !== "automation" || wake.triggerDetail !== "system"
      || wake.requestedByActorType !== "system" || wake.payload?.retryOfRunId !== root.retryOfRunId
      || wake.payload?.retryReason !== root.scheduledRetryReason || wake.payload?.scheduledRetryAttempt !== root.scheduledRetryAttempt) throw changed();
    const [parent] = await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, run.companyId),
      eq(heartbeatRuns.agentId, run.agentId), eq(heartbeatRuns.id, root.retryOfRunId))).for("update");
    const parentContext = object(parent?.contextSnapshot);
    if (!parent || !["succeeded", "failed", "timed_out", "cancelled", "interrupted"].includes(parent.status)
      || parent.scopeKind !== "issue" || parent.issueId !== context.issueId || parent.createdAt > root.createdAt
      || parentContext.issueId !== context.issueId || parentContext.previousRunId !== context.previousRunId
      || parentContext.workspaceReconstructionActionId !== actionId || parentContext.recoveryActionId !== actionId
      || parentContext.source !== "execution.reconciled" || parentContext.forceFreshSession !== true) throw changed();
    if (await legacyExecutionNeedsReconciliationWithEvidence(db, parent)) throw changed();
    predecessorRunIds.push(parent.id);
    root = parent;
  }
  const source = await validateNativeWorkspaceReconstruction(db, { companyId: run.companyId, issueId: context.issueId,
    runId: context.previousRunId, actionId, successorRunId: run.id, continuationRootRunId: root.id, predecessorRunIds });
  if (source.run.agentId !== run.agentId || !object(source.action.evidence.executionReconciliation).workspaceReconstruction) throw changed();
}

export async function reconstructNativeWorkspace(input: {
  db: Db; companyId: string; issueId: string; actorId: string;
  request: z.infer<typeof reconstructWorkspaceSchema>;
}) {
  const request = reconstructWorkspaceSchema.parse(input.request);
  const requestSha256 = nativeSha256(request);
  const outcome = await input.db.transaction(async tx => {
    const db = tx as unknown as Db;
    const [issue] = await tx.select().from(issues).where(and(eq(issues.companyId, input.companyId), eq(issues.id, input.issueId))).for("update");
    const [prior] = await tx.select().from(issueRecoveryActions).where(and(eq(issueRecoveryActions.companyId, input.companyId), eq(issueRecoveryActions.sourceIssueId, input.issueId), eq(issueRecoveryActions.id, request.actionId)));
    if (prior?.evidence.workspaceReconstructionRequest === requestSha256) return { replayed: true, publication: null };
    if (!issue || !["blocked", "in_progress"].includes(issue.status)
      || issue.statusVersion !== request.expectedStatusVersion || prior?.evidence.executionReconciliation) throw changed();
    const source = await validateNativeWorkspaceReconstruction(db, { ...input, ...request });
    const files = await tx.select({ attachmentId: issueAttachments.id, sha256: assets.sha256, byteSize: assets.byteSize, filename: assets.originalFilename })
      .from(issueAttachments).innerJoin(assets, and(eq(assets.id, issueAttachments.assetId), eq(assets.companyId, input.companyId)))
      .where(and(eq(issueAttachments.companyId, input.companyId), eq(issueAttachments.issueId, input.issueId), inArray(issueAttachments.id, request.attachmentIds)));
    if (files.length !== request.attachmentIds.length || files.some(file => !/^[a-f0-9]{64}$/.test(file.sha256) || file.byteSize <= 0)) {
      throw conflict("Choose saved attachments from this task before reconstructing its workspace.", { code: "workspace_reconstruction_sources_invalid" });
    }
    const decision: ExecutionReconciliation = { runId: request.runId, providerStopped: true,
      actionOutcome: request.actionOutcome, outcomeEvidence: request.outcomeEvidence,
      workspaceReconstruction: { schema: "paperclip.workspace-reconstruction.v1", leaseId: source.lease.id,
        resultId: source.result.id, descriptorSha256: source.reference.descriptorSha256, missingWork: request.missingWork, sources: files,
        ...(source.interveningExecutions.length ? { interveningExecutions: source.interveningExecutions } : {}) } };
    await markExecutionReconciliation(db, source.action, decision, input.actorId);
    const now = new Date();
    await tx.update(issueRecoveryActions).set({ status: "resolved", outcome: "handed_back", resolvedAt: now, updatedAt: now,
      resolutionNote: "workspace_reconstruction_authorized", nextAction: "Continue from saved sources. The original unexported edits are lost; verify the selected attachments before rebuilding. Do not repeat completed external actions or reset the original work limits.",
      evidence: sql`${issueRecoveryActions.evidence} || ${JSON.stringify({ workspaceReconstructionRequest: requestSha256 })}::jsonb`,
      wakePolicy: null, monitorPolicy: null,
    }).where(eq(issueRecoveryActions.id, source.action.id));
    await tx.update(issues).set({ status: "todo", unblockDescriptor: null, blockedTransitionAt: null,
      blockedOwnerNotifiedAt: null, updatedAt: now }).where(eq(issues.id, issue.id));
    const publication = await persistActivity(db, { companyId: input.companyId, actorType: "user", actorId: input.actorId,
      action: "issue.workspace_reconstruction_authorized", entityType: "issue", entityId: input.issueId, runId: request.runId,
      details: { recoveryActionId: request.actionId, ...decision } });
    return { replayed: false, publication };
  });
  if (outcome.publication) publishActivity(outcome.publication.publication);
  return { runId: request.runId, actionId: request.actionId, status: "queued" as const, replayed: outcome.replayed };
}
