export type NormalizedAgentPermissions = Record<string, unknown> & {
  canCreateAgents: boolean;
};

/** Returns the default agent permissions for the given role (e.g. ceo gets canCreateAgents). */
export function defaultPermissionsForRole(role: string): NormalizedAgentPermissions {
  return {
    canCreateAgents: role === "ceo",
  };
}

/** Merges an agent's stored permissions with role-based defaults, ensuring required fields are present. */
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
