import { LOW_TRUST_REVIEW_PRESET, type PermissionKey } from "@paperclipai/shared";

/** Direct grants for newly activated standard agents. Existing agents are not backfilled. */
export const NEW_STANDARD_AGENT_DEFAULT_GRANT_KEYS = [
  "agents:read",
  "agents:configure",
  "agents:suggest-changes",
  "skills:create",
  "skills:suggest-changes",
  "tools:manage_connections",
  "tools:manage_profiles",
  "tools:view_audit",
  "audit:view_agent_actions",
  "tools:use",
  "tools:manage_runtime",
  "inbox:manage",
  "tasks:assign",
  "tasks:assign_scope",
  "tasks:manage_active_checkouts",
] as const satisfies readonly PermissionKey[];

export function newStandardAgentGrantScope(
  permissionKey: PermissionKey,
  agentId: string,
): Record<string, unknown> | null {
  if (permissionKey === "tasks:assign_scope") return { subtreeRootAgentId: agentId };
  if (permissionKey === "inbox:manage") return { responsibleUserOnly: true };
  return null;
}

export type NormalizedAgentPermissions = Record<string, unknown> & {
  canCreateAgents: boolean;
  canCreateSkills: boolean;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Mirrors the agent-source low-trust markers consumed by
 * resolveCoreTrustPreset: the low-trust review preset (top-level or inside
 * authorizationPolicy) or a low-trust boundary. Defaults must never grant
 * agent-creation authority to a low-trust agent.
 */
export function permissionsImplyLowTrust(permissions: unknown): boolean {
  const record = asRecord(permissions);
  if (!record) return false;
  const authorizationPolicy = asRecord(record.authorizationPolicy);
  return (
    record.trustPreset === LOW_TRUST_REVIEW_PRESET ||
    authorizationPolicy?.trustPreset === LOW_TRUST_REVIEW_PRESET ||
    asRecord(record.reviewPreset)?.id === LOW_TRUST_REVIEW_PRESET ||
    asRecord(authorizationPolicy?.reviewPreset)?.id === LOW_TRUST_REVIEW_PRESET ||
    asRecord(authorizationPolicy?.trustBoundary) !== null
  );
}

/**
 * "create" is the context for permissions arriving on a new-agent write: the
 * hire/create default applies and the resolved value is persisted. "stored"
 * is the context for rows read back from the database: a row without an
 * explicit value stays fail-closed, so the default is never granted
 * retroactively to legacy or malformed records at read or enforcement time.
 */
export type AgentPermissionsContext = "create" | "stored";

export function defaultAgentPermissions(
  options?: { lowTrust?: boolean; context?: AgentPermissionsContext; role?: string | null },
): NormalizedAgentPermissions {
  return {
    // A CEO row without a recorded hiring restriction keeps its legacy hiring
    // authority, so reads report what enforcement allows.
    canCreateAgents: (options?.context === "create" || options?.role === "ceo") && options?.lowTrust !== true,
    canCreateSkills: true,
  };
}

/**
 * Records who turned off a CEO's hiring through the permissions control.
 * Several ordinary writes save canCreateAgents: false without meaning to
 * restrict a CEO: a full-object save of a stale read, an import update whose
 * manifest omits the field, and the low-trust default. So a saved false
 * restricts a CEO only together with this record.
 */
export const CEO_HIRING_DENIAL_KEY = "ceoHiringDeniedBy";
export type CeoHiringDenial = { actorType: "user" | "agent"; actorId: string | null; at: string };

export function ceoHiringDenial(permissions: unknown): CeoHiringDenial | null {
  const denial = asRecord(asRecord(permissions)?.[CEO_HIRING_DENIAL_KEY]);
  return denial && (denial.actorType === "user" || denial.actorType === "agent") && typeof denial.at === "string"
    ? { actorType: denial.actorType, actorId: typeof denial.actorId === "string" ? denial.actorId : null, at: denial.at }
    : null;
}

export function normalizeAgentPermissions(
  permissions: unknown,
  options?: { context?: AgentPermissionsContext; role?: string | null },
): NormalizedAgentPermissions {
  const lowTrust = permissionsImplyLowTrust(permissions);
  const defaults = defaultAgentPermissions({
    lowTrust,
    context: options?.context ?? "stored",
    role: options?.role,
  });
  const record = asRecord(permissions);
  if (!record) {
    return defaults;
  }

  const { [CEO_HIRING_DENIAL_KEY]: _denial, ...rest } = record;
  const denial = ceoHiringDenial(record);
  let canCreateAgents = typeof record.canCreateAgents === "boolean" ? record.canCreateAgents : defaults.canCreateAgents;
  // An unrecorded false on a CEO is not a restriction the board chose.
  if (options?.role === "ceo" && canCreateAgents === false && !denial) canCreateAgents = !lowTrust;
  return {
    ...rest,
    ...(canCreateAgents === false && denial ? { [CEO_HIRING_DENIAL_KEY]: denial } : {}),
    canCreateAgents,
    canCreateSkills:
      typeof record.canCreateSkills === "boolean"
        ? record.canCreateSkills
        : defaults.canCreateSkills,
  };
}
