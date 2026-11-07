import { and, eq, isNull } from "drizzle-orm";
import { heartbeatRuns, nativeRunFinalizations, type Db } from "@paperclipai/db";
import { notifyExecutionRunWork } from "../execution-control-notifications.js";
import type { NativeRestartRecoveryClaim } from "./native-restart-recovery.js";

/** Claims whose previous runner process is verified gone. A reattach claim
 * still has a live runner, so its coordinator keeps its own recovery owner. */
const SETTLEABLE_CLAIMS = new Set<NativeRestartRecoveryClaim["kind"]>(["bootstrap_incomplete", "resume_dead_runner"]);

/**
 * RC-58: a restart recovery claims the run's native coordinator, then prepares
 * the run again. When that preparation fails before any provider dispatch, the
 * run is already failed but the claim would keep the coordinator `observed`
 * and owned. That reads as unfinished native accounting and an unsettled
 * controller, so a later Retry can never be admitted. Settle exactly this
 * claim as a terminal failure. A coordinator that another owner holds, or one
 * with a result, is left unchanged. Returns whether this call settled it.
 */
export async function settleFailedNativeRecoveryPreparation(db: Db, input: {
  companyId: string; runId: string; claim: Pick<NativeRestartRecoveryClaim, "kind" | "leaseOwner">;
}): Promise<boolean> {
  if (!SETTLEABLE_CLAIMS.has(input.claim.kind)) return false;
  return db.transaction(async tx => {
    const [run] = await tx.select({ status: heartbeatRuns.status, errorCode: heartbeatRuns.errorCode })
      .from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, input.companyId), eq(heartbeatRuns.id, input.runId)))
      .for("update");
    if (run?.status !== "failed") return false;
    const now = new Date();
    const [settled] = await tx.update(nativeRunFinalizations).set({
      phase: "terminal_failure", leaseOwner: null, leaseExpiresAt: null, nextAttemptAt: null, controlDeadlineAt: null,
      failureCode: run.errorCode ?? "native_recovery_preparation_failed",
      failureDetail: { recoveryPreparationFailed: { claim: input.claim.kind, errorCode: run.errorCode },
        nextAction: "Preparation failed before the provider was started again. Retry the task." },
      recoveryState: "blocked", updatedAt: now,
    }).where(and(
      eq(nativeRunFinalizations.companyId, input.companyId), eq(nativeRunFinalizations.runId, input.runId),
      eq(nativeRunFinalizations.phase, "observed"), eq(nativeRunFinalizations.leaseOwner, input.claim.leaseOwner),
      isNull(nativeRunFinalizations.resultId),
    )).returning({ runId: nativeRunFinalizations.runId });
    if (!settled) return false;
    await tx.update(heartbeatRuns).set({ nativePhase: "terminal_failure", nativePhaseUpdatedAt: now, executionControlDeadlineAt: null })
      .where(and(eq(heartbeatRuns.companyId, input.companyId), eq(heartbeatRuns.id, input.runId)));
    await notifyExecutionRunWork(tx as unknown as Db, { companyId: input.companyId });
    return true;
  });
}
