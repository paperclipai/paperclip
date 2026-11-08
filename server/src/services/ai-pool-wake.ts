import { agents, type Db } from "@paperclipai/db";
import { and, asc, eq, sql } from "drizzle-orm";
import { requestAgentLifecycleRecheckInTransaction } from "../modules/agent-lifecycle/index.js";
import { DELIVERY_QUEUES, notifyDeliveryWork } from "./delivery-work-notifications.js";
import { reopenNativeQuotaPoolWaits } from "./native-runtime/native-quota-wake.js";

/** Register work in the account/pool producer transaction, before its mutation. */
export async function reopenAiPoolWaits(tx: Db, input: { companyId: string; poolId?: string; connectionId?: string }) {
  const count = await reopenNativeQuotaPoolWaits(tx, input);
  const poolId = sql`coalesce(${agents.runtimeConfig}->'harnessPool'->>'poolId',
    case when ${agents.runtimeConfig}->'aiConnection'->>'mode' = 'router'
      then ${agents.runtimeConfig}->'aiConnection'->>'connectionId' end)`;
  // Account credentials can be shared across grants, so account updates recheck
  // the company's pool-bound verifications. Every probe revalidates eligibility.
  const waiting = await tx.select({ id: agents.id, version: agents.lifecycleVersion }).from(agents).where(and(
    eq(agents.companyId, input.companyId), eq(agents.lifecycleState, "verifying"),
    sql`not (${agents.lifecycleHolds} @> '["setup"]'::jsonb)`,
    sql`coalesce(${agents.lifecycleOperation}->>'hostComplete', 'false') <> 'true'`,
    input.poolId ? sql`${poolId} = ${input.poolId}` : sql`${poolId} is not null`,
  )).orderBy(asc(agents.id));
  for (const agent of waiting) {
    await requestAgentLifecycleRecheckInTransaction(tx, {
      companyId: input.companyId, agentId: agent.id, expectedVersion: agent.version,
    }, () => notifyDeliveryWork(tx, DELIVERY_QUEUES.agentLifecycle, input.companyId));
  }
  return count;
}
