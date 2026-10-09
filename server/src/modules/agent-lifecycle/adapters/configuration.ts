import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { agents, type Db } from "@paperclipai/db";
import { AgentLifecycleConflict } from "../domain/policy.js";

/** Configuration and verification invalidation must commit together. */
export async function invalidateAgentVerification(tx: Db, id: string) {
  if (!("nestedIndex" in tx)) throw new AgentLifecycleConflict("Verification invalidation requires the configuration transaction");
  const [agent] = await tx.select().from(agents).where(eq(agents.id, id)).for("update");
  if (!agent || !["preparing", "verifying", "resuming"].includes(agent.lifecycleState)) return;
  await tx.update(agents).set({ lifecycleVersion: agent.lifecycleVersion + 1, lifecycleError: null,
    lifecycleOperation: { ...agent.lifecycleOperation!, id: randomUUID(), hostComplete: false,
      completedPluginIds: [], leaseOwner: undefined, leaseUntil: undefined, retryAt: undefined },
  }).where(and(eq(agents.id, id), inArray(agents.lifecycleState, ["preparing", "verifying", "resuming"])));
}
