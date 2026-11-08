import { and, eq, sql } from "drizzle-orm";
import { agents, type Db } from "@paperclipai/db";
import { persistActivity, publishActivity, type ActivityPublication } from "../activity-log.js";
import { DELIVERY_QUEUES, notifyDeliveryWork } from "../delivery-work-notifications.js";
import type { OwnerProof } from "../owner-proof.js";
import type { InProgressRecord, SettleOutcome } from "./ownership-registry.js";

/**
 * Settle of the `agent_lifecycle_lease` ownership kind.
 *
 * A lifecycle step (for example harness verification) holds a 120 s lease that
 * its process renews. A restart killed the holder, and the next process waited
 * out the lease before it could claim the step again, while the agent's runs
 * stayed queued. The shared reconciler calls this only after it proved the
 * stamped holder gone. Settle clears exactly that holder's lease, compare-and-
 * swap on the holder, so the lifecycle worker claims the step at once. It never
 * changes the lifecycle state, the operation, or its progress.
 */
export async function settleAgentLifecycleLease(db: Db, record: InProgressRecord,
  context: { now: Date; proof: OwnerProof }): Promise<SettleOutcome> {
  if (record.owner.kind !== "process") return { settled: false, reason: "owner_not_provable" };
  const stamp = record.owner.stamp;
  let publication: ActivityPublication | undefined;
  const outcome = await db.transaction(async transaction => {
    const tx = transaction as unknown as Db;
    const [agent] = await tx.select().from(agents).where(eq(agents.id, record.recordId)).for("update");
    const operation = agent?.lifecycleOperation;
    if (!agent || !operation?.leaseOwner || !operation.leaseUntil) return { settled: false, reason: "lease_no_longer_held" };
    // The proof judged this exact holder; a later claim is another owner.
    if (operation.leaseHolder?.bootId !== stamp.bootId || operation.leaseHolder?.pid !== stamp.pid) {
      return { settled: false, reason: "owner_changed_since_proof" };
    }
    // Register the wake intent before the write so drain and sleep checks see it.
    await notifyDeliveryWork(tx, DELIVERY_QUEUES.agentLifecycle);
    const [row] = await tx.update(agents).set({
      lifecycleOperation: sql`${agents.lifecycleOperation} - 'leaseOwner' - 'leaseUntil' - 'leaseHolder'`,
    }).where(and(eq(agents.id, agent.id), sql`${agents.lifecycleOperation}->>'leaseOwner' = ${operation.leaseOwner}`))
      .returning({ id: agents.id });
    if (!row) return { settled: false, reason: "lease_no_longer_held" };
    const activity = await persistActivity(tx, {
      companyId: agent.companyId, actorType: "system", actorId: "ownership-reconciler",
      action: "agent.lifecycle_lease_reconciled", entityType: "agent", entityId: agent.id, agentId: agent.id,
      details: {
        schema: "paperclip.agent-lifecycle-lease-settlement.v1", phase: agent.lifecycleState,
        operationId: operation.id, proof: context.proof.reason, previousLeaseUntil: operation.leaseUntil,
        reconciledAt: context.now.toISOString(),
      },
    });
    publication = activity.publication;
    return { settled: true, reason: context.proof.reason };
  });
  if (outcome.settled && publication) publishActivity(publication);
  return outcome;
}
