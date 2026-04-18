import { and, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  agents,
  authUsers,
  companyRolePermissions,
  companyRoles,
  companyMemberships,
  departments,
  instanceUserRoles,
  principalRoleAssignments,
  principalPermissionGrants,
} from "@paperclipai/db";
import {
  PERMISSION_KEYS,
  permissionScopeSchema,
  type PermissionKey,
  type PermissionScope,
  type PrincipalType,
} from "@paperclipai/shared";

type MembershipRow = typeof companyMemberships.$inferSelect;
type GrantInput = {
  permissionKey: PermissionKey;
  scope?: PermissionScope;
};
type PermissionAccess = {
  permissionKey: PermissionKey;
  allowed: boolean;
  companyWide: boolean;
  departmentIds: string[];
};
type EffectivePermissionSummary = {
  permissionKey: PermissionKey;
  companyWide: boolean;
  departmentIds: string[];
};

function parsePermissionScope(raw: unknown): PermissionScope {
  const parsed = permissionScopeSchema.safeParse(raw ?? null);
  return parsed.success ? parsed.data : null;
}

export function accessService(db: Db) {
  async function isInstanceAdmin(userId: string | null | undefined): Promise<boolean> {
    if (!userId) return false;
    const row = await db
      .select({ id: instanceUserRoles.id })
      .from(instanceUserRoles)
      .where(and(eq(instanceUserRoles.userId, userId), eq(instanceUserRoles.role, "instance_admin")))
      .then((rows) => rows[0] ?? null);
    return Boolean(row);
  }

  async function getMembership(
    companyId: string,
    principalType: PrincipalType,
    principalId: string,
  ): Promise<MembershipRow | null> {
    return db
      .select()
      .from(companyMemberships)
      .where(
        and(
          eq(companyMemberships.companyId, companyId),
          eq(companyMemberships.principalType, principalType),
          eq(companyMemberships.principalId, principalId),
        ),
      )
      .then((rows) => rows[0] ?? null);
  }

  async function listDirectGrants(
    companyId: string,
    principalType: PrincipalType,
    principalId: string,
    permissionKey?: PermissionKey,
  ) {
    return db
      .select({
        permissionKey: principalPermissionGrants.permissionKey,
        scope: principalPermissionGrants.scope,
      })
      .from(principalPermissionGrants)
      .where(
        and(
          eq(principalPermissionGrants.companyId, companyId),
          eq(principalPermissionGrants.principalType, principalType),
          eq(principalPermissionGrants.principalId, principalId),
          ...(permissionKey ? [eq(principalPermissionGrants.permissionKey, permissionKey)] : []),
        ),
      );
  }

  async function listRolePermissionEntries(
    companyId: string,
    principalType: PrincipalType,
    principalId: string,
    permissionKey?: PermissionKey,
  ) {
    return db
      .select({
        permissionKey: companyRolePermissions.permissionKey,
        scope: principalRoleAssignments.scope,
      })
      .from(principalRoleAssignments)
      .innerJoin(companyRoles, eq(principalRoleAssignments.roleId, companyRoles.id))
      .innerJoin(companyRolePermissions, eq(companyRolePermissions.roleId, companyRoles.id))
      .where(
        and(
          eq(principalRoleAssignments.companyId, companyId),
          eq(principalRoleAssignments.principalType, principalType),
          eq(principalRoleAssignments.principalId, principalId),
          eq(companyRoles.companyId, companyId),
          eq(companyRoles.status, "active"),
          ...(permissionKey ? [eq(companyRolePermissions.permissionKey, permissionKey)] : []),
        ),
      );
  }

  async function expandDepartmentScopeIds(
    companyId: string,
    scope: Exclude<PermissionScope, null>,
  ) {
    if (scope.kind !== "departments") return [];

    const scopedIds = new Set(scope.departmentIds);
    if (scopedIds.size === 0) return [];
    if (!scope.includeDescendants) return [...scopedIds];

    const rows = await db
      .select({
        id: departments.id,
        parentId: departments.parentId,
      })
      .from(departments)
      .where(and(eq(departments.companyId, companyId), eq(departments.status, "active")));

    const childrenByParent = new Map<string, string[]>();
    for (const row of rows) {
      if (!row.parentId) continue;
      const siblings = childrenByParent.get(row.parentId) ?? [];
      siblings.push(row.id);
      childrenByParent.set(row.parentId, siblings);
    }

    const queue = [...scopedIds];
    while (queue.length > 0) {
      const current = queue.shift();
      if (!current) continue;
      for (const childId of childrenByParent.get(current) ?? []) {
        if (scopedIds.has(childId)) continue;
        scopedIds.add(childId);
        queue.push(childId);
      }
    }

    return [...scopedIds].sort((left, right) => left.localeCompare(right));
  }

  async function resolvePermissionAccess(
    companyId: string,
    principalType: PrincipalType,
    principalId: string,
    permissionKey: PermissionKey,
  ): Promise<PermissionAccess> {
    if (principalType === "user" && await isInstanceAdmin(principalId)) {
      return {
        permissionKey,
        allowed: true,
        companyWide: true,
        departmentIds: [],
      };
    }

    const membership = await getMembership(companyId, principalType, principalId);
    if (!membership || membership.status !== "active") {
      return {
        permissionKey,
        allowed: false,
        companyWide: false,
        departmentIds: [],
      };
    }

    const [directEntries, roleEntries] = await Promise.all([
      listDirectGrants(companyId, principalType, principalId, permissionKey),
      listRolePermissionEntries(companyId, principalType, principalId, permissionKey),
    ]);

    let companyWide = false;
    const departmentIds = new Set<string>();
    for (const entry of [...directEntries, ...roleEntries]) {
      const scope = parsePermissionScope(entry.scope);
      if (scope === null) {
        companyWide = true;
        continue;
      }
      for (const departmentId of await expandDepartmentScopeIds(companyId, scope)) {
        departmentIds.add(departmentId);
      }
    }

    return {
      permissionKey,
      allowed: companyWide || departmentIds.size > 0,
      companyWide,
      departmentIds: [...departmentIds].sort((left, right) => left.localeCompare(right)),
    };
  }

  async function hasPermission(
    companyId: string,
    principalType: PrincipalType,
    principalId: string,
    permissionKey: PermissionKey,
  ): Promise<boolean> {
    const access = await resolvePermissionAccess(
      companyId,
      principalType,
      principalId,
      permissionKey,
    );
    return access.companyWide;
  }

  async function canUser(
    companyId: string,
    userId: string | null | undefined,
    permissionKey: PermissionKey,
  ): Promise<boolean> {
    if (!userId) return false;
    if (await isInstanceAdmin(userId)) return true;
    return hasPermission(companyId, "user", userId, permissionKey);
  }

  async function evaluatePermission(
    companyId: string,
    principalType: PrincipalType,
    principalId: string,
    permissionKey: PermissionKey,
    context?: {
      departmentId?: string | null;
    },
  ) {
    const access = await resolvePermissionAccess(companyId, principalType, principalId, permissionKey);
    if (!access.allowed) {
      return {
        ...access,
        allowed: false,
      };
    }

    if (access.companyWide) {
      return access;
    }

    if (context?.departmentId) {
      return {
        ...access,
        allowed: access.departmentIds.includes(context.departmentId),
      };
    }

    return access;
  }

  async function resolveAccessibleDepartmentIds(
    companyId: string,
    principalType: PrincipalType,
    principalId: string,
    permissionKey: PermissionKey,
  ) {
    const access = await resolvePermissionAccess(companyId, principalType, principalId, permissionKey);
    return {
      companyWide: access.companyWide,
      departmentIds: access.departmentIds,
    };
  }

  async function resolveEffectivePermissions(
    companyId: string,
    principalType: PrincipalType,
    principalId: string,
  ) {
    if (principalType === "user" && await isInstanceAdmin(principalId)) {
      return PERMISSION_KEYS.map((permissionKey) => ({
        permissionKey,
        companyWide: true,
        departmentIds: [] as string[],
      }));
    }

    const membership = await getMembership(companyId, principalType, principalId);
    if (!membership || membership.status !== "active") return [];

    const [directEntries, roleEntries] = await Promise.all([
      listDirectGrants(companyId, principalType, principalId),
      listRolePermissionEntries(companyId, principalType, principalId),
    ]);

    const permissionKeys = new Set<PermissionKey>(
      [...directEntries, ...roleEntries].map((entry) => entry.permissionKey as PermissionKey),
    );
    const resolved: Array<{
      permissionKey: PermissionKey;
      companyWide: boolean;
      departmentIds: string[];
    }> = [];

    for (const permissionKey of permissionKeys) {
      const access = await resolvePermissionAccess(companyId, principalType, principalId, permissionKey);
      if (!access.allowed) continue;
      resolved.push({
        permissionKey,
        companyWide: access.companyWide,
        departmentIds: access.departmentIds,
      });
    }

    return resolved.sort((left, right) => left.permissionKey.localeCompare(right.permissionKey));
  }

  async function listMemberAccessSummaries(companyId: string) {
    const members = await listMembers(companyId);
    if (members.length === 0) return [];

    const userIds = [...new Set(
      members
        .filter((member) => member.principalType === "user")
        .map((member) => member.principalId),
    )];
    const agentIds = [...new Set(
      members
        .filter((member) => member.principalType === "agent")
        .map((member) => member.principalId),
    )];

    const [userRows, agentRows, grantRows, assignmentRows, roles, activeDepartments] = await Promise.all([
      userIds.length === 0
        ? Promise.resolve([])
        : db
          .select({
            id: authUsers.id,
            name: authUsers.name,
            email: authUsers.email,
          })
          .from(authUsers)
          .where(inArray(authUsers.id, userIds)),
      agentIds.length === 0
        ? Promise.resolve([])
        : db
          .select({
            id: agents.id,
            name: agents.name,
            title: agents.title,
            status: agents.status,
          })
          .from(agents)
          .where(and(eq(agents.companyId, companyId), inArray(agents.id, agentIds))),
      db
        .select()
        .from(principalPermissionGrants)
        .where(eq(principalPermissionGrants.companyId, companyId)),
      db
        .select()
        .from(principalRoleAssignments)
        .where(eq(principalRoleAssignments.companyId, companyId)),
      db
        .select()
        .from(companyRoles)
        .where(eq(companyRoles.companyId, companyId)),
      db
        .select({
          id: departments.id,
          parentId: departments.parentId,
        })
        .from(departments)
        .where(and(eq(departments.companyId, companyId), eq(departments.status, "active"))),
    ]);

    const roleIds = [...new Set(assignmentRows.map((assignment) => assignment.roleId))];
    const rolePermissionRows = roleIds.length === 0
      ? []
      : await db
        .select()
        .from(companyRolePermissions)
        .where(inArray(companyRolePermissions.roleId, roleIds));

    const userById = new Map(userRows.map((row) => [row.id, row]));
    const agentById = new Map(agentRows.map((row) => [row.id, row]));

    const rolesById = new Map(
      roles.map((role) => [
        role.id,
        {
          ...role,
          permissionKeys: rolePermissionRows
            .filter((permission) => permission.roleId === role.id)
            .map((permission) => permission.permissionKey as PermissionKey)
            .sort(),
        },
      ]),
    );

    const grantsByPrincipal = new Map<string, typeof grantRows>();
    for (const grant of grantRows) {
      const key = `${grant.principalType}:${grant.principalId}`;
      const entries = grantsByPrincipal.get(key) ?? [];
      entries.push(grant);
      grantsByPrincipal.set(key, entries);
    }

    const assignmentsByPrincipal = new Map<string, typeof assignmentRows>();
    for (const assignment of assignmentRows) {
      const key = `${assignment.principalType}:${assignment.principalId}`;
      const entries = assignmentsByPrincipal.get(key) ?? [];
      entries.push(assignment);
      assignmentsByPrincipal.set(key, entries);
    }

    const childrenByParent = new Map<string, string[]>();
    for (const department of activeDepartments) {
      if (!department.parentId) continue;
      const children = childrenByParent.get(department.parentId) ?? [];
      children.push(department.id);
      childrenByParent.set(department.parentId, children);
    }

    const scopeExpansionCache = new Map<string, string[]>();
    async function expandScope(scope: PermissionScope): Promise<string[]> {
      if (scope === null) return [];
      const cacheKey = JSON.stringify(scope);
      const cached = scopeExpansionCache.get(cacheKey);
      if (cached) return cached;
      if (scope.kind !== "departments") return [];

      const scopedIds = new Set(scope.departmentIds);
      if (scope.includeDescendants) {
        const queue = [...scopedIds];
        while (queue.length > 0) {
          const current = queue.shift();
          if (!current) continue;
          for (const childId of childrenByParent.get(current) ?? []) {
            if (scopedIds.has(childId)) continue;
            scopedIds.add(childId);
            queue.push(childId);
          }
        }
      }

      const expanded = [...scopedIds].sort((left, right) => left.localeCompare(right));
      scopeExpansionCache.set(cacheKey, expanded);
      return expanded;
    }

    async function resolveEffectivePermissionSummary(
      directEntries: typeof grantRows,
      roleAssignments: typeof assignmentRows,
    ): Promise<EffectivePermissionSummary[]> {
      const effective = new Map<PermissionKey, { companyWide: boolean; departmentIds: Set<string> }>();

      const applyScope = async (permissionKey: PermissionKey, scope: PermissionScope) => {
        const existing = effective.get(permissionKey) ?? { companyWide: false, departmentIds: new Set<string>() };
        if (scope === null) {
          existing.companyWide = true;
          existing.departmentIds.clear();
          effective.set(permissionKey, existing);
          return;
        }
        for (const departmentId of await expandScope(scope)) {
          existing.departmentIds.add(departmentId);
        }
        effective.set(permissionKey, existing);
      };

      for (const grant of directEntries) {
        await applyScope(grant.permissionKey as PermissionKey, parsePermissionScope(grant.scope));
      }

      for (const assignment of roleAssignments) {
        const role = rolesById.get(assignment.roleId);
        if (!role || role.status !== "active") continue;
        const scope = parsePermissionScope(assignment.scope);
        for (const permissionKey of role.permissionKeys) {
          await applyScope(permissionKey, scope);
        }
      }

      return [...effective.entries()]
        .map(([permissionKey, summary]) => ({
          permissionKey,
          companyWide: summary.companyWide,
          departmentIds: summary.companyWide
            ? []
            : [...summary.departmentIds].sort((left, right) => left.localeCompare(right)),
        }))
        .sort((left, right) => left.permissionKey.localeCompare(right.permissionKey));
    }

    return Promise.all(
      members.map(async (member) => {
        const key = `${member.principalType}:${member.principalId}`;
        const directEntries = (grantsByPrincipal.get(key) ?? []).map((grant) => ({
          ...grant,
          scope: parsePermissionScope(grant.scope),
        }));
        const roleAssignments = (assignmentsByPrincipal.get(key) ?? []).map((assignment) => ({
          ...assignment,
          scope: parsePermissionScope(assignment.scope),
          role: rolesById.get(assignment.roleId) ?? null,
        }));
        const resolvedRoleAssignments = roleAssignments.filter((assignment): assignment is typeof roleAssignments[number] & {
          role: NonNullable<typeof assignment.role>;
        } => assignment.role !== null);
        const effectivePermissions = await resolveEffectivePermissionSummary(
          grantsByPrincipal.get(key) ?? [],
          assignmentsByPrincipal.get(key) ?? [],
        );

        const principal = member.principalType === "user"
          ? {
              id: member.principalId,
              type: member.principalType,
              name: userById.get(member.principalId)?.name ?? member.principalId,
              email: userById.get(member.principalId)?.email ?? null,
              title: null,
              status: member.status,
              urlKey: null,
            }
          : {
              id: member.principalId,
              type: member.principalType,
              name: agentById.get(member.principalId)?.name ?? member.principalId,
              email: null,
              title: agentById.get(member.principalId)?.title ?? null,
              status: agentById.get(member.principalId)?.status ?? member.status,
              urlKey: null,
            };

        return {
          ...member,
          principal,
          directGrants: directEntries,
          roleAssignments: resolvedRoleAssignments,
          effectivePermissions,
        };
      }),
    );
  }

  async function listMembers(companyId: string) {
    return db
      .select()
      .from(companyMemberships)
      .where(eq(companyMemberships.companyId, companyId))
      .orderBy(sql`${companyMemberships.createdAt} desc`);
  }

  async function listActiveUserMemberships(companyId: string) {
    return db
      .select()
      .from(companyMemberships)
      .where(
        and(
          eq(companyMemberships.companyId, companyId),
          eq(companyMemberships.principalType, "user"),
          eq(companyMemberships.status, "active"),
        ),
      )
      .orderBy(sql`${companyMemberships.createdAt} asc`);
  }

  async function setMemberPermissions(
    companyId: string,
    memberId: string,
    grants: GrantInput[],
    grantedByUserId: string | null,
  ) {
    const member = await db
      .select()
      .from(companyMemberships)
      .where(and(eq(companyMemberships.companyId, companyId), eq(companyMemberships.id, memberId)))
      .then((rows) => rows[0] ?? null);
    if (!member) return null;

    await db.transaction(async (tx) => {
      await tx
        .delete(principalPermissionGrants)
        .where(
          and(
            eq(principalPermissionGrants.companyId, companyId),
            eq(principalPermissionGrants.principalType, member.principalType),
            eq(principalPermissionGrants.principalId, member.principalId),
          ),
        );
      if (grants.length > 0) {
        await tx.insert(principalPermissionGrants).values(
          grants.map((grant) => ({
            companyId,
            principalType: member.principalType,
            principalId: member.principalId,
            permissionKey: grant.permissionKey,
            scope: grant.scope ?? null,
            grantedByUserId,
            createdAt: new Date(),
            updatedAt: new Date(),
          })),
        );
      }
    });

    return member;
  }

  async function promoteInstanceAdmin(userId: string) {
    const existing = await db
      .select()
      .from(instanceUserRoles)
      .where(and(eq(instanceUserRoles.userId, userId), eq(instanceUserRoles.role, "instance_admin")))
      .then((rows) => rows[0] ?? null);
    if (existing) return existing;
    return db
      .insert(instanceUserRoles)
      .values({
        userId,
        role: "instance_admin",
      })
      .returning()
      .then((rows) => rows[0]);
  }

  async function demoteInstanceAdmin(userId: string) {
    return db
      .delete(instanceUserRoles)
      .where(and(eq(instanceUserRoles.userId, userId), eq(instanceUserRoles.role, "instance_admin")))
      .returning()
      .then((rows) => rows[0] ?? null);
  }

  async function listUserCompanyAccess(userId: string) {
    return db
      .select()
      .from(companyMemberships)
      .where(and(eq(companyMemberships.principalType, "user"), eq(companyMemberships.principalId, userId)))
      .orderBy(sql`${companyMemberships.createdAt} desc`);
  }

  async function setUserCompanyAccess(userId: string, companyIds: string[]) {
    const existing = await listUserCompanyAccess(userId);
    const existingByCompany = new Map(existing.map((row) => [row.companyId, row]));
    const target = new Set(companyIds);

    await db.transaction(async (tx) => {
      const toDelete = existing.filter((row) => !target.has(row.companyId)).map((row) => row.id);
      if (toDelete.length > 0) {
        await tx.delete(companyMemberships).where(inArray(companyMemberships.id, toDelete));
      }

      for (const companyId of target) {
        if (existingByCompany.has(companyId)) continue;
        await tx.insert(companyMemberships).values({
          companyId,
          principalType: "user",
          principalId: userId,
          status: "active",
          membershipRole: "member",
        });
      }
    });

    return listUserCompanyAccess(userId);
  }

  async function ensureMembership(
    companyId: string,
    principalType: PrincipalType,
    principalId: string,
    membershipRole: string | null = "member",
    status: "pending" | "active" | "suspended" = "active",
  ) {
    const existing = await getMembership(companyId, principalType, principalId);
    if (existing) {
      if (existing.status !== status || existing.membershipRole !== membershipRole) {
        const updated = await db
          .update(companyMemberships)
          .set({ status, membershipRole, updatedAt: new Date() })
          .where(eq(companyMemberships.id, existing.id))
          .returning()
          .then((rows) => rows[0] ?? null);
        return updated ?? existing;
      }
      return existing;
    }

    return db
      .insert(companyMemberships)
      .values({
        companyId,
        principalType,
        principalId,
        status,
        membershipRole,
      })
      .returning()
      .then((rows) => rows[0]);
  }

  async function setPrincipalGrants(
    companyId: string,
    principalType: PrincipalType,
    principalId: string,
    grants: GrantInput[],
    grantedByUserId: string | null,
  ) {
    await db.transaction(async (tx) => {
      await tx
        .delete(principalPermissionGrants)
        .where(
          and(
            eq(principalPermissionGrants.companyId, companyId),
            eq(principalPermissionGrants.principalType, principalType),
            eq(principalPermissionGrants.principalId, principalId),
          ),
        );
      if (grants.length === 0) return;
      await tx.insert(principalPermissionGrants).values(
        grants.map((grant) => ({
          companyId,
          principalType,
          principalId,
          permissionKey: grant.permissionKey,
          scope: grant.scope ?? null,
          grantedByUserId,
          createdAt: new Date(),
          updatedAt: new Date(),
        })),
      );
    });
  }

  async function copyActiveUserMemberships(sourceCompanyId: string, targetCompanyId: string) {
    const sourceMemberships = await listActiveUserMemberships(sourceCompanyId);
    for (const membership of sourceMemberships) {
      await ensureMembership(
        targetCompanyId,
        "user",
        membership.principalId,
        membership.membershipRole,
        "active",
      );
    }
    return sourceMemberships;
  }

  async function listPrincipalGrants(
    companyId: string,
    principalType: PrincipalType,
    principalId: string,
  ) {
    return db
      .select()
      .from(principalPermissionGrants)
      .where(
        and(
          eq(principalPermissionGrants.companyId, companyId),
          eq(principalPermissionGrants.principalType, principalType),
          eq(principalPermissionGrants.principalId, principalId),
        ),
      )
      .orderBy(principalPermissionGrants.permissionKey);
  }

  async function setPrincipalPermission(
    companyId: string,
    principalType: PrincipalType,
    principalId: string,
    permissionKey: PermissionKey,
    enabled: boolean,
    grantedByUserId: string | null,
    scope: PermissionScope = null,
  ) {
    if (!enabled) {
      await db
        .delete(principalPermissionGrants)
        .where(
          and(
            eq(principalPermissionGrants.companyId, companyId),
            eq(principalPermissionGrants.principalType, principalType),
            eq(principalPermissionGrants.principalId, principalId),
            eq(principalPermissionGrants.permissionKey, permissionKey),
          ),
        );
      return;
    }

    await ensureMembership(companyId, principalType, principalId, "member", "active");

    const existing = await db
      .select()
      .from(principalPermissionGrants)
      .where(
        and(
          eq(principalPermissionGrants.companyId, companyId),
          eq(principalPermissionGrants.principalType, principalType),
          eq(principalPermissionGrants.principalId, principalId),
          eq(principalPermissionGrants.permissionKey, permissionKey),
        ),
      )
      .then((rows) => rows[0] ?? null);

    if (existing) {
      await db
        .update(principalPermissionGrants)
        .set({
          scope,
          grantedByUserId,
          updatedAt: new Date(),
        })
        .where(eq(principalPermissionGrants.id, existing.id));
      return;
    }

    await db.insert(principalPermissionGrants).values({
      companyId,
      principalType,
      principalId,
      permissionKey,
      scope,
      grantedByUserId,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  }

  return {
    isInstanceAdmin,
    canUser,
    hasPermission,
    evaluatePermission,
    resolveAccessibleDepartmentIds,
    resolveEffectivePermissions,
    listMemberAccessSummaries,
    getMembership,
    ensureMembership,
    listMembers,
    listActiveUserMemberships,
    copyActiveUserMemberships,
    setMemberPermissions,
    promoteInstanceAdmin,
    demoteInstanceAdmin,
    listUserCompanyAccess,
    setUserCompanyAccess,
    setPrincipalGrants,
    listPrincipalGrants,
    setPrincipalPermission,
  };
}
