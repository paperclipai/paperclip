export type NormalizedAgentPermissions = Record<string, unknown> & {
  canCreateAgents: boolean;
  canManageSkills: boolean;
};

export function defaultPermissionsForRole(role: string): NormalizedAgentPermissions {
  const isCeo = role === "ceo";
  return {
    canCreateAgents: isCeo,
    canManageSkills: isCeo,
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
  const canCreateAgents =
    typeof record.canCreateAgents === "boolean"
      ? record.canCreateAgents
      : defaults.canCreateAgents;
  // Inherit skill-management from canCreateAgents when unset so existing
  // admin-class agents (CEO and any pre-split holders of canCreateAgents)
  // do not silently lose skill-install rights when the field is absent.
  const canManageSkills =
    typeof record.canManageSkills === "boolean"
      ? record.canManageSkills
      : canCreateAgents;
  return {
    canCreateAgents,
    canManageSkills,
  };
}
