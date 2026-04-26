import {
  AGENT_PRIORITY_TIERS,
  AGENT_PRIORITY_TIER_DEFAULTS_BY_ROLE,
  AGENT_PRIORITY_TIER_NAME_OVERRIDES,
  DEFAULT_AGENT_PRIORITY_TIER,
  type AgentPriorityTier,
  type AgentRole,
} from "./constants.js";
import { normalizeAgentUrlKey } from "./agent-url-key.js";

const AGENT_PRIORITY_TIER_SET: ReadonlySet<AgentPriorityTier> = new Set(
  AGENT_PRIORITY_TIERS,
);

export function isAgentPriorityTier(
  value: unknown,
): value is AgentPriorityTier {
  return (
    typeof value === "string" &&
    AGENT_PRIORITY_TIER_SET.has(value as AgentPriorityTier)
  );
}

export interface ResolveAgentPriorityTierInput {
  role: AgentRole | string | null | undefined;
  name?: string | null;
}

// Picks the default tier for an agent based on its role, with a small
// hand-curated by-name override map (case-insensitive, alphanumeric-only).
// Used by both the create/hire path and the startup backfill so they can't
// drift apart.
export function resolveDefaultAgentPriorityTier(
  input: ResolveAgentPriorityTierInput,
): AgentPriorityTier {
  const normalizedKey = normalizeAgentUrlKey(input.name)?.replace(/-/g, "");
  if (normalizedKey) {
    const override = AGENT_PRIORITY_TIER_NAME_OVERRIDES[normalizedKey];
    if (override) return override;
  }
  if (typeof input.role === "string") {
    const roleDefault = (
      AGENT_PRIORITY_TIER_DEFAULTS_BY_ROLE as Record<string, AgentPriorityTier>
    )[input.role];
    if (roleDefault) return roleDefault;
  }
  return DEFAULT_AGENT_PRIORITY_TIER;
}

// Reads a stored `priorityTier` value from an agent metadata blob, falling
// back to the role/name-derived default. Both `metadata` and the resolver
// inputs are optional so callers can pass whichever subset they have.
export function readAgentPriorityTier(
  metadata: Record<string, unknown> | null | undefined,
  fallback: ResolveAgentPriorityTierInput,
): AgentPriorityTier {
  if (metadata && typeof metadata === "object") {
    const raw = (metadata as Record<string, unknown>).priorityTier;
    if (isAgentPriorityTier(raw)) return raw;
  }
  return resolveDefaultAgentPriorityTier(fallback);
}

// Bumps a tier one step toward p0. p0 is already top-priority and stays p0.
// Used by the semaphore aging path.
export function bumpAgentPriorityTier(
  tier: AgentPriorityTier,
): AgentPriorityTier {
  const idx = AGENT_PRIORITY_TIERS.indexOf(tier);
  if (idx <= 0) return AGENT_PRIORITY_TIERS[0];
  return AGENT_PRIORITY_TIERS[idx - 1];
}

// Numeric rank for ordering (p0 -> 0, p3 -> 3). Lower wins.
export function agentPriorityTierRank(tier: AgentPriorityTier): number {
  return AGENT_PRIORITY_TIERS.indexOf(tier);
}
