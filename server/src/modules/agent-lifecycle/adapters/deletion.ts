import { agents, type Db } from "@paperclipai/db";
import { and, eq, inArray } from "drizzle-orm";
import { conflict } from "../../../errors.js";
import { agentRecordQueries } from "../../../lib/agent-records.js";
import { readBuiltInAgentMarker } from "../../../lib/built-in-agent-metadata.js";
import { assertAgentPurgeAllowed } from "../domain/policy.js";
import type { LifecycleEffects } from "./effects.js";

export async function purgeAgent(db: Db, effects: LifecycleEffects, id: string) {
  const { getById, normalizeAgentRow } = agentRecordQueries(db);
  const existing = await getById(id);
  if (!existing) return null;
  return effects.transaction(db, existing.companyId, async tx => {
    const [agent] = await tx.select().from(agents).where(eq(agents.id, id)).for("update");
    if (!agent) return null;
    const marker = readBuiltInAgentMarker(agent.metadata);
    if (marker) throw conflict("Built-in agents cannot be deleted; pause them instead", {
      code: "built_in_agent_undeletable", key: marker.key, featureKeys: marker.featureKeys,
    });
    assertAgentPurgeAllowed(agent);
    await effects.deleteDependencies(tx, agent.companyId, id);
    const [deleted] = await tx.delete(agents).where(and(
      eq(agents.id, id), inArray(agents.lifecycleState, ["terminated", "rejected"]),
    )).returning();
    return deleted ? normalizeAgentRow(deleted) : null;
  });
}
