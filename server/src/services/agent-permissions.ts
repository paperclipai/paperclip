export type NormalizedAgentPermissions = Record<string, unknown> & {
  canCreateAgents: boolean;
};

const SKILL_REFRESH_DEFAULT_ROLES = new Set(["ceo", "cto", "engineer", "qa", "devops"]);

export function defaultPermissionsForRole(role: string): NormalizedAgentPermissions {
  return {
    canCreateAgents: role === "ceo",
    "skills:refresh": SKILL_REFRESH_DEFAULT_ROLES.has(role),
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
    "skills:refresh":
      typeof record["skills:refresh"] === "boolean"
        ? record["skills:refresh"]
        : defaults["skills:refresh"],
  };
}
