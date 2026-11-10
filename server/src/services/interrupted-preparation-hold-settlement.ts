import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { heartbeatRuns, type Db } from "@paperclipai/db";
import { isInterruptedNativePreparation } from "./cancelled-native-startup.js";
import { LEGACY_RECOVERY_CAUSE, settleInterruptedNativeBootstrap } from "./legacy-execution-recovery.js";
import { logger } from "../middleware/logger.js";
import type { OwnerProof } from "./owner-proof.js";
import type { InProgressRecord, SettleOutcome } from "./recovery/ownership-registry.js";
import { OWNER_GONE_ATTESTATION_KEY } from "./recovery/owner-gone-attestation.js";
import { abandonedPreparedRemoteWorkspaceExists } from "./remote-workspace-abandoned-preparation.js";

/**
 * `legacy_interrupted_preparation_hold`: a run a graceful shutdown interrupted
 * while it was still preparing, held with `preserve_without_replay_v1`.
 *
 * The draining process terminalizes the run before the no-provider-work proof
 * can hold: its own controller is still live and its sandbox lease may still
 * be cleaning up. Once the controller is proven gone and every lease is
 * released with a confirmed stop, the existing proof decides, and a run with
 * no provider execution is settled and replayed in its own uncharged lane.
 *
 * Only holds the system recorded itself are listed: an operator decision (an
 * owner-gone attestation, an explicit user continuation, an assigned owner) is
 * never reopened. A workspace-restore hold (restore failure or recovery
 * evidence) belongs to restore recovery, unless the workspace already retired
 * the run's exact prepared epoch (`isAbandonedPreparedRemoteWorkspace`): then
 * nothing is left to restore and this kind settles it. A run with a lease still
 * cleaning up is not listed yet; the next pass lists it once the lease settles.
 */
export function heldInterruptedPreparationWhere() {
  return and(inArray(heartbeatRuns.status, ["interrupted", "failed"]), eq(heartbeatRuns.runtimeMode, "legacy"),
    isNull(heartbeatRuns.runtimeModeResolvedAt), eq(heartbeatRuns.executionStage, "preparing"),
    sql`exists (select 1 from issue_recovery_actions hold where hold.company_id = ${heartbeatRuns.companyId}
      and hold.cause = ${LEGACY_RECOVERY_CAUSE} and hold.fingerprint = 'legacy-execution:' || ${heartbeatRuns.id}::text
      and hold.evidence->>'runId' = ${heartbeatRuns.id}::text
      and hold.status = 'resolved' and hold.outcome = 'blocked' and hold.owner_user_id is null
      and hold.evidence->'automaticRecovery'->>'policy' = 'preserve_without_replay_v1'
      and hold.evidence->'automaticRecovery'->>'replay' = 'blocked'
      and not (hold.evidence ?| array['executionReconciliation', ${OWNER_GONE_ATTESTATION_KEY}, 'explicitUserContinuation'])
      and (not (hold.evidence ?| array['workspaceRestoreFailure', 'workspaceRestoreRecovery'])
        or ${abandonedPreparedRemoteWorkspaceExists()}))`,
    sql`not exists (select 1 from environment_leases lease where lease.company_id = ${heartbeatRuns.companyId}
      and lease.heartbeat_run_id = ${heartbeatRuns.id}
      and (lease.released_at is null or lease.status = 'pending_cleanup' or lease.cleanup_status = 'failed'))`);
}

/** Continues a settled preparation through the ordinary resume path
 * (`resumeRemoteStopComments`): it schedules the uncharged
 * `interrupted_preparation` successor and records the continuation. The
 * heartbeat service registers it; it owns the scheduling dependencies. */
type HeldPreparationResumer = (input: { companyId: string; runId: string }) => Promise<void>;
let heldPreparationResumer: HeldPreparationResumer | null = null;

export function registerHeldPreparationResumer(resumer: HeldPreparationResumer): void {
  heldPreparationResumer = resumer;
}

/**
 * Settle of the kind. The shared reconciler calls it only after
 * `proveOwnerGone` proved the run's recorded controller gone; a run without a
 * controller stamp, or one from another process space, is never settled. It
 * re-checks the existing durable proof (no coordinator, result or execution
 * events; leases released with stop receipts; workspace repair when needed)
 * and resolves the hold through `settleInterruptedNativeBootstrap`, whose row
 * locks make the transition, and the continuation it queues, happen once.
 */
export async function settleHeldInterruptedPreparation(db: Db, record: InProgressRecord,
  context: { now: Date; proof: OwnerProof }): Promise<SettleOutcome> {
  if (!record.companyId) return { settled: false, reason: "run_has_no_company" };
  const [run] = await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.id, record.recordId),
    eq(heartbeatRuns.companyId, record.companyId), heldInterruptedPreparationWhere()));
  if (!run) return { settled: false, reason: "no_longer_a_held_preparation" };
  if (!await isInterruptedNativePreparation(db, run)) {
    return { settled: false, reason: "provider_work_not_disproved", watch: false };
  }
  // Settling without the resume path would leave the task with no successor;
  // keep the hold for a process that runs the heartbeat service.
  if (!heldPreparationResumer) return { settled: false, reason: "resume_path_unavailable" };
  let resolved = 0;
  await settleInterruptedNativeBootstrap(db, { run, providerDispatchStarted: false, proof: context.proof.reason,
    onHoldsResolved: count => { resolved = count; } });
  if (resolved === 0) return { settled: false, reason: "hold_changed_since_proof" };
  // Only the call that resolved the hold starts the replay, so it starts once.
  await heldPreparationResumer({ companyId: record.companyId, runId: run.id }).catch(error => {
    // The hold is settled; its pending continuation stays recorded, and the
    // run's next resume (a wake or a cleanup completion) delivers it, as on
    // the run-control path. Logged so a stuck replay is visible.
    logger.warn({ err: error, runId: run.id }, "settled interrupted preparation could not schedule its replay");
  });
  return { settled: true, reason: context.proof.reason };
}
