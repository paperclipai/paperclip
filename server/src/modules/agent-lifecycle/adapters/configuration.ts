import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { agents, type Db } from "@paperclipai/db";
import { agentRecordQueries, AGENT_CONFIGURATION_FIELDS, jsonEqual, type AgentConfigurationPatch, type UpdateAgentOptions } from "../../../lib/agent-records.js";
import type { ActivityPublication } from "../../../types/activity-publication.js";
import { AgentLifecycleConflict } from "../domain/policy.js";
import type { LifecycleEffects } from "./effects.js";

export async function updateAgentConfiguration(tx: Db, effects: LifecycleEffects, id: string, data: AgentConfigurationPatch, options?: UpdateAgentOptions, publications: ActivityPublication[] = []) {
  if (!("nestedIndex" in tx)) throw new AgentLifecycleConflict("Configuration integration requires a database transaction");
  assertConfigurationFields(data);
  const [current] = await tx.select().from(agents).where(eq(agents.id, id)).for("update");
  if (!current) return null;
  const patch = await effects.prepareConfiguration(tx, current, data, options);
  assertConfigurationFields(patch);
  const changed = ["adapterType", "adapterConfig", "runtimeConfig", "defaultEnvironmentId"].some(key =>
    Object.prototype.hasOwnProperty.call(patch, key) && !jsonEqual(patch[key as keyof typeof patch], current[key as keyof typeof current]));
  const invalidate = changed && ["preparing", "verifying", "resuming"].includes(current.lifecycleState);
  const [updated] = await tx.update(agents).set({ ...patch, updatedAt: new Date(), ...(invalidate ? {
    lifecycleVersion: current.lifecycleVersion + 1, lifecycleError: null,
    lifecycleOperation: { ...current.lifecycleOperation!, id: randomUUID(), hostComplete: false,
      completedPluginIds: [], leaseOwner: undefined, leaseUntil: undefined, retryAt: undefined },
  } : {}) }).where(eq(agents.id, id)).returning();
  await effects.completeConfiguration(tx, current, updated, patch, options, publications);
  return agentRecordQueries(tx).getById(id);
}

function assertConfigurationFields(data: AgentConfigurationPatch) {
  if (Object.keys(data).some(field => !AGENT_CONFIGURATION_FIELDS.some(allowed => allowed === field))) {
    throw new AgentLifecycleConflict("Unsupported configuration field; use the command that owns this field, such as a lifecycle command");
  }
}
