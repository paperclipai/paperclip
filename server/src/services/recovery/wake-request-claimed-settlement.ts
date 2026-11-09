import { and, eq, inArray, isNotNull } from "drizzle-orm";
import { agentWakeupRequests, heartbeatRuns, nativeRunFinalizations, type Db } from "@paperclipai/db";
import { notifyExternalConversationSettlement } from "../external-conversation-settlement-notifications.js";
import { notifyStrandedAgentStatus } from "../live-run-recovery-notifications.js";
import type { OwnerProof } from "../owner-proof.js";
import { TERMINAL_PHASES, type InProgressRecord, type SettleOutcome } from "./ownership-registry.js";

const TERMINAL_RUN_STATUSES = ["succeeded", "failed", "cancelled", "timed_out", "interrupted"] as const;

/** The wake status other settlement paths write for a finished run: run
 * completion writes `completed` or the run status, and a graceful shutdown
 * writes `cancelled` for an interrupted run. */
function wakeStatusFor(runStatus: string): string {
  if (runStatus === "succeeded") return "completed";
  if (runStatus === "interrupted") return "cancelled";
  return runStatus;
}

/**
 * Settle of the `wake_request_claimed` ownership kind (plan Phase 2).
 *
 * A claimed wake is owned by the run that claimed it, and that run settles it
 * when it finishes. A path that ends the run without that step leaves the wake
 * `claimed` for good (seen in a K4 wave: native restart recovery blocked the
 * run, and its assignment wake stayed claimed). The owner's terminal row is
 * the proof; age never is.
 *
 * Settle copies the run's outcome onto exactly that claim, the way the other
 * settlement paths do (`wakeStatusFor`). For a native run it waits until the
 * run row carries the coordinator's final phase, and reads it under the run
 * row lock, so it never records an outcome that projection later changes. The intent was
 * delivered (the run claimed it), so this is the delivered terminal reason.
 */
export async function settleClaimedWakeRequest(db: Db, record: InProgressRecord,
  context: { now: Date; proof: OwnerProof }): Promise<SettleOutcome> {
  if (record.owner.kind !== "run") return { settled: false, reason: "owner_not_a_run" };
  const runId = record.owner.runId;
  return db.transaction(async transaction => {
    const tx = transaction as unknown as Db;
    // Lock the run row, as native terminal projection does, so its final
    // outcome cannot change between this read and the wake write.
    const [run] = await tx.select({ id: heartbeatRuns.id, companyId: heartbeatRuns.companyId,
      agentId: heartbeatRuns.agentId, status: heartbeatRuns.status, runtimeMode: heartbeatRuns.runtimeMode,
      nativePhase: heartbeatRuns.nativePhase, finishedAt: heartbeatRuns.finishedAt, error: heartbeatRuns.error })
      .from(heartbeatRuns)
      .where(and(eq(heartbeatRuns.id, runId), inArray(heartbeatRuns.status, [...TERMINAL_RUN_STATUSES]),
        isNotNull(heartbeatRuns.finishedAt)))
      .for("update");
    if (!run) return { settled: false, reason: "owner_run_not_finished" };
    if (run.runtimeMode === "native") {
      const [coordinator] = await tx.select({ phase: nativeRunFinalizations.phase }).from(nativeRunFinalizations)
        .where(eq(nativeRunFinalizations.runId, run.id));
      // The coordinator commits before the run row is projected; settle only
      // once the projection carried that final phase onto the run. A legacy
      // `applied` row has no later projection.
      if (coordinator && (!TERMINAL_PHASES.includes(coordinator.phase)
        || (coordinator.phase !== "applied" && run.nativePhase !== coordinator.phase))) {
        return { settled: false, reason: "native_projection_pending" };
      }
    }
    const claim = and(eq(agentWakeupRequests.id, record.recordId), eq(agentWakeupRequests.companyId, run.companyId),
      eq(agentWakeupRequests.runId, run.id), eq(agentWakeupRequests.status, "claimed"));
    const [current] = await tx.select({ agentId: agentWakeupRequests.agentId }).from(agentWakeupRequests)
      .where(claim).for("update");
    if (!current) return { settled: false, reason: "claim_no_longer_held" };
    // Work intents before the write they announce (sleep-aware background work).
    await notifyExternalConversationSettlement(tx, { companyId: run.companyId });
    await notifyStrandedAgentStatus(tx, { companyId: run.companyId, agentId: current.agentId });
    const updated = await tx.update(agentWakeupRequests).set({
      status: wakeStatusFor(run.status),
      finishedAt: run.finishedAt, error: run.error, updatedAt: context.now,
    }).where(claim).returning({ id: agentWakeupRequests.id });
    return updated.length ? { settled: true, reason: context.proof.reason } : { settled: false, reason: "claim_no_longer_held" };
  });
}
