import { and, eq, isNull, or, sql, type SQL } from "drizzle-orm";
import { agentWakeupRequests, heartbeatRuns, issueRecoveryActions, issues, nativeRunFinalizations, type Db } from "@paperclipai/db";
import type { ExecutionReconciliation } from "@paperclipai/shared";
import { logActivity } from "../activity-log.js";
import { DELIVERY_QUEUES, notifyDeliveryWork } from "../delivery-work-notifications.js";
import { issueService } from "../issues.js";
import { logger } from "../../middleware/logger.js";
import type { InProgressRecord, SettleOutcome } from "../recovery/ownership-registry.js";
import type { OwnerProof } from "../owner-proof.js";
import { OWNER_GONE_ATTESTATION_KEY } from "../recovery/owner-gone-attestation.js";
import { holdOwnsBlockedStatus } from "../recovery-hold-blocked-status.js";
import { notifyRoutineExecutionStatus } from "../routine-execution-status-notifications.js";
import { notifyStatusCardIssueChange } from "../status-card-notifications.js";
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
 *
 * Settling the holds is not enough when the run's own failure set the task's
 * Blocked status: nothing else ever releases it, so the task rested Blocked
 * with no blocker, no Retry and no next action. In the same
 * transaction, a Blocked status that a settled hold of the run still owns
 * (`holdOwnsBlockedStatus`) is released to `todo`, and one durable
 * continuation is recorded on that hold (`continuationDelivery: "pending"`).
 * The execution-continuation worker delivers it as a fresh session. Saved user
 * input owns the continuation instead, so the task never starts two turns. A task
 * that still waits on unfinished blocker tasks stays Blocked; their completion
 * wakes it. A Blocked status that a newer decision owns is kept. Holds that the
 * previous release settled without this decision are listed again until it is
 * recorded (`completedTurnCleanupSettlement.blockedStatus`), so those tasks
 * continue on the first pass after deploy, without a migration.
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

/** A hold of `runId` that this kind settled, in this or an earlier release,
 * with no recorded decision about the task's Blocked status yet. */
function settledHoldAwaitingBlockedStatusCondition(runId: SQL | string): SQL {
  return and(
    sql`${issueRecoveryActions.evidence}->>'runId' = ${runId}::text`,
    sql`${issueRecoveryActions.evidence}->'completedTurnCleanupSettlement'->>'runId' = ${runId}::text`,
    sql`${issueRecoveryActions.evidence}->'completedTurnCleanupSettlement'->'blockedStatus' is null`,
    eq(issueRecoveryActions.status, "resolved"),
    eq(issueRecoveryActions.outcome, "restored"),
  )!;
}

/** Coordinators of completed-turn cleanup quarantines that still have a
 * settleable no-replay hold, or a settled hold whose task is still Blocked
 * with no recorded decision about that status. */
export function completedTurnCleanupHoldWhere(): SQL {
  return and(
    isNull(nativeRunFinalizations.leaseOwner),
    sql`exists (select 1 from heartbeat_runs run where run.company_id = ${nativeRunFinalizations.companyId}
      and run.id = ${nativeRunFinalizations.runId} and run.runtime_mode = 'native' and run.status = 'failed'
      and run.error_code = ${NATIVE_SESSION_CLEANUP_QUARANTINED} and ${COMPLETED_TURN_CHECKPOINT})`,
    or(
      sql`exists (select 1 from ${issueRecoveryActions} where ${issueRecoveryActions.companyId} = ${nativeRunFinalizations.companyId}
        and ${settleableHoldCondition(sql`${nativeRunFinalizations.runId}`)})`,
      sql`exists (select 1 from ${issueRecoveryActions} join ${issues} on ${issues.id} = ${issueRecoveryActions.sourceIssueId}
          and ${issues.companyId} = ${issueRecoveryActions.companyId}
        where ${issueRecoveryActions.companyId} = ${nativeRunFinalizations.companyId}
          and ${issueRecoveryActions.sourceIssueId} = ${nativeRunFinalizations.issueId} and ${issues.status} = 'blocked'
          and ${settledHoldAwaitingBlockedStatusCondition(sql`${nativeRunFinalizations.runId}`)})`,
    ),
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
    const [issue] = await tx.select().from(issues).where(and(eq(issues.companyId, companyId),
      eq(issues.id, coordinator.issueId))).for("update");
    const [run] = await tx.select().from(heartbeatRuns)
      .where(and(eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.id, coordinator.runId)));
    if (!issue || !run) return null;
    const holds = await tx.update(issueRecoveryActions).set({
      outcome: "restored", ownerType: "system", updatedAt: now,
      resolutionNote: "The run finished its turn and saved its work; its session cleanup no longer blocks the task.",
      evidence: sql`(${issueRecoveryActions.evidence} - 'automaticRecovery') || ${JSON.stringify({
        completedTurnCleanupSettlement: { runId: coordinator.runId, settledAt: now.toISOString(), ownerProof: context.proof.reason },
      })}::jsonb`,
    }).where(and(eq(issueRecoveryActions.companyId, companyId), eq(issueRecoveryActions.sourceIssueId, coordinator.issueId),
      settleableHoldCondition(coordinator.runId))).returning({ id: issueRecoveryActions.id });
    if (holds.length) {
      await logActivity(tx as unknown as Db, { companyId, actorType: "system", actorId: "system",
        action: "issue.recovery_action_resolved", entityType: "issue", entityId: coordinator.issueId,
        agentId: run.agentId, runId: coordinator.runId,
        details: { reason: "native_completed_turn_cleanup_settled", recoveryActionIds: holds.map(hold => hold.id),
          ownerProof: context.proof.reason },
      });
    }
    const decided = await decideBlockedStatus(tx as unknown as Db, { companyId, issue, run, now });
    return holds.length || decided ? coordinator.runId : null;
  });
  if (!settled) return { settled: false, reason: "hold_changed_since_proof" };
  // Settling starts no turn itself. Saved input, the recorded continuation and
  // the task's own wait continue through normal admission, which still checks
  // every other gate.
  await settledHoldResumer?.({ companyId, runId: settled }).catch(error => {
    logger.warn({ err: error, runId: settled }, "settled completed-turn cleanup hold could not resume saved input");
  });
  return { settled: true, reason: context.proof.reason };
}

type BlockedStatusDecision = "released" | "dependency_wait" | "not_owned";

/** Recorded with the continuation. Admission of a reconciled continuation
 * requires workspace repair evidence after a restore failure; the settled
 * holds already required the run's files to be verified as saved. */
const CONTINUATION_EVIDENCE = "The run completed its provider turn and saved its work before its session cleanup was quarantined. "
  + "The controller that held the cleanup gate is proven gone, so the task continues in a fresh session.";
const WORKSPACE_EVIDENCE = "Workspace recovery verified this run's saved files, or the run had no unsaved files; "
  + "the continuation starts from that saved workspace.";

/**
 * Decides, once, what happens to the task's Blocked status after the run's
 * holds are settled, and records that decision on every settled hold of the
 * run so the kind does not list them again. Runs in the settlement
 * transaction with the issue row locked. Returns whether a decision was
 * recorded.
 */
async function decideBlockedStatus(tx: Db, input: { companyId: string; now: Date;
  issue: typeof issues.$inferSelect; run: typeof heartbeatRuns.$inferSelect }): Promise<boolean> {
  const { companyId, issue, run, now } = input;
  if (issue.status !== "blocked") return false;
  const settledHolds = await tx.select().from(issueRecoveryActions).where(and(eq(issueRecoveryActions.companyId, companyId),
    eq(issueRecoveryActions.sourceIssueId, issue.id), settledHoldAwaitingBlockedStatusCondition(run.id)))
    .orderBy(issueRecoveryActions.createdAt, issueRecoveryActions.id).for("update");
  if (!settledHolds.length) return false;
  // The hold that recorded the run's failure block is its receipt. Only holds
  // saved before receipts existed fall back to the block's timing.
  const receipts = settledHolds.filter(hold => hold.evidence.nativeFailureBlock !== undefined);
  const owner = (receipts.length ? receipts : settledHolds).find(hold => holdOwnsBlockedStatus(hold, issue, run)) ?? null;
  // Only the task's current assignee continues it.
  const ownsTask = Boolean(owner && issue.assigneeAgentId && issue.assigneeAgentId === run.agentId);
  // The shared dependency rule: an unfinished blocker task keeps the task
  // Blocked, and its completion wakes it (issue_blockers_resolved).
  const readiness = ownsTask ? await issueService(tx).listDependencyReadiness(companyId, [issue.id], tx) : null;
  const decision: BlockedStatusDecision = !ownsTask ? "not_owned"
    : readiness?.get(issue.id)?.isDependencyReady === true ? "released" : "dependency_wait";
  // Saved user input continues the task itself through normal admission (the
  // registered resumer). Recording a second continuation would start another
  // turn after it, so the input owns the continuation, as in
  // continueFromLastSavedWorkspace. A saved Retry that dispatch declined for
  // its requester is shown with a Retry that any user with access can press
  // (retry_authority_denied), so it is not a dead end either; a second,
  // automatic continuation could race that Retry once access returns.
  const [waitingInput] = decision === "released" ? await tx.select({ id: agentWakeupRequests.id }).from(agentWakeupRequests)
    .where(and(eq(agentWakeupRequests.companyId, companyId), eq(agentWakeupRequests.status, "deferred_issue_execution"),
      eq(agentWakeupRequests.requestedByActorType, "user"), sql`${agentWakeupRequests.payload}->>'issueId' = ${issue.id}`))
    .limit(1) : [];
  const continuationHoldId = decision === "released" && !waitingInput ? owner!.id : null;
  // Register the work before the writes it describes.
  if (decision === "released") {
    await notifyDeliveryWork(tx, DELIVERY_QUEUES.executionContinuation);
    await notifyDeliveryWork(tx, DELIVERY_QUEUES.issueMonitors);
    await notifyDeliveryWork(tx, DELIVERY_QUEUES.agentTimers);
    await notifyStatusCardIssueChange(tx, companyId);
    await notifyRoutineExecutionStatus(tx, issue.id, companyId);
  }
  const reconciliation: ExecutionReconciliation = { runId: run.id, providerStopped: true, actionOutcome: "completed",
    outcomeEvidence: CONTINUATION_EVIDENCE, workspaceRepairEvidence: WORKSPACE_EVIDENCE };
  for (const hold of settledHolds) {
    const continuation = hold.id === continuationHoldId;
    const marked = sql`jsonb_set(${issueRecoveryActions.evidence}, '{completedTurnCleanupSettlement,blockedStatus}', ${JSON.stringify(decision)}::jsonb)`;
    await tx.update(issueRecoveryActions).set({ updatedAt: now,
      ...(continuation ? {
        returnOwnerAgentId: run.agentId, nextAction: "The task continues in a fresh session.",
        evidence: sql`${marked} || ${JSON.stringify({
          executionReconciliation: { ...reconciliation, actorId: "completed-turn-cleanup", recordedAt: now.toISOString() },
          continuationDelivery: "pending" })}::jsonb`,
      } : { evidence: marked }),
    }).where(and(eq(issueRecoveryActions.companyId, companyId), eq(issueRecoveryActions.id, hold.id)));
  }
  if (decision !== "released") return true;
  await tx.update(issues).set({ status: "todo", unblockDescriptor: null, blockedTransitionAt: null,
    blockedOwnerNotifiedAt: null, updatedAt: now }).where(and(eq(issues.companyId, companyId), eq(issues.id, issue.id)));
  await logActivity(tx, { companyId, actorType: "system", actorId: "system", action: "issue.updated",
    entityType: "issue", entityId: issue.id, agentId: run.agentId, runId: run.id,
    details: { status: "todo", previousStatus: "blocked", reason: "native_completed_turn_cleanup_continued",
      recoveryActionId: owner!.id, continuation: continuationHoldId ? "recorded" : "saved_input", _previous: { status: "blocked" } } });
  return true;
}
