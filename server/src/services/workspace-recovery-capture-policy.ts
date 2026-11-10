import { and, eq } from "drizzle-orm";
import { heartbeatRuns, issueRecoveryActions, issues, nativeRunFinalizations, type Db } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";
import { adapterExecutionControls } from "./adapter-execution-control.js";
import { persistActivity, publishActivity } from "./activity-log.js";
import { DELIVERY_QUEUES, notifyDeliveryWork } from "./delivery-work-notifications.js";
import { notifyIssueRecovery } from "./issue-recovery-notifications.js";
import { REMOTE_WORKSPACE_CAPTURE_POLICY_VERSION } from "./remote-workspace-snapshot-archive.js";
import { CAPTURE_POLICY_RECOVERY_KEY, CAPTURE_POLICY_RECOVERY_SCHEMA, createSystemRecovery, isCapturePolicyRearmable,
  readSystemRecovery, type SystemRecoveryState } from "./system-recovery-state.js";
import { terminalWorkspaceRunStates, type WorkspaceRecoverySourceIdentity } from "./workspace-recovery-source.js";

/** User-facing text while the retried save runs. It names no person who must act. */
export const CAPTURE_POLICY_REARM_MESSAGE = "Paperclip is saving the previous run's files again with its updated save rules. "
  + "No provider turn is submitted.";

/**
 * Retries, once per capture policy version, a save that recovery exhausted
 * while preserving files under an older policy. The same saved workspace can
 * succeed now (for example one with a symlink out of the workspace, which an
 * older policy refused and the current one records and drops). The new
 * generation repeats the strict stop proof and the save under the current
 * policy and records that version, so it is never re-armed again by this
 * rule. Holds exhausted by older releases carry no version and are re-armed on
 * the first pass, with no migration. Returns whether a new generation was written.
 */
export async function rearmExhaustedCapturePolicy(db: Db, input: WorkspaceRecoverySourceIdentity, observed: SystemRecoveryState,
  now = Date.now()): Promise<boolean> {
  if (!isCapturePolicyRearmable(observed)) return false;
  const outcome = await db.transaction(async tx => {
    // Lock order shared with the fallback and the stop-proof re-arm: task, coordinator, run, recovery action.
    const [issue] = await tx.select({ id: issues.id }).from(issues).where(and(eq(issues.companyId, input.companyId),
      eq(issues.id, input.issueId))).for("update");
    const [coordinator] = await tx.select({ leaseOwner: nativeRunFinalizations.leaseOwner })
      .from(nativeRunFinalizations).where(and(eq(nativeRunFinalizations.companyId, input.companyId),
        eq(nativeRunFinalizations.runId, input.runId))).for("update");
    const [run] = await tx.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, input.companyId),
      eq(heartbeatRuns.id, input.runId))).for("update");
    const [action] = await tx.select().from(issueRecoveryActions).where(and(eq(issueRecoveryActions.companyId, input.companyId),
      eq(issueRecoveryActions.sourceIssueId, input.issueId), eq(issueRecoveryActions.id, input.actionId))).for("update");
    if (!issue || !run || !action) return null;
    const system = readSystemRecovery(action.evidence);
    if (!system || system.generationId !== observed.generationId || system.revision !== observed.revision
      || !isCapturePolicyRearmable(system) || system.sourceRunId !== run.id) return null;
    if (!["active", "escalated"].includes(action.status)
      || action.evidence.runId !== run.id || action.evidence.executionReconciliation || action.evidence.retainedSourceFallback) return null;
    // Nothing still executes or finalizes the source run. The new attempt
    // still proves the sandbox stop itself before it reads any file.
    const at = new Date(now);
    if (!terminalWorkspaceRunStates.includes(run.status) || !run.finishedAt || adapterExecutionControls.has(run.id)
      || (run.controllerLeaseExpiresAt && run.controllerLeaseExpiresAt > at) || coordinator?.leaseOwner) return null;
    const next: SystemRecoveryState = { ...createSystemRecovery(run.id), revision: system.revision + 1,
      preservationOperationIds: system.preservationOperationIds, providerCooldownAt: system.providerCooldownAt,
      nextAttemptAt: system.providerCooldownAt };
    const marker = { schema: CAPTURE_POLICY_RECOVERY_SCHEMA, policyVersion: REMOTE_WORKSPACE_CAPTURE_POLICY_VERSION,
      previousPolicyVersion: system.capturePolicyVersion ?? 1, generationId: next.generationId,
      previousGenerationId: system.generationId, rearmedAt: now };
    const prior = action.evidence.workspaceRecovery as { requestIds?: unknown } | undefined;
    await notifyIssueRecovery(tx, { companyId: input.companyId });
    await notifyDeliveryWork(tx, DELIVERY_QUEUES.workspaceRecovery);
    await tx.update(issueRecoveryActions).set({ ownerType: "system", ownerAgentId: null, ownerUserId: null,
      nextAction: CAPTURE_POLICY_REARM_MESSAGE, updatedAt: at,
      evidence: { ...action.evidence, systemRecovery: next, [CAPTURE_POLICY_RECOVERY_KEY]: marker,
        workspaceRecovery: { schema: "paperclip.workspace-recovery.v1", runId: run.id, status: "queued", stage: "verifying_stop",
          attempt: 0, attemptLimit: 6, retryable: true, message: CAPTURE_POLICY_REARM_MESSAGE,
          requestIds: Array.isArray(prior?.requestIds) ? prior.requestIds : [] } },
    }).where(and(eq(issueRecoveryActions.companyId, input.companyId), eq(issueRecoveryActions.id, action.id)));
    return persistActivity(tx as unknown as Db, { companyId: input.companyId, actorType: "system", actorId: "workspace-recovery",
      action: "issue.workspace_recovery_rearmed", entityType: "issue", entityId: input.issueId, runId: run.id,
      details: { recoveryActionId: action.id, reason: "capture_policy_changed", failureCode: system.failure?.code ?? null,
        policyVersion: marker.policyVersion, previousPolicyVersion: marker.previousPolicyVersion,
        previousGenerationId: system.generationId, generationId: next.generationId } });
  });
  if (!outcome) return false;
  try { publishActivity(outcome.publication); } catch { logger.warn({ runId: input.runId }, "Recovery activity delivery deferred"); }
  return true;
}
