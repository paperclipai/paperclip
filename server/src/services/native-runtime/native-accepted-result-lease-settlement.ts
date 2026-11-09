import { and, eq, gt, inArray, isNull, notLike, sql } from "drizzle-orm";
import { heartbeatRuns, nativeRunFinalizations, type Db } from "@paperclipai/db";
import { notifyLiveRunRecovery } from "../live-run-recovery-notifications.js";
import { notifyNativeFinalizationWork } from "../native-finalization-notifications.js";
import { notifyNativeResultCommit } from "../native-result-commit-notifications.js";
import type { OwnerProof } from "../owner-proof.js";
import type { InProgressRecord, SettleOutcome } from "../recovery/ownership-registry.js";
import { requestNativeControllerStopConfirmation } from "./native-controller-host-recovery.js";
import { recordLegacyHostFallbackProof } from "./native-restart-recovery.js";

/**
 * Settle of the `native_accepted_result_lease` ownership kind (plan Phase 2).
 *
 * A hard kill (SIGKILL, OOM, host crash) after `run.result` is accepted leaves
 * the result leased to the killed controller. A graceful drain expires that
 * lease itself; a killed process cannot. Without this settle, finalization
 * waits out the lease (up to 20 minutes) and the run stays `running` with its
 * follow-up work held (RC-41).
 *
 * The shared reconciler calls this only after `proveOwnerGone` proved the
 * recorded controller gone. Settle expires exactly that lease: a lease taken
 * over since the proof, a run that already finished (other than a run cancelled
 * after its result was accepted), and remote copyback (fenced by its own
 * controller lease) are left alone. It settles ownership only; the
 * accepted result is finalized by the finalizer that the notifications wake.
 */
export async function settleNativeAcceptedResultLease(db: Db, record: InProgressRecord,
  context: { now: Date; proof: OwnerProof }): Promise<SettleOutcome> {
  if (record.owner.kind !== "process") return { settled: false, reason: "owner_not_a_process" };
  const stamp = record.owner.stamp;
  const { now, proof } = context;
  return db.transaction(async transaction => {
    const tx = transaction as unknown as Db;
    const [row] = await tx.select({
      runId: nativeRunFinalizations.runId, companyId: nativeRunFinalizations.companyId,
      issueId: nativeRunFinalizations.issueId, agentId: heartbeatRuns.agentId,
      leaseOwner: nativeRunFinalizations.leaseOwner, controllerBootId: nativeRunFinalizations.controllerBootId,
      controllerPid: nativeRunFinalizations.controllerPid, controllerHostHash: nativeRunFinalizations.controllerHostHash,
      controllerProcessStartedAt: nativeRunFinalizations.controllerProcessStartedAt,
      remote: sql<boolean>`(${heartbeatRuns.runnerProfileJson}->'nativeWorkspaceSync' is not null
        or ${heartbeatRuns.runnerProfileJson}->'remoteWorkspace' is not null)`,
    }).from(nativeRunFinalizations)
      .innerJoin(heartbeatRuns, and(eq(heartbeatRuns.id, nativeRunFinalizations.runId),
        eq(heartbeatRuns.companyId, nativeRunFinalizations.companyId),
        eq(heartbeatRuns.nativeIssueId, nativeRunFinalizations.issueId)))
      .where(and(eq(nativeRunFinalizations.runId, record.recordId), eq(heartbeatRuns.runtimeMode, "native"),
        // A run cancelled after its result was accepted (for example by a
        // budget pause) still owes finalization, and the dead lease would
        // hold it, and the agent's pause, for the lease's full term.
        inArray(heartbeatRuns.status, ["running", "cancelled"]), gt(nativeRunFinalizations.leaseExpiresAt, now),
        notLike(nativeRunFinalizations.leaseOwner, "native-finalizer:%"),
        notLike(nativeRunFinalizations.leaseOwner, "native-cleanup:%")))
      .for("update", { of: nativeRunFinalizations });
    if (!row?.leaseOwner) return { settled: false, reason: "lease_no_longer_held" };
    // Remote copyback is fenced by its own controller lease, never by a local proof.
    if (row.remote) return { settled: false, reason: "remote_lease_fenced" };
    // The proof judged this exact controller; a different one holds it now.
    if (row.controllerBootId !== stamp.bootId || row.controllerPid !== stamp.pid
      || (row.controllerHostHash ?? null) !== (stamp.processSpace ?? null)
      || (row.controllerProcessStartedAt?.toISOString() ?? null) !== (stamp.processStartedAt ?? null)) {
      return { settled: false, reason: "owner_changed_since_proof" };
    }
    // Work intents before the write they announce (sleep-aware background work).
    await notifyLiveRunRecovery(tx, { companyId: row.companyId, runId: row.runId, agentId: row.agentId });
    await notifyNativeResultCommit(tx, { companyId: row.companyId, runId: row.runId, issueId: row.issueId });
    await notifyNativeFinalizationWork(tx, { companyId: row.companyId, runId: row.runId });
    // Compare-and-set on the exact dead owner. Each lease owner token is
    // unique; the stored expiry is not compared because Postgres keeps
    // microseconds that a JavaScript Date drops.
    const updated = await tx.update(nativeRunFinalizations).set({ leaseExpiresAt: now, updatedAt: now })
      .where(and(eq(nativeRunFinalizations.runId, row.runId), eq(nativeRunFinalizations.leaseOwner, row.leaseOwner),
        gt(nativeRunFinalizations.leaseExpiresAt, now),
        row.controllerBootId === null ? isNull(nativeRunFinalizations.controllerBootId)
          : eq(nativeRunFinalizations.controllerBootId, row.controllerBootId),
        row.controllerPid === null ? isNull(nativeRunFinalizations.controllerPid)
          : eq(nativeRunFinalizations.controllerPid, row.controllerPid)))
      .returning({ runId: nativeRunFinalizations.runId });
    if (!updated.length) return { settled: false, reason: "lease_no_longer_held" };
    if (proof.legacyHostFallback) {
      await recordLegacyHostFallbackProof(tx, { companyId: row.companyId, id: row.runId, agentId: row.agentId },
        { allowed: true, reason: proof.reason, legacyHostFallback: true }, "dead_controller_result_lease");
    }
    return { settled: true, reason: proof.reason };
  });
}

/** An ephemeral server cannot judge a controller saved before its host was
 * recorded; the board confirms that the previous server stopped (#19883).
 * Every other unprovable owner is on another host and keeps its lease: the
 * lease is the fence, and a different host is never proof. */
export async function requestNativeAcceptedResultLeaseOperatorAction(db: Db, record: InProgressRecord,
  context: { now: Date; proof: OwnerProof }): Promise<void> {
  if (context.proof.reason !== "process_space_unrecorded" || record.owner.kind !== "process" || !record.issueId
    || !record.companyId) return;
  const stamp = record.owner.stamp;
  // Ask only while this exact controller still holds an outstanding lease:
  // an expired or taken-over lease no longer needs the board's proof.
  const [held] = await db.select({ runId: nativeRunFinalizations.runId }).from(nativeRunFinalizations)
    .where(and(eq(nativeRunFinalizations.runId, record.recordId), gt(nativeRunFinalizations.leaseExpiresAt, context.now),
      isNull(nativeRunFinalizations.controllerHostHash),
      stamp.bootId === null ? isNull(nativeRunFinalizations.controllerBootId) : eq(nativeRunFinalizations.controllerBootId, stamp.bootId),
      stamp.pid === null ? isNull(nativeRunFinalizations.controllerPid) : eq(nativeRunFinalizations.controllerPid, stamp.pid)));
  if (!held) return;
  await requestNativeControllerStopConfirmation(db, {
    runId: record.recordId, companyId: record.companyId, issueId: record.issueId,
    controllerBootId: stamp.bootId, controllerPid: stamp.pid,
    controllerProcessStartedAt: stamp.processStartedAt ? new Date(stamp.processStartedAt) : null,
  });
}
