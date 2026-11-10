import { and, eq, isNull, sql, type SQL } from "drizzle-orm";
import { heartbeatRuns, issueRecoveryActions, nativeRunFinalizations, type Db } from "@paperclipai/db";
import { logActivity } from "../activity-log.js";
import { logger } from "../../middleware/logger.js";
import type { InProgressRecord, SettleOutcome } from "../recovery/ownership-registry.js";
import type { OwnerProof } from "../owner-proof.js";
import { OWNER_GONE_ATTESTATION_KEY } from "../recovery/owner-gone-attestation.js";
import { completedWorkspaceRecoveryCondition } from "../workspace-recovery-receipt.js";
import { NATIVE_SESSION_CLEANUP_QUARANTINED } from "./completed-turn-cleanup.js";

/**
 * `native_completed_turn_cleanup_hold`: no-replay holds left by a native run
 * that completed its provider turn and was then refused by the cleanup gate
 * (`isCompletedTurnCleanupQuarantine`).
 *
 * A server restart that orphaned a tool callback made close unable to prove the
 * drain (fixed for new runs in the runner's orphaned-tool-callback rule). The
 * run failed with `native_session_cleanup_quarantined`, and the system recorded
 * its holds resolved-but-blocked with `preserve_without_replay_v1`: replay
 * blocked because one action outcome was unknown. Nothing is left to replay:
 * the turn completed and its work is saved. The holds still blocked the task,
 * with no Retry and no continuation, so the task could not continue even when
 * the work it waited on finished.
 *
 * The cleanup gate lives in the controller process that closed the session.
 * Once `proveOwnerGone` proves that controller gone, the gate is gone too, so
 * this kind settles the run's no-replay holds: it removes their replay block
 * and starts no turn. A hold that still protects files (a workspace restore not
 * yet verified as recovered) is left for workspace recovery. Operator decisions
 * (an assigned person, an owner-gone attestation, a reconciliation or explicit
 * continuation) are never reopened. Every rule reads fields that earlier
 * releases already saved, so their holds settle without a migration.
 */

const COMPLETED_TURN_CHECKPOINT = sql`run.runner_profile_json->'sessionCheckpoint'->'identity'->>'runId' = run.id::text
  and run.runner_profile_json->'sessionCheckpoint'->>'activeTurnId' is null
  and run.runner_profile_json->'sessionCheckpoint'->'terminal'->>'turnTerminalState' = 'completed'`;

/** A no-replay hold of `runId` that this kind may settle. */
function settleableHoldCondition(runId: SQL | string): SQL {
  return and(
    sql`${issueRecoveryActions.evidence}->>'runId' = ${runId}::text`,
    eq(issueRecoveryActions.status, "resolved"),
    eq(issueRecoveryActions.outcome, "blocked"),
    isNull(issueRecoveryActions.ownerUserId),
    isNull(issueRecoveryActions.ownerAgentId),
    sql`${issueRecoveryActions.evidence}->'automaticRecovery'->>'policy' = 'preserve_without_replay_v1'`,
    sql`${issueRecoveryActions.evidence}->'automaticRecovery'->>'replay' = 'blocked'`,
    sql`not (${issueRecoveryActions.evidence} ?| array['executionReconciliation', ${OWNER_GONE_ATTESTATION_KEY}, 'explicitUserContinuation'])`,
    sql`(not (${issueRecoveryActions.evidence} ?| array['workspaceRestoreFailure', 'workspaceRestoreRecovery'])
      or ${completedWorkspaceRecoveryCondition(runId)})`,
  )!;
}

/** Coordinators of completed-turn cleanup quarantines that still have a
 * settleable no-replay hold. */
export function completedTurnCleanupHoldWhere(): SQL {
  return and(
    isNull(nativeRunFinalizations.leaseOwner),
    sql`exists (select 1 from heartbeat_runs run where run.company_id = ${nativeRunFinalizations.companyId}
      and run.id = ${nativeRunFinalizations.runId} and run.runtime_mode = 'native' and run.status = 'failed'
      and run.error_code = ${NATIVE_SESSION_CLEANUP_QUARANTINED} and ${COMPLETED_TURN_CHECKPOINT})`,
    sql`exists (select 1 from ${issueRecoveryActions} where ${issueRecoveryActions.companyId} = ${nativeRunFinalizations.companyId}
      and ${settleableHoldCondition(sql`${nativeRunFinalizations.runId}`)})`,
  )!;
}

/** Continues the task through the ordinary resume path
 * (`resumeRemoteStopComments`), which still applies every task gate. The
 * heartbeat service registers it. */
type SettledHoldResumer = (input: { companyId: string; runId: string }) => Promise<void>;
let settledHoldResumer: SettledHoldResumer | null = null;

export function registerCompletedTurnCleanupResumer(resumer: SettledHoldResumer): void {
  settledHoldResumer = resumer;
}

/** Called by the shared reconciler only after `proveOwnerGone` proved the
 * run's recorded controller gone. Re-checks the whole condition under the
 * coordinator row lock, so a coordinator taken over since the proof, or a hold
 * changed since, is not settled. */
export async function settleCompletedTurnCleanupHolds(db: Db, record: InProgressRecord,
  context: { now: Date; proof: OwnerProof }): Promise<SettleOutcome> {
  if (!record.companyId) return { settled: false, reason: "run_has_no_company" };
  const companyId = record.companyId;
  const now = context.now;
  const settled = await db.transaction(async tx => {
    const [coordinator] = await tx.select({ runId: nativeRunFinalizations.runId, issueId: nativeRunFinalizations.issueId })
      .from(nativeRunFinalizations).where(and(eq(nativeRunFinalizations.companyId, companyId),
        eq(nativeRunFinalizations.runId, record.recordId), completedTurnCleanupHoldWhere())).for("update");
    if (!coordinator) return null;
    const [run] = await tx.select({ agentId: heartbeatRuns.agentId }).from(heartbeatRuns)
      .where(and(eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.id, coordinator.runId)));
    const holds = await tx.update(issueRecoveryActions).set({
      outcome: "restored", ownerType: "system", updatedAt: now,
      resolutionNote: "The run finished its turn and saved its work; its session cleanup no longer blocks the task.",
      evidence: sql`(${issueRecoveryActions.evidence} - 'automaticRecovery') || ${JSON.stringify({
        completedTurnCleanupSettlement: { runId: coordinator.runId, settledAt: now.toISOString(), ownerProof: context.proof.reason },
      })}::jsonb`,
    }).where(and(eq(issueRecoveryActions.companyId, companyId), eq(issueRecoveryActions.sourceIssueId, coordinator.issueId),
      settleableHoldCondition(coordinator.runId))).returning({ id: issueRecoveryActions.id });
    if (!holds.length) return null;
    await logActivity(tx as unknown as Db, { companyId, actorType: "system", actorId: "system",
      action: "issue.recovery_action_resolved", entityType: "issue", entityId: coordinator.issueId,
      agentId: run?.agentId ?? null, runId: coordinator.runId,
      details: { reason: "native_completed_turn_cleanup_settled", recoveryActionIds: holds.map(hold => hold.id),
        ownerProof: context.proof.reason },
    });
    return coordinator.runId;
  });
  if (!settled) return { settled: false, reason: "hold_changed_since_proof" };
  // Settling starts no turn. Saved input and the task's own wait continue
  // through normal admission, which still checks every other gate.
  await settledHoldResumer?.({ companyId, runId: settled }).catch(error => {
    logger.warn({ err: error, runId: settled }, "settled completed-turn cleanup hold could not resume saved input");
  });
  return { settled: true, reason: context.proof.reason };
}
