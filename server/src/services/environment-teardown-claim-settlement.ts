import { and, eq, sql } from "drizzle-orm";
import { environmentLeases, type Db } from "@paperclipai/db";
import {
  PENDING_CLEANUP_ATTEMPTS_METADATA_KEY,
  pendingCleanupAttemptsSql,
  pendingCleanupMetadataObjectSql,
} from "./environment-cleanup-state.js";
import type { OwnerProof } from "./owner-proof.js";
import type { InProgressRecord, SettleOutcome } from "./recovery/ownership-registry.js";

/**
 * Settle of the `environment_teardown_claim` ownership kind (plan Phase 2).
 *
 * A teardown claim fences other cleanup for 15 minutes while its claimant
 * destroys or stops a sandbox. A claimant process that died cannot still be
 * running the teardown, so once the shared prover proves the claimant stamped
 * for this exact attempt gone, the fence ends now and the pending-cleanup
 * sweep may claim the lease again. A dead server is not a failed teardown: a
 * sweep claim that counted its attempt gets it back.
 *
 * The reconciler calls this only for a process owner. A claim held as a fence
 * (another claimant, or another host) is never proven gone by a process proof;
 * it waits for its deadline, which is the remote handoff.
 *
 * The update compares and swaps on the exact attempt and claimant the proof
 * judged, and it is single-use: it matches only while the fence is still in
 * the future and it consumes `countedAttempt`, so an overlapping settle cannot
 * refund the attempt twice. It settles ownership only; whether the sandbox
 * still owes a stop, a destroy or a retained workspace is unchanged.
 */
export async function settleEnvironmentTeardownClaim(db: Db, record: InProgressRecord,
  context: { now: Date; proof: OwnerProof }): Promise<SettleOutcome> {
  if (record.owner.kind !== "process") return { settled: false, reason: "claim_held_as_fence" };
  const stamp = record.owner.stamp;
  const nowMs = context.now.getTime();
  return db.transaction(async transaction => {
    const tx = transaction as unknown as Db;
    const [lease] = await tx.select({ metadata: environmentLeases.metadata }).from(environmentLeases)
      .where(and(eq(environmentLeases.id, record.recordId), eq(environmentLeases.status, "pending_cleanup")))
      .for("update");
    const metadata = lease?.metadata ?? null;
    const attemptId = typeof metadata?.pendingCleanupAttemptId === "string" ? metadata.pendingCleanupAttemptId : null;
    const controller = metadata?.pendingCleanupController as Record<string, unknown> | undefined;
    if (!attemptId || metadata?.pendingCleanupInFlight !== true) return { settled: false, reason: "claim_no_longer_in_flight" };
    if (controller?.attemptId !== attemptId || controller.bootId !== stamp.bootId || controller.pid !== stamp.pid
      || controller.hostHash !== stamp.processSpace) {
      return { settled: false, reason: "owner_changed_since_proof" };
    }
    const expiresAtMs = metadata?.pendingCleanupLeaseExpiresAtMs;
    if (typeof expiresAtMs !== "number" || expiresAtMs <= nowMs) return { settled: false, reason: "fence_already_ended" };
    const returnAttempt = controller?.countedAttempt === true;
    const updated = await tx.update(environmentLeases)
      .set({ metadata: sql`jsonb_set(jsonb_set(jsonb_set(${pendingCleanupMetadataObjectSql()},
        '{pendingCleanupLeaseExpiresAtMs}', to_jsonb(${nowMs}::bigint)),
        array[${PENDING_CLEANUP_ATTEMPTS_METADATA_KEY}],
        to_jsonb(greatest(${pendingCleanupAttemptsSql()} - ${returnAttempt ? 1 : 0}, 0)::int), true),
        '{pendingCleanupController,countedAttempt}', 'false'::jsonb, true)` })
      .where(and(
        eq(environmentLeases.id, record.recordId),
        eq(environmentLeases.status, "pending_cleanup"),
        sql`${environmentLeases.metadata}->>'pendingCleanupInFlight' = 'true'`,
        sql`(${environmentLeases.metadata}->>'pendingCleanupLeaseExpiresAtMs')::numeric > ${nowMs}`,
        sql`${environmentLeases.metadata}->>'pendingCleanupAttemptId' = ${attemptId}`,
        sql`${environmentLeases.metadata}->'pendingCleanupController'->>'attemptId' = ${attemptId}`,
        sql`coalesce(${environmentLeases.metadata}->'pendingCleanupController'->>'countedAttempt', 'false') = ${returnAttempt ? "true" : "false"}`,
      ))
      .returning({ id: environmentLeases.id });
    return updated.length ? { settled: true, reason: context.proof.reason } : { settled: false, reason: "claim_no_longer_in_flight" };
  });
}
