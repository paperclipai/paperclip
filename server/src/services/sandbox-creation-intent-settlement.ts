import { and, eq, gt, sql } from "drizzle-orm";
import { sandboxCreationOperations, type Db } from "@paperclipai/db";
import { readControllerProcess } from "./controller-process-identity.js";
import { notifyEnvironmentCleanup } from "./environment-cleanup-notifications.js";
import type { OwnerProof } from "./owner-proof.js";
import type { InProgressRecord, SettleOutcome } from "./recovery/ownership-registry.js";

/**
 * Settle of the `sandbox_creation_intent` ownership kind (plan Phase 2).
 *
 * A creation intent is written before the provider call and names the server
 * process that makes it. While that process lives, the intent waits for its
 * settle deadline. Once the shared prover proves the creator gone, it cannot
 * still be waiting for the provider, so this settle makes the intent due now
 * and marks the creator lost; the creation recovery worker then reconciles it.
 *
 * It settles ownership only. Whether the sandbox exists is still decided by
 * the provider: absence stays inconclusive until the creation settle deadline
 * (`creationAbsenceInconclusive`), and an unidentifiable creation becomes an
 * operator reconciliation. A creator on another host is never proven gone by
 * a process proof; its intent keeps the deadline, which is the handoff.
 *
 * The update compares and swaps on the exact creator the proof judged and
 * only moves a deadline that is still in the future.
 */
export async function settleSandboxCreationIntent(db: Db, record: InProgressRecord,
  context: { now: Date; proof: OwnerProof }): Promise<SettleOutcome> {
  if (record.owner.kind !== "process") return { settled: false, reason: "owner_not_a_process" };
  const stamp = record.owner.stamp;
  const now = context.now;
  return db.transaction(async transaction => {
    const tx = transaction as unknown as Db;
    const [operation] = await tx.select().from(sandboxCreationOperations)
      .where(and(eq(sandboxCreationOperations.id, record.recordId), eq(sandboxCreationOperations.state, "pending")))
      .for("update");
    if (!operation) return { settled: false, reason: "intent_no_longer_pending" };
    if (operation.metadata.creationControllerLost === true) return { settled: false, reason: "creator_already_lost" };
    const creator = readControllerProcess(operation.metadata.creationController);
    if (!creator || creator.bootId !== stamp.bootId || creator.pid !== stamp.pid || creator.hostHash !== stamp.processSpace) {
      return { settled: false, reason: "owner_changed_since_proof" };
    }
    if (operation.nextAttemptAt <= now) return { settled: false, reason: "intent_already_due" };
    // Wake creation recovery before the write it announces.
    await notifyEnvironmentCleanup(tx, { companyId: operation.companyId, runId: operation.runId });
    const updated = await tx.update(sandboxCreationOperations).set({ nextAttemptAt: now, updatedAt: now,
      metadata: sql`coalesce(${sandboxCreationOperations.metadata}, '{}'::jsonb) || ${JSON.stringify({
        creationControllerLost: true, creationControllerLostProof: context.proof.reason })}::jsonb` })
      .where(and(eq(sandboxCreationOperations.id, operation.id), eq(sandboxCreationOperations.state, "pending"),
        gt(sandboxCreationOperations.nextAttemptAt, now),
        sql`coalesce(${sandboxCreationOperations.metadata}->>'creationControllerLost', '') <> 'true'`,
        sql`${sandboxCreationOperations.metadata}->'creationController' = ${JSON.stringify(operation.metadata.creationController)}::jsonb`))
      .returning({ id: sandboxCreationOperations.id });
    return updated.length ? { settled: true, reason: context.proof.reason } : { settled: false, reason: "intent_no_longer_pending" };
  });
}
