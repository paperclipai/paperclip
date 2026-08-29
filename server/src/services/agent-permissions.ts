export type NormalizedAgentPermissions = Record<string, unknown> & {
  canCreateAgents: boolean;
  canCreateSkills: boolean;
  canAssignTasks: boolean;
};

type AgentTaskAssignmentSubject = {
  role: string;
  permissions: Record<string, unknown> | null | undefined;
};

export function agentExplicitlyDeniesTaskAssignment(agent: AgentTaskAssignmentSubject): boolean {
  return agent.role.trim().toLowerCase() !== "ceo"
    && agent.permissions?.canAssignTasks === false;
}

export function defaultPermissionsForRole(role: string): NormalizedAgentPermissions {
  return {
    canCreateAgents: role.trim().toLowerCase() === "ceo",
    canCreateSkills: true,
    canAssignTasks: true,
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
    canCreateSkills:
      typeof record.canCreateSkills === "boolean"
        ? record.canCreateSkills
        : defaults.canCreateSkills,
    canAssignTasks:
      typeof record.canAssignTasks === "boolean"
        ? record.canAssignTasks
        : defaults.canAssignTasks,
  };
}
