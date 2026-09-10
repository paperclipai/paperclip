import { LOW_TRUST_REVIEW_PRESET } from "@paperclipai/shared";

export type NormalizedAgentPermissions = Record<string, unknown> & {
  canCreateAgents: boolean;
  canCreateSkills: boolean;
  /**
   * Company coordination authority. Fail-closed everywhere except the
   * board-owned agent permissions update route: defaults are always false, the
   * create context forces false, and the import path strips the key before any
   * write. Enforcement must read this normalized boolean, never raw rows.
   */
  canCoordinateCompanyWork: boolean;
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
    // Coordination authority is never a default in any context, not even for
    // board-created agents: the board grants it after creation through the
    // permissions route, so no creation/import path can smuggle it in.
    canCoordinateCompanyWork: false,
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
    canCoordinateCompanyWork:
      // In the create context this is forced false regardless of input: new
      // agents (board-created, agent-hired, catalog-provisioned, imported)
      // never start with coordination authority. The stored context preserves
      // an explicit value so a board grant survives read normalization.
      options?.context === "create"
        ? false
        : typeof record.canCoordinateCompanyWork === "boolean"
          ? record.canCoordinateCompanyWork
          : defaults.canCoordinateCompanyWork,
  };
}

/**
 * Drops the coordination authority key from a permissions record without
 * touching any other field. Used by the company import path, where package
 * contents are untrusted input: an exported bundle must never be able to
 * reinstall coordination authority into the target company. Dropping the key
 * (instead of rewriting it) lets the downstream normalization default it to
 * false.
 */
export function stripAgentCoordinationAuthority(
  permissions: Record<string, unknown> | null | undefined,
): Record<string, unknown> | null | undefined {
  if (!permissions || !("canCoordinateCompanyWork" in permissions)) return permissions;
  const { canCoordinateCompanyWork: _dropped, ...rest } = permissions;
  return rest;
}
