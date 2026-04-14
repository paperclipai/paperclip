export type NormalizedAgentPermissions = Record<string, unknown> & {
  canCreateAgents: boolean;
  "tasks:assign"?: boolean;
};

export function defaultPermissionsForRole(role: string): NormalizedAgentPermissions {
  return {
    canCreateAgents: role === "ceo",
    "tasks:assign": false,
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
    "tasks:assign":
      typeof record["tasks:assign"] === "boolean"
        ? record["tasks:assign"]
        : defaults["tasks:assign"],
  };
}
