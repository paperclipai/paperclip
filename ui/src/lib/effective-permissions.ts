import type { Agent, EffectivePermissionSummary, Goal, PermissionKey } from "@paperclipai/shared";

export function findEffectivePermission(
  permissions: EffectivePermissionSummary[] | null | undefined,
  permissionKey: PermissionKey,
) {
  return permissions?.find((permission) => permission.permissionKey === permissionKey) ?? null;
}

export function canUseDepartment(
  permission: EffectivePermissionSummary | null | undefined,
  departmentId: string | null | undefined,
) {
  if (!permission) return false;
  if (permission.companyWide) return true;
  if (!departmentId) return false;
  return permission.departmentIds.includes(departmentId);
}

export function filterByPermissionScope<T extends { departmentId: string | null }>(
  items: T[],
  permission: EffectivePermissionSummary | null | undefined,
) {
  if (!permission) return items;
  if (permission.companyWide) return items;
  return items.filter((item) => item.departmentId && permission.departmentIds.includes(item.departmentId));
}

export function defaultScopedDepartmentId(
  permission: EffectivePermissionSummary | null | undefined,
  availableDepartmentIds: string[],
) {
  if (!permission || permission.companyWide) return "";
  const matchingDepartmentIds = availableDepartmentIds.filter((departmentId) =>
    permission.departmentIds.includes(departmentId),
  );
  return matchingDepartmentIds.length === 1 ? matchingDepartmentIds[0]! : "";
}

export function filterAgentsForDepartmentContext<T extends Pick<Agent, "id" | "departmentId">>(
  agents: T[],
  permission: EffectivePermissionSummary | null | undefined,
  departmentId: string | null | undefined,
  options?: { preserveIds?: string[] },
) {
  const preserveIds = new Set(options?.preserveIds ?? []);
  return agents.filter((agent) => {
    if (preserveIds.has(agent.id)) return true;
    if (permission && !permission.companyWide) {
      if (!agent.departmentId || !permission.departmentIds.includes(agent.departmentId)) return false;
    }
    if (!departmentId) return true;
    return agent.departmentId === departmentId;
  });
}

export function filterGoalsForDepartmentContext<T extends Pick<Goal, "id" | "ownerAgentId">>(
  goals: T[],
  agents: Array<Pick<Agent, "id" | "departmentId">>,
  departmentId: string | null | undefined,
  options?: { preserveIds?: string[] },
) {
  const preserveIds = new Set(options?.preserveIds ?? []);
  const agentDepartmentById = new Map(agents.map((agent) => [agent.id, agent.departmentId ?? null]));

  return goals.filter((goal) => {
    if (preserveIds.has(goal.id)) return true;
    if (!goal.ownerAgentId) return true;
    const ownerDepartmentId = agentDepartmentById.get(goal.ownerAgentId);
    if (ownerDepartmentId === undefined) return false;
    if (!departmentId) return true;
    return ownerDepartmentId === departmentId;
  });
}
