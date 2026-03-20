export type NormalizedAgentPermissions = Record<string, unknown> & {
  canCreateAgents: boolean;
  canDeleteAgents: boolean;
  canTerminateAgents: boolean;
};

export function defaultPermissionsForRole(role: string): NormalizedAgentPermissions {
  return {
    canCreateAgents: role === "ceo",
    canDeleteAgents: false,
    canTerminateAgents: false,
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
    canDeleteAgents:
      typeof record.canDeleteAgents === "boolean"
        ? record.canDeleteAgents
        : defaults.canDeleteAgents,
    canTerminateAgents:
      typeof record.canTerminateAgents === "boolean"
        ? record.canTerminateAgents
        : defaults.canTerminateAgents,
  };
}
