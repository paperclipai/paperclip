export type NormalizedAgentPermissions = Record<string, unknown> & {
  canCreateAgents: boolean;
  canDelegate: boolean;
  canUseCornerstone: boolean;
};

export function defaultPermissionsForRole(role: string): NormalizedAgentPermissions {
  return {
    canCreateAgents: role === "ceo",
    canDelegate: false,
    canUseCornerstone: false,
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
    canDelegate:
      typeof record.canDelegate === "boolean"
        ? record.canDelegate
        : defaults.canDelegate,
    canUseCornerstone:
      typeof record.canUseCornerstone === "boolean"
        ? record.canUseCornerstone
        : defaults.canUseCornerstone,
  };
}
