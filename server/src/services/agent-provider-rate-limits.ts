import { and, eq, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agentRuntimeState, agents } from "@paperclipai/db";
import {
  PROVIDER_RATE_LIMITS_STATE_KEY,
  mergeProviderRateLimitSnapshots,
  providerRateLimitSnapshotFromNotice,
  readProviderRateLimits,
} from "@paperclipai/shared";

/**
 * Keep the latest provider rate-limit snapshot an agent's harness reported.
 * The snapshot is account data the harness observed while running this agent;
 * it lives in the agent's company-scoped runtime state and never drives
 * execution (the provider-limit wait reads typed run failures instead).
 */
export async function recordAgentProviderRateLimits(
  db: Db,
  binding: { companyId: string; agentId: string },
  event: { eventType: string; payload: Record<string, unknown> },
): Promise<boolean> {
  const next = providerRateLimitSnapshotFromNotice(event.eventType, event.payload);
  if (!next) return false;
  const existing = await db
    .select({ stateJson: agentRuntimeState.stateJson })
    .from(agentRuntimeState)
    .where(and(eq(agentRuntimeState.agentId, binding.agentId), eq(agentRuntimeState.companyId, binding.companyId)))
    .then((rows) => rows[0] ?? null);
  const merged = mergeProviderRateLimitSnapshots(readProviderRateLimits(existing?.stateJson), next);
  const patch = JSON.stringify({ [PROVIDER_RATE_LIMITS_STATE_KEY]: merged });
  if (existing) {
    await db
      .update(agentRuntimeState)
      .set({ stateJson: sql`coalesce(${agentRuntimeState.stateJson}, '{}'::jsonb) || ${patch}::jsonb` })
      .where(and(eq(agentRuntimeState.agentId, binding.agentId), eq(agentRuntimeState.companyId, binding.companyId)));
    return true;
  }
  const agent = await db
    .select({ adapterType: agents.adapterType })
    .from(agents)
    .where(and(eq(agents.id, binding.agentId), eq(agents.companyId, binding.companyId)))
    .then((rows) => rows[0] ?? null);
  if (!agent) return false;
  await db
    .insert(agentRuntimeState)
    .values({
      agentId: binding.agentId,
      companyId: binding.companyId,
      adapterType: agent.adapterType,
      stateJson: { [PROVIDER_RATE_LIMITS_STATE_KEY]: merged },
    })
    .onConflictDoUpdate({
      target: agentRuntimeState.agentId,
      set: { stateJson: sql`coalesce(${agentRuntimeState.stateJson}, '{}'::jsonb) || ${patch}::jsonb` },
    });
  return true;
}

/** Runtime state keys that describe the provider account, not the session. */
export function preservedAccountRuntimeState(stateJson: Record<string, unknown> | null | undefined): Record<string, unknown> {
  const snapshot = stateJson?.[PROVIDER_RATE_LIMITS_STATE_KEY];
  return snapshot === undefined ? {} : { [PROVIDER_RATE_LIMITS_STATE_KEY]: snapshot };
}
