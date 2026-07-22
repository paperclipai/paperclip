/**
 * Fallback "sister" lanes: cloned agents named after their primary with a
 * provider suffix (e.g. "GLaD0S-Codex", "GLaD0S-Grok"). Agent lists detect
 * the suffix to badge the lane and keep clones grouped under their primary
 * instead of scattering them through the list.
 */
export const FALLBACK_LANE_SUFFIXES = ["Codex", "Grok", "Hermes", "Gemini"] as const;

export type FallbackLane = (typeof FALLBACK_LANE_SUFFIXES)[number];

export type AgentFallbackLane = {
  base: string;
  lane: FallbackLane;
};

export function getAgentFallbackLane(name: string): AgentFallbackLane | null {
  for (const lane of FALLBACK_LANE_SUFFIXES) {
    const suffix = `-${lane}`;
    if (name.length > suffix.length && name.endsWith(suffix)) {
      return { base: name.slice(0, -suffix.length), lane };
    }
  }
  return null;
}

/**
 * Provider/model badge derived from an agent's CURRENT adapter (not its name),
 * so every agent — primaries included — shows what it actually runs on. The
 * exact model id goes in the tooltip; the pill shows the provider.
 */
export type AgentModelTone = "claude" | "gpt" | "grok" | "gemini";
export type AgentModelBadgeInfo = { label: string; tone: AgentModelTone; title: string };

function getAgentModelTitle(agent: {
  adapterType?: string | null;
  adapterConfig?: Record<string, unknown> | null;
}) {
  if (agent.adapterType === "antigravity_local") return "Antigravity";
  const configuredModel =
    agent.adapterConfig && typeof agent.adapterConfig.model === "string"
      ? (agent.adapterConfig.model as string)
      : "";
  return configuredModel || agent.adapterType || "";
}

export function getAgentModelBadge(agent: {
  adapterType?: string | null;
  adapterConfig?: Record<string, unknown> | null;
}): AgentModelBadgeInfo | null {
  const title = getAgentModelTitle(agent);
  switch (agent.adapterType) {
    case "claude_local":
      return { label: "Claude", tone: "claude", title };
    case "codex_local":
      return { label: "GPT", tone: "gpt", title };
    case "hermes_local":
    case "grok_local":
      return { label: "Grok", tone: "grok", title };
    case "antigravity_local":
      return { label: "Antigravity", tone: "gemini", title };
    case "gemini_local":
      return { label: "Gemini", tone: "gemini", title };
    default:
      return null;
  }
}

/**
 * Reorders agents so fallback-lane clones sit directly after their primary
 * agent. Agents without a lane suffix, and clones whose primary is not in
 * the list, keep their original relative order.
 */
export function groupAgentFallbackLanes<T extends { name: string }>(agents: T[]): T[] {
  const names = new Set(agents.map((agent) => agent.name));
  const clonesByBase = new Map<string, T[]>();
  for (const agent of agents) {
    const laneInfo = getAgentFallbackLane(agent.name);
    if (!laneInfo || !names.has(laneInfo.base)) continue;
    const clones = clonesByBase.get(laneInfo.base) ?? [];
    clones.push(agent);
    clonesByBase.set(laneInfo.base, clones);
  }
  if (clonesByBase.size === 0) return agents;

  const result: T[] = [];
  for (const agent of agents) {
    const laneInfo = getAgentFallbackLane(agent.name);
    if (laneInfo && names.has(laneInfo.base)) continue; // emitted after its primary
    result.push(agent);
    const clones = clonesByBase.get(agent.name);
    if (clones) result.push(...clones);
  }
  return result;
}

/**
 * Registry-driven lane membership for an agent. `lanePrimaryAgentId` is sourced
 * from `agent_fallback_sisters` (server-computed). An agent is the lane PRIMARY
 * when its lanePrimaryAgentId equals its own id; it is a SISTER when the value
 * is a different agent id. Null/undefined means the agent has no registry rows
 * and the name heuristic should be used as a fallback.
 */
export type AgentLaneRegistryInput = { id: string; lanePrimaryAgentId?: string | null };

export function getAgentRegistryLaneRole(
  agent: AgentLaneRegistryInput,
): "primary" | "sister" | null {
  const primaryId = agent.lanePrimaryAgentId;
  if (!primaryId) return null;
  return primaryId === agent.id ? "primary" : "sister";
}

/**
 * Reorders agents so registry-driven fallback sisters sit directly after their
 * registered primary, and (for agents with NO registry rows) falls back to the
 * existing name-based grouping. Registry membership wins over the name heuristic
 * whenever an agent has a non-null `lanePrimaryAgentId`.
 *
 * Within a registered lane, the primary is emitted first followed by its present
 * sisters in their incoming order. Agents whose registered primary is not in the
 * list keep their original position (they cannot be nested under an absent row).
 */
export function groupAgentFallbackLanesWithRegistry<
  T extends { id: string; name: string; lanePrimaryAgentId?: string | null },
>(agents: T[]): T[] {
  const hasRegistry = agents.some((agent) => Boolean(agent.lanePrimaryAgentId));
  if (!hasRegistry) return groupAgentFallbackLanes(agents);

  const idsPresent = new Set(agents.map((agent) => agent.id));
  // Sisters grouped by their registered primary id (only when the primary is in
  // the visible list AND the agent is genuinely a sister, not the primary).
  const sistersByPrimaryId = new Map<string, T[]>();
  for (const agent of agents) {
    const role = getAgentRegistryLaneRole(agent);
    if (role !== "sister") continue;
    const primaryId = agent.lanePrimaryAgentId as string;
    if (!idsPresent.has(primaryId)) continue;
    const sisters = sistersByPrimaryId.get(primaryId) ?? [];
    sisters.push(agent);
    sistersByPrimaryId.set(primaryId, sisters);
  }

  // Name-based clones for agents WITHOUT registry rows, so the two schemes can
  // coexist: a registry-less base still collects its -Codex/-Grok/... clones,
  // but only clones that themselves have no registry membership.
  const nameClonesByBase = new Map<string, T[]>();
  for (const agent of agents) {
    if (getAgentRegistryLaneRole(agent) !== null) continue; // registry-managed
    const laneInfo = getAgentFallbackLane(agent.name);
    if (!laneInfo || !idsPresent.size) continue;
    // Only nest under a base that is itself registry-less and present.
    const base = agents.find(
      (candidate) =>
        candidate.name === laneInfo.base && getAgentRegistryLaneRole(candidate) === null,
    );
    if (!base) continue;
    const clones = nameClonesByBase.get(base.id) ?? [];
    clones.push(agent);
    nameClonesByBase.set(base.id, clones);
  }

  const emitted = new Set<string>();
  const result: T[] = [];
  for (const agent of agents) {
    if (emitted.has(agent.id)) continue;
    const role = getAgentRegistryLaneRole(agent);
    // Skip registry sisters and name-based clones here; emitted after primary.
    if (role === "sister" && idsPresent.has(agent.lanePrimaryAgentId as string)) continue;
    if (role === null) {
      const laneInfo = getAgentFallbackLane(agent.name);
      const base =
        laneInfo &&
        agents.find(
          (candidate) =>
            candidate.name === laneInfo.base && getAgentRegistryLaneRole(candidate) === null,
        );
      if (base) continue; // emitted after its name-based primary
    }
    result.push(agent);
    emitted.add(agent.id);
    const registrySisters = sistersByPrimaryId.get(agent.id);
    if (registrySisters) {
      for (const sister of registrySisters) {
        if (emitted.has(sister.id)) continue;
        result.push(sister);
        emitted.add(sister.id);
      }
    }
    const nameClones = nameClonesByBase.get(agent.id);
    if (nameClones) {
      for (const clone of nameClones) {
        if (emitted.has(clone.id)) continue;
        result.push(clone);
        emitted.add(clone.id);
      }
    }
  }
  // Safety net: append anything not yet emitted (e.g. sisters whose primary was
  // filtered out of the visible list) in original order.
  for (const agent of agents) {
    if (!emitted.has(agent.id)) {
      result.push(agent);
      emitted.add(agent.id);
    }
  }
  return result;
}
