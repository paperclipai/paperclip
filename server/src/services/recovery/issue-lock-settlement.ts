import type { Db } from "@paperclipai/db";
import type { OwnerProof } from "../owner-proof.js";
import type { InProgressRecord, SettleOutcome } from "./ownership-registry.js";

/**
 * Settle of the `issue_execution_lock` and `issue_checkout_lock` ownership
 * kinds (plan Phase 2, taken over by Phase 3 for non-wake recovery).
 *
 * A task's lock is owned by the run it names. That run's terminal row, or a
 * missing row, is the proof the reconciler acts on; age never is. Settling
 * runs the stale-lock sweep for exactly this task, so the one compare-and-swap
 * clear decides: it re-reads both lock columns under the task row lock, keeps
 * a lock that a same-run resume, an explicit-retry claim, a manual admission
 * hold or a newly live run still needs, and releases messages waiting behind
 * the lock. The sweep loads lazily so the registry stays light.
 */
export async function settleIssueLock(db: Db, record: InProgressRecord,
  _context: { now: Date; proof: OwnerProof }): Promise<SettleOutcome> {
  if (record.owner.kind !== "run" || !record.companyId || !record.issueId) return { settled: false, reason: "owner_not_a_run" };
  const { recoveryService } = await import("./service.js");
  const result = await recoveryService(db, {
    // Clearing a stale lock never starts work itself; the release drain does.
    enqueueWakeup: async () => null,
  }).sweepStaleIssueLocks({ companyId: record.companyId, issueId: record.issueId });
  return result.issueIds.includes(record.issueId)
    ? { settled: true, reason: "stale_lock_cleared" }
    : { settled: false, reason: "lock_still_needed" };
}
