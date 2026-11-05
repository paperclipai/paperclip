import { and, eq, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agentRuntimeState, agents } from "@paperclipai/db";
import {
  PROVIDER_RATE_LIMITS_STATE_KEY,
  mergeProviderRateLimitSnapshots,
  providerRateLimitSnapshotFromNotice,
  readProviderRateLimits,
} from "@paperclipai/shared";
import { publishLiveEvent } from "./live-events.js";

/**
 * Keep the latest provider rate-limit snapshot an agent's harness reported.
 * The snapshot is account data the harness observed while running this agent;
 * it lives in the agent's company-scoped runtime state and never drives
 * execution (the provider-limit wait reads typed run failures instead).
 *
 * Safe to repeat: replaying the same notice merges to the same snapshot.
 * Returns true when the stored snapshot changed.
 */
export async function recordAgentProviderRateLimits(
  db: Db,
  binding: { companyId: string; agentId: string },
  event: { eventType: string; payload: Record<string, unknown> },
): Promise<boolean> {
  const next = providerRateLimitSnapshotFromNotice(event.eventType, event.payload);
  if (!next) return false;
  const changed = await db.transaction(async (tx) => {
    const agent = await tx
      .select({ adapterType: agents.adapterType })
      .from(agents)
      .where(and(eq(agents.id, binding.agentId), eq(agents.companyId, binding.companyId)))
      .then((rows) => rows[0] ?? null);
    if (!agent) return false;
    await tx
      .insert(agentRuntimeState)
      .values({ agentId: binding.agentId, companyId: binding.companyId, adapterType: agent.adapterType, stateJson: {} })
      .onConflictDoNothing({ target: agentRuntimeState.agentId });
    // Lock the row so concurrent runs merge in order instead of overwriting.
    const existing = await tx
      .select({ stateJson: agentRuntimeState.stateJson })
      .from(agentRuntimeState)
      .where(and(eq(agentRuntimeState.agentId, binding.agentId), eq(agentRuntimeState.companyId, binding.companyId)))
      .for("update")
      .then((rows) => rows[0] ?? null);
    if (!existing) return false;
    const stored = readProviderRateLimits(existing.stateJson);
    const merged = mergeProviderRateLimitSnapshots(stored, next);
    if (stored && JSON.stringify(stored) === JSON.stringify(merged)) return false;
    const patch = JSON.stringify({ [PROVIDER_RATE_LIMITS_STATE_KEY]: merged });
    await tx
      .update(agentRuntimeState)
      .set({ stateJson: sql`coalesce(${agentRuntimeState.stateJson}, '{}'::jsonb) || ${patch}::jsonb` })
      .where(and(eq(agentRuntimeState.agentId, binding.agentId), eq(agentRuntimeState.companyId, binding.companyId)));
    return true;
  });
  if (changed) {
    publishLiveEvent({
      companyId: binding.companyId,
      type: "agent.runtime_state.updated",
      payload: { agentId: binding.agentId },
    });
  }
  return changed;
}

/** Runtime state keys that describe the provider account, not the session. */
export function preservedAccountRuntimeState(stateJson: Record<string, unknown> | null | undefined): Record<string, unknown> {
  const snapshot = stateJson?.[PROVIDER_RATE_LIMITS_STATE_KEY];
  return snapshot === undefined ? {} : { [PROVIDER_RATE_LIMITS_STATE_KEY]: snapshot };
}
