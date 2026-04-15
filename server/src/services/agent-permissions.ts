export type NormalizedAgentPermissions = Record<string, unknown> & {
  canCreateAgents: boolean;
};

const ROLES_WITH_CREATE_AGENTS = new Set(["ceo", "cto", "cmo", "coo"]);

export function defaultPermissionsForRole(role: string): NormalizedAgentPermissions {
  return {
    canCreateAgents: ROLES_WITH_CREATE_AGENTS.has(role),
  };
}

export function normalizeAgentPermissions(
  permissions: unknown,
  role: string,
): NormalizedAgentPermissions {
  const defaults = defaultPermissionsForRole(role);
  if (typeof permissions !== "object" || permissions === null || Array.isArray(permissions)) {
    return defaults;
  }

  const record = permissions as Record<string, unknown>;
  return {
    canCreateAgents:
      typeof record.canCreateAgents === "boolean"
        ? record.canCreateAgents
        : defaults.canCreateAgents,
  };
}
