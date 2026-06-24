export type NormalizedAgentPermissions = Record<string, unknown> & {
  canCreateAgents: boolean;
  canResumeAgents: boolean;
};

export function defaultPermissionsForRole(role: string): NormalizedAgentPermissions {
  const isCeo = role.trim().toLowerCase() === "ceo";
  return {
    canCreateAgents: isCeo,
    canResumeAgents: isCeo,
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
    canResumeAgents:
      typeof record.canResumeAgents === "boolean"
        ? record.canResumeAgents
        : defaults.canResumeAgents,
  };
}
