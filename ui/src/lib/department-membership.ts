export type DepartmentMembershipRow = { id: string; name: string; agentIds: readonly string[] };

export type DepartmentMembershipIndex = {
  namesByAgent: ReadonlyMap<string, readonly string[]>;
  departmentIdsByAgent: ReadonlyMap<string, readonly string[]>;
  membersByDepartment: ReadonlyMap<string, ReadonlySet<string>>;
  assigned: ReadonlySet<string>;
};

export function indexDepartmentMemberships(departments: readonly DepartmentMembershipRow[]): DepartmentMembershipIndex {
  const namesByAgent = new Map<string, string[]>();
  const departmentIdsByAgent = new Map<string, string[]>();
  const membersByDepartment = new Map<string, Set<string>>();
  const assigned = new Set<string>();
  for (const department of departments) {
    const members = new Set(department.agentIds);
    membersByDepartment.set(department.id, members);
    for (const agentId of members) {
      assigned.add(agentId);
      const names = namesByAgent.get(agentId);
      if (names) names.push(department.name);
      else namesByAgent.set(agentId, [department.name]);
      const departmentIds = departmentIdsByAgent.get(agentId);
      if (departmentIds) departmentIds.push(department.id);
      else departmentIdsByAgent.set(agentId, [department.id]);
    }
  }
  for (const names of namesByAgent.values()) names.sort((left, right) => left.localeCompare(right));
  return { namesByAgent, departmentIdsByAgent, membersByDepartment, assigned };
}
