import { and, eq, gte, inArray, ne, or, sql } from "drizzle-orm";
import { completionContracts, heartbeatRuns, issueRecoveryActions, issues, nativeRunFinalizations,
  nativeRunResults, type Db } from "@paperclipai/db";
import { z } from "zod";
import { issueTreeControlService } from "../issue-tree-control.js";
import { remoteExecutionHasStopped } from "../remote-execution-termination.js";
import { readSystemRecovery } from "../system-recovery-state.js";
import { completedWorkspaceRecoveryCondition, readWorkspaceRecovery, verifiedWorkspaceRepairReceipt } from "../workspace-recovery-receipt.js";
import { nativeSha256 } from "./canonical.js";

export const nativeWorkspaceFinalizationBlockSchema = z.object({
  schema: z.literal("paperclip.native-workspace-finalization-block.v1"),
  companyId: z.uuid(), issueId: z.uuid(), runId: z.uuid(), agentId: z.uuid(),
  resultId: z.uuid(), resultSha256: z.string().min(1),
  contractId: z.uuid(), contractSha256: z.string().min(1),
  identityContextId: z.uuid().nullable(), responsibleUserId: z.string().nullable(),
  statusVersion: z.number().int().nonnegative(), priorDecisionId: z.uuid().nullable(),
}).strict();

export type PreservedNativeResultFinalization = {
  companyId: string; issueId: string; runId: string; agentId: string;
  actionId: string; generationId: string; resultId: string; resultSha256: string;
  contractId: string; contractSha256: string; statusVersion: number;
  identityContextId: string | null; responsibleUserId: string | null;
  priorDecisionId: string | null; statusRestoration: "owned" | "unproven";
  fingerprint: string;
};

export function preservedResultHasStop(result: Record<string, unknown> | null) {
  if (!result) return false;
  const cancellation = result.cancellation as { source?: unknown } | undefined;
  return result.nativeCancellation != null || typeof result.cancelledByUserId === "string"
    || ["user", "board", "agent"].includes(String(result.cancelledByActorType ?? result.interruptedByActorType))
    || result.reassignmentStopRequested === true || ["operator", "queued_message"].includes(String(cancellation?.source));
}

export async function readPreservedNativeResultFinalization(db: Db, binding: {
  companyId: string; issueId: string; runId: string; agentId: string;
}, lockProof = false): Promise<PreservedNativeResultFinalization | null> {
  const query = db.select({
    issue: { status: issues.status, statusVersion: issues.statusVersion, decisionId: issues.lastStatusDecisionId,
      assigneeAgentId: issues.assigneeAgentId, assigneeUserId: issues.assigneeUserId,
      executionRunId: issues.executionRunId, checkoutRunId: issues.checkoutRunId },
    run: { id: heartbeatRuns.id, companyId: heartbeatRuns.companyId, nativeIssueId: heartbeatRuns.nativeIssueId,
      issueId: heartbeatRuns.issueId, status: heartbeatRuns.status, createdAt: heartbeatRuns.createdAt,
      identityContextId: heartbeatRuns.activeIdentityContextId, responsibleUserId: heartbeatRuns.responsibleUserId,
      contractSha256: heartbeatRuns.completionContractSha256,
      contextSnapshot: sql<Record<string, unknown>>`jsonb_build_object('issueId', ${heartbeatRuns.contextSnapshot}->'issueId')`,
      resultJson: sql<Record<string, unknown>>`jsonb_build_object(
        'nativeCancellation', ${heartbeatRuns.resultJson}->'nativeCancellation',
        'executionCancellation', ${heartbeatRuns.resultJson}->'executionCancellation',
        'cancellation', ${heartbeatRuns.resultJson}->'cancellation',
        'cancelledByUserId', ${heartbeatRuns.resultJson}->'cancelledByUserId',
        'cancelledByActorType', ${heartbeatRuns.resultJson}->'cancelledByActorType',
        'interruptedByActorType', ${heartbeatRuns.resultJson}->'interruptedByActorType',
        'reassignmentStopRequested', ${heartbeatRuns.resultJson}->'reassignmentStopRequested')`,
      runnerProfileJson: sql<Record<string, unknown>>`jsonb_build_object(
        'nativeWorkspaceSync', ${heartbeatRuns.runnerProfileJson}->'nativeWorkspaceSync',
        'remoteWorkspace', ${heartbeatRuns.runnerProfileJson}->'remoteWorkspace',
        'legacyWorkspaceRecoveryMigration', ${heartbeatRuns.runnerProfileJson}->'legacyWorkspaceRecoveryMigration',
        'nativeWorkspaceFinalizationOwner', ${heartbeatRuns.runnerProfileJson}->'nativeWorkspaceFinalizationOwner')` },
    result: { id: nativeRunResults.id, sha256: nativeRunResults.canonicalSha256,
      disposition: sql<string>`${nativeRunResults.resultJson}#>>'{result,reportedWorkDisposition}'`,
      continuation: sql<string>`${nativeRunResults.resultJson}#>>'{result,continuation,kind}'`,
      terminalDisposition: sql<string>`${nativeRunResults.resultJson}#>>'{terminal,reportedWorkDisposition}'`,
      terminalState: sql<string>`${nativeRunResults.resultJson}#>>'{terminal,runTerminalState}'` },
    contract: { id: completionContracts.id, sha256: completionContracts.canonicalSha256 },
    actionId: issueRecoveryActions.id,
    evidence: sql<Record<string, unknown>>`jsonb_build_object('runId', ${issueRecoveryActions.evidence}->'runId',
      'systemRecovery', ${issueRecoveryActions.evidence}->'systemRecovery',
      'workspaceRecovery', ${issueRecoveryActions.evidence}->'workspaceRecovery',
      'workspaceFinalizationBlock', ${issueRecoveryActions.evidence}->'workspaceFinalizationBlock')`,
    hasRecoveryHistory: sql<boolean>`exists (select 1 from jsonb_array_elements(${nativeRunFinalizations.recoveryHistory}) entry
      where entry->>'kind' = 'preserved_result_finalization' and entry->>'resultId' = ${nativeRunResults.id}::text
        and entry->>'generationId' = ${issueRecoveryActions.evidence}#>>'{systemRecovery,generationId}')`,
  }).from(heartbeatRuns)
    .innerJoin(issues, and(eq(issues.companyId, binding.companyId), eq(issues.id, binding.issueId)))
    .innerJoin(nativeRunFinalizations, and(eq(nativeRunFinalizations.companyId, binding.companyId),
      eq(nativeRunFinalizations.issueId, binding.issueId), eq(nativeRunFinalizations.runId, binding.runId)))
    .innerJoin(nativeRunResults, and(eq(nativeRunResults.companyId, binding.companyId),
      eq(nativeRunResults.issueId, binding.issueId), eq(nativeRunResults.runId, binding.runId),
      eq(nativeRunResults.id, nativeRunFinalizations.resultId), eq(nativeRunResults.schemaStatus, "accepted")))
    .innerJoin(completionContracts, and(eq(completionContracts.companyId, binding.companyId),
      eq(completionContracts.issueId, binding.issueId), eq(completionContracts.id, heartbeatRuns.completionContractId),
      eq(completionContracts.id, nativeRunResults.completionContractId)))
    .innerJoin(issueRecoveryActions, and(eq(issueRecoveryActions.companyId, binding.companyId),
      eq(issueRecoveryActions.sourceIssueId, binding.issueId),
      eq(issueRecoveryActions.kind, "active_run_watchdog"),
      inArray(issueRecoveryActions.cause, ["native_workspace_sync_out_unrecoverable", "native_workspace_sync_out_retry_exhausted"]),
      completedWorkspaceRecoveryCondition(binding.runId),
      sql`${issueRecoveryActions.evidence}->>'runId' = ${binding.runId}`))
    .where(and(eq(heartbeatRuns.companyId, binding.companyId), eq(heartbeatRuns.id, binding.runId),
      eq(heartbeatRuns.nativeIssueId, binding.issueId), eq(heartbeatRuns.agentId, binding.agentId),
      eq(heartbeatRuns.runtimeMode, "native"), ne(nativeRunFinalizations.phase, "terminal_failure")))
    .orderBy(sql`${issueRecoveryActions.createdAt} desc`).limit(1);
  const [row] = await (lockProof ? query.for("share", { noWait: true }) : query);
  if (!row || !["failed", "succeeded"].includes(row.run.status) || preservedResultHasStop(row.run.resultJson)
    || row.issue.assigneeAgentId !== binding.agentId || row.issue.assigneeUserId
    || ["done", "cancelled"].includes(row.issue.status) || row.issue.executionRunId || row.issue.checkoutRunId
    || row.run.runnerProfileJson.nativeWorkspaceFinalizationOwner || !row.hasRecoveryHistory
    || row.run.contractSha256 !== row.contract.sha256 || row.result.disposition !== "yielded"
    || row.result.terminalDisposition !== "yielded" || row.result.terminalState !== "succeeded"
    || row.result.continuation !== "response_wake") return null;
  const recovery = readSystemRecovery(row.evidence), workspace = readWorkspaceRecovery(row.evidence);
  if (recovery?.state !== "complete" || recovery.sourceRunId !== binding.runId || !recovery.preservationOperationIds.length
    || workspace?.status !== "recovered" || workspace.runId !== binding.runId) return null;
  const [newer] = await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(and(
    eq(heartbeatRuns.companyId, binding.companyId), ne(heartbeatRuns.id, binding.runId),
    gte(heartbeatRuns.createdAt, row.run.createdAt), or(eq(heartbeatRuns.issueId, binding.issueId),
      eq(heartbeatRuns.nativeIssueId, binding.issueId), sql`${heartbeatRuns.contextSnapshot}->>'issueId' = ${binding.issueId}`),
  )).limit(1);
  if (newer || await issueTreeControlService(db).getActivePauseHoldGate(binding.companyId, binding.issueId)
    || !await remoteExecutionHasStopped(db, binding.companyId, binding.runId)) return null;
  const receiptId = await verifiedWorkspaceRepairReceipt(db, row.run);
  if (!receiptId || !recovery.preservationOperationIds.includes(receiptId)) return null;
  const block = nativeWorkspaceFinalizationBlockSchema.safeParse(row.evidence.workspaceFinalizationBlock);
  const statusRestoration = row.issue.status === "blocked" && block.success
    && block.data.companyId === binding.companyId && block.data.issueId === binding.issueId
    && block.data.runId === binding.runId && block.data.agentId === binding.agentId
    && block.data.resultId === row.result.id && block.data.resultSha256 === row.result.sha256
    && block.data.contractId === row.contract.id && block.data.contractSha256 === row.contract.sha256
    && block.data.identityContextId === row.run.identityContextId && block.data.responsibleUserId === row.run.responsibleUserId
    && block.data.statusVersion === Number(row.issue.statusVersion)
    && block.data.priorDecisionId === row.issue.decisionId ? "owned" : "unproven";
  const source: Omit<PreservedNativeResultFinalization, "fingerprint"> = {
    companyId: binding.companyId, issueId: binding.issueId, runId: binding.runId, agentId: binding.agentId,
    actionId: row.actionId, generationId: recovery.generationId,
    resultId: row.result.id, resultSha256: row.result.sha256, contractId: row.contract.id,
    contractSha256: row.contract.sha256, statusVersion: Number(row.issue.statusVersion),
    identityContextId: row.run.identityContextId, responsibleUserId: row.run.responsibleUserId,
    priorDecisionId: row.issue.decisionId, statusRestoration };
  return { ...source, fingerprint: nativeSha256({ ...source, receiptId }) };
}
