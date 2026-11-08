import type { Db } from "@paperclipai/db";
import { releaseAgentLifecycleLeaseOfHolderInTransaction } from "../../modules/agent-lifecycle/index.js";
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
 * stamped holder gone. The lifecycle module releases exactly that holder's
 * lease (compare-and-swap), so the lifecycle worker claims the step at once.
 */
export async function settleAgentLifecycleLease(db: Db, record: InProgressRecord,
  context: { now: Date; proof: OwnerProof }): Promise<SettleOutcome> {
  if (record.owner.kind !== "process") return { settled: false, reason: "owner_not_provable" };
  const holder = { bootId: record.owner.stamp.bootId, pid: record.owner.stamp.pid };
  let publication: ActivityPublication | undefined;
  const outcome = await db.transaction(async transaction => {
    const tx = transaction as unknown as Db;
    const released = await releaseAgentLifecycleLeaseOfHolderInTransaction(tx, { agentId: record.recordId, holder },
      () => notifyDeliveryWork(tx, DELIVERY_QUEUES.agentLifecycle));
    if (!released.released) return { settled: false, reason: released.reason };
    const { agent } = released;
    const activity = await persistActivity(tx, {
      companyId: agent.companyId, actorType: "system", actorId: "ownership-reconciler",
      action: "agent.lifecycle_lease_reconciled", entityType: "agent", entityId: agent.id, agentId: agent.id,
      details: {
        schema: "paperclip.agent-lifecycle-lease-settlement.v1", phase: agent.lifecycleState,
        operationId: agent.lifecycleOperation?.id ?? null, proof: context.proof.reason, previousLeaseUntil: released.leaseUntil,
        reconciledAt: context.now.toISOString(),
      },
    });
    publication = activity.publication;
    return { settled: true, reason: context.proof.reason };
  });
  if (outcome.settled && publication) publishActivity(publication);
  return outcome;
}
