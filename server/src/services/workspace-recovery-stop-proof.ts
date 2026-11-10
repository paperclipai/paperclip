import { and, eq } from "drizzle-orm";
import { heartbeatRuns, issueRecoveryActions, issues, nativeRunFinalizations, type Db } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";
import { adapterExecutionControls } from "./adapter-execution-control.js";
import { persistActivity, publishActivity } from "./activity-log.js";
import { DELIVERY_QUEUES, notifyDeliveryWork } from "./delivery-work-notifications.js";
import { notifyIssueRecovery } from "./issue-recovery-notifications.js";
import { createSystemRecovery, isExhaustedStopProofWait, readStopProofRecovery, readSystemRecovery, STOP_PROOF_MAX_REARMS,
  STOP_PROOF_RECOVERY_KEY, STOP_PROOF_RECOVERY_SCHEMA, type SystemRecoveryState } from "./system-recovery-state.js";
import { terminalWorkspaceRunStates, type WorkspaceRecoverySourceIdentity } from "./workspace-recovery-source.js";

/** Delay before re-arm n+1, measured from re-arm n. The first re-arm is due at once. */
const STOP_PROOF_REARM_DELAYS_MS = [30 * 60_000, 2 * 60 * 60_000, 8 * 60 * 60_000];

/** User-facing text while a re-armed save runs. It names no person who must act. */
export const STOP_PROOF_REARM_MESSAGE = "Paperclip is saving the previous run's files again now that the run has ended. "
  + "No provider turn is submitted.";

/**
 * Re-arms an exhausted save whose last failure was an unproven agent stop.
 * Exhaustion there only means the recovery window ran out before the stop
 * could be proven; it is not a refusal of the saved files. Once the source run
 * is provably over (terminal, no local execution, no live controller or
 * finalizer lease), a new recovery generation repeats the strict stop proof
 * (a provider stop receipt) and the save. Bounded: at most
 * STOP_PROOF_MAX_REARMS re-arms on a growing backoff, after which the hold
 * continues from the last save with the unsaved files attached
 * (workspace-recovery-fallback). Holds exhausted by older releases carry no
 * marker and are re-armed on the first pass, with no migration.
 * Returns whether a new generation was written.
 */
export async function rearmExhaustedStopProof(db: Db, input: WorkspaceRecoverySourceIdentity, observed: SystemRecoveryState,
  now = Date.now()): Promise<boolean> {
  if (!isExhaustedStopProofWait(observed)) return false;
  const outcome = await db.transaction(async tx => {
    // Lock order shared with the fallback: task, coordinator, run, recovery action.
    const [issue] = await tx.select({ id: issues.id }).from(issues).where(and(eq(issues.companyId, input.companyId),
      eq(issues.id, input.issueId))).for("update");
    const [coordinator] = await tx.select({ leaseOwner: nativeRunFinalizations.leaseOwner, leaseExpiresAt: nativeRunFinalizations.leaseExpiresAt })
      .from(nativeRunFinalizations).where(and(eq(nativeRunFinalizations.companyId, input.companyId),
        eq(nativeRunFinalizations.runId, input.runId))).for("update");
    const [run] = await tx.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, input.companyId),
      eq(heartbeatRuns.id, input.runId))).for("update");
    const [action] = await tx.select().from(issueRecoveryActions).where(and(eq(issueRecoveryActions.companyId, input.companyId),
      eq(issueRecoveryActions.sourceIssueId, input.issueId), eq(issueRecoveryActions.id, input.actionId))).for("update");
    if (!issue || !run || !action) return null;
    const system = readSystemRecovery(action.evidence);
    if (!system || system.generationId !== observed.generationId || system.revision !== observed.revision
      || !isExhaustedStopProofWait(system) || system.sourceRunId !== run.id) return null;
    if (!["active", "escalated"].includes(action.status)
      || action.evidence.runId !== run.id || action.evidence.executionReconciliation || action.evidence.retainedSourceFallback) return null;
    // The agent is provably gone: its run ended and nothing still executes or
    // finalizes it. The new attempt still proves the sandbox stop itself.
    const at = new Date(now);
    if (!terminalWorkspaceRunStates.includes(run.status) || !run.finishedAt || adapterExecutionControls.has(run.id)
      || (run.controllerLeaseExpiresAt && run.controllerLeaseExpiresAt > at)
      // The attempt refuses any recorded finalizer owner (inspectWorkspaceRecoverySource);
      // a stale one is released by the abandoned-owner settlement first.
      || coordinator?.leaseOwner) return null;
    const marker = readStopProofRecovery(action.evidence);
    const rearms = marker?.rearms ?? 0;
    if (rearms >= STOP_PROOF_MAX_REARMS || (marker?.nextRearmAt ?? 0) > now) return null;
    // Any workspace recovery the worker owns: export holds and restore holds alike.
    const next: SystemRecoveryState = { ...createSystemRecovery(run.id), revision: system.revision + 1,
      preservationOperationIds: system.preservationOperationIds, providerCooldownAt: system.providerCooldownAt,
      nextAttemptAt: system.providerCooldownAt };
    const count = rearms + 1;
    const delay = STOP_PROOF_REARM_DELAYS_MS[Math.min(count - 1, STOP_PROOF_REARM_DELAYS_MS.length - 1)];
    const stopProofRecovery = { schema: STOP_PROOF_RECOVERY_SCHEMA, rearms: count, generationId: next.generationId,
      previousGenerationId: system.generationId, rearmedAt: now, nextRearmAt: count < STOP_PROOF_MAX_REARMS ? now + delay : null };
    const prior = action.evidence.workspaceRecovery as { requestIds?: unknown } | undefined;
    await notifyIssueRecovery(tx, { companyId: input.companyId });
    await notifyDeliveryWork(tx, DELIVERY_QUEUES.workspaceRecovery);
    await tx.update(issueRecoveryActions).set({ ownerType: "system", ownerAgentId: null, ownerUserId: null,
      nextAction: STOP_PROOF_REARM_MESSAGE, updatedAt: at,
      evidence: { ...action.evidence, systemRecovery: next, [STOP_PROOF_RECOVERY_KEY]: stopProofRecovery,
        workspaceRecovery: { schema: "paperclip.workspace-recovery.v1", runId: run.id, status: "queued", stage: "verifying_stop",
          attempt: 0, attemptLimit: 6, retryable: true, message: STOP_PROOF_REARM_MESSAGE,
          requestIds: Array.isArray(prior?.requestIds) ? prior.requestIds : [] } },
    }).where(and(eq(issueRecoveryActions.companyId, input.companyId), eq(issueRecoveryActions.id, action.id)));
    return persistActivity(tx as unknown as Db, { companyId: input.companyId, actorType: "system", actorId: "workspace-recovery",
      action: "issue.workspace_recovery_rearmed", entityType: "issue", entityId: input.issueId, runId: run.id,
      details: { recoveryActionId: action.id, failureCode: system.failure?.code ?? null, rearm: count,
        maxRearms: STOP_PROOF_MAX_REARMS, previousGenerationId: system.generationId, generationId: next.generationId } });
  });
  if (!outcome) return false;
  try { publishActivity(outcome.publication); } catch { logger.warn({ runId: input.runId }, "Recovery activity delivery deferred"); }
  return true;
}
