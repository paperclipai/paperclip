export type NormalizedAgentPermissions = Record<string, unknown> & {
  canCreateAgents: boolean;
  pluginTools: string[];
};

export function defaultPermissionsForRole(role: string): NormalizedAgentPermissions {
  return {
    canCreateAgents: role === "ceo",
    pluginTools: [],
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
  const preserved = { ...record };
  return {
    ...preserved,
    canCreateAgents:
      typeof record.canCreateAgents === "boolean"
        ? record.canCreateAgents
        : defaults.canCreateAgents,
    pluginTools: Array.isArray(record.pluginTools)
      ? record.pluginTools.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
      : defaults.pluginTools,
  };
}
