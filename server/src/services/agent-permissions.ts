export type NormalizedAgentPermissions = Record<string, unknown> & {
  canCreateAgents: boolean;
  canAssignTasks: boolean;
};

export function defaultPermissionsForRole(role: string): NormalizedAgentPermissions {
  return {
    canCreateAgents: role === "ceo",
    canAssignTasks: role === "ceo",
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

  // canCreateAgents implies canAssignTasks (backfill and invariant).
  // An explicit canAssignTasks: true is also sufficient on its own.
  const canAssignTasks =
    canCreateAgents ||
    (typeof record.canAssignTasks === "boolean" ? record.canAssignTasks : defaults.canAssignTasks);

  return { canCreateAgents, canAssignTasks };
}
