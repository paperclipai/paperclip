import { LOW_TRUST_REVIEW_PRESET } from "@paperclipai/shared";

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
  options?: { lowTrust?: boolean; context?: AgentPermissionsContext },
): NormalizedAgentPermissions {
  return {
    canCreateAgents: options?.context === "create" && options?.lowTrust !== true,
    canCreateSkills: true,
  };
}

export function normalizeAgentPermissions(
  permissions: unknown,
  options?: { context?: AgentPermissionsContext },
): NormalizedAgentPermissions {
  const defaults = defaultAgentPermissions({
    lowTrust: permissionsImplyLowTrust(permissions),
    context: options?.context ?? "stored",
  });
  const record = asRecord(permissions);
  if (!record) {
    return defaults;
  }

  return {
    ...record,
    canCreateAgents:
      typeof record.canCreateAgents === "boolean"
        ? record.canCreateAgents
        : defaults.canCreateAgents,
    canCreateSkills:
      typeof record.canCreateSkills === "boolean"
        ? record.canCreateSkills
        : defaults.canCreateSkills,
  };
}
