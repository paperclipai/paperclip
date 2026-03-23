import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  agents,
  authUsers,
  companyMemberships,
  instanceUserRoles,
  principalPermissionGrants,
  projectMembers,
  projectPermissionGrants,
  projectAgents,
  projects,
} from "@paperclipai/db";
import type { PermissionKey, PrincipalType, ProjectPermissionKey } from "@paperclipai/shared";
import { PROJECT_ROLE_PRESETS } from "@paperclipai/shared";

type MembershipRow = typeof companyMemberships.$inferSelect;
type GrantInput = {
  permissionKey: PermissionKey;
  scope?: Record<string, unknown> | null;
};

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

  async function hasPermission(
    companyId: string,
    principalType: PrincipalType,
    principalId: string,
    permissionKey: PermissionKey,
  ): Promise<boolean> {
    const membership = await getMembership(companyId, principalType, principalId);
    if (!membership || membership.status !== "active") return false;
    const grant = await db
      .select({ id: principalPermissionGrants.id })
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
    return Boolean(grant);
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

  async function listMembers(companyId: string) {
    return db
      .select()
      .from(companyMemberships)
      .where(eq(companyMemberships.companyId, companyId))
      .orderBy(sql`${companyMemberships.createdAt} desc`);
  }

  async function listMembersWithGrants(companyId: string) {
    const members = await listMembers(companyId);
    const grants = await db
      .select()
      .from(principalPermissionGrants)
      .where(eq(principalPermissionGrants.companyId, companyId));

    // Resolve display names for users and agents
    const userIds = members.filter((m) => m.principalType === "user").map((m) => m.principalId);
    const agentIds = members.filter((m) => m.principalType === "agent").map((m) => m.principalId);

    const userMap = new Map<string, { name: string; email: string; image: string | null }>();
    const agentMap = new Map<string, { name: string }>();

    if (userIds.length > 0) {
      const users = await db
        .select({ id: authUsers.id, name: authUsers.name, email: authUsers.email, image: authUsers.image })
        .from(authUsers)
        .where(inArray(authUsers.id, userIds));
      for (const u of users) userMap.set(u.id, u);
    }
    if (agentIds.length > 0) {
      const agentRows = await db
        .select({ id: agents.id, name: agents.name })
        .from(agents)
        .where(inArray(agents.id, agentIds));
      for (const a of agentRows) agentMap.set(a.id, a);
    }

    return members.map((m) => {
      const user = m.principalType === "user" ? userMap.get(m.principalId) : null;
      const agent = m.principalType === "agent" ? agentMap.get(m.principalId) : null;
      return {
        ...m,
        displayName: user?.name ?? agent?.name ?? null,
        email: user?.email ?? null,
        image: user?.image ?? null,
        grants: grants
          .filter(
            (g) =>
              g.principalType === m.principalType &&
              g.principalId === m.principalId,
          )
          .map((g) => g.permissionKey),
      };
    });
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

  // ---------------------------------------------------------------------------
  // Project-level access control
  // ---------------------------------------------------------------------------

  async function isCompanyOwner(companyId: string, userId: string | null | undefined): Promise<boolean> {
    if (!userId) return false;
    if (await isInstanceAdmin(userId)) return true;
    const membership = await getMembership(companyId, "user", userId);
    if (membership && membership.membershipRole === "owner") return true;
    return hasPermission(companyId, "user", userId, "company:settings");
  }

  async function getProjectMembership(
    projectId: string,
    principalType: PrincipalType,
    principalId: string,
  ) {
    return db
      .select()
      .from(projectMembers)
      .where(
        and(
          eq(projectMembers.projectId, projectId),
          eq(projectMembers.principalType, principalType),
          eq(projectMembers.principalId, principalId),
        ),
      )
      .then((rows) => rows[0] ?? null);
  }

  async function hasProjectPermission(
    projectId: string,
    principalType: PrincipalType,
    principalId: string,
    permissionKey: ProjectPermissionKey,
  ): Promise<boolean> {
    const membership = await getProjectMembership(projectId, principalType, principalId);
    if (!membership) return false;
    if (permissionKey === "project:view") return true;
    const grant = await db
      .select({ id: projectPermissionGrants.id })
      .from(projectPermissionGrants)
      .where(
        and(
          eq(projectPermissionGrants.projectId, projectId),
          eq(projectPermissionGrants.principalType, principalType),
          eq(projectPermissionGrants.principalId, principalId),
          eq(projectPermissionGrants.permissionKey, permissionKey),
        ),
      )
      .then((rows) => rows[0] ?? null);
    return Boolean(grant);
  }

  async function canUserAccessProject(
    companyId: string,
    projectId: string,
    userId: string | null | undefined,
  ): Promise<boolean> {
    if (!userId) return false;
    if (await isCompanyOwner(companyId, userId)) return true;
    // Legacy mode: projects with zero members are accessible to everyone
    const memberCount = await db
      .select({ count: sql<number>`count(*)` })
      .from(projectMembers)
      .where(eq(projectMembers.projectId, projectId))
      .then((rows) => Number(rows[0]?.count ?? 0));
    if (memberCount === 0) return true;
    const membership = await getProjectMembership(projectId, "user", userId);
    return Boolean(membership);
  }

  async function listProjectMembers(projectId: string) {
    const members = await db
      .select()
      .from(projectMembers)
      .where(eq(projectMembers.projectId, projectId))
      .orderBy(sql`${projectMembers.createdAt} desc`);

    const grants = await db
      .select()
      .from(projectPermissionGrants)
      .where(eq(projectPermissionGrants.projectId, projectId));

    // Resolve display names for users and agents
    const userIds = members.filter((m) => m.principalType === "user").map((m) => m.principalId);
    const agentIds = members.filter((m) => m.principalType === "agent").map((m) => m.principalId);

    const userMap = new Map<string, { name: string; email: string; image: string | null }>();
    const agentMap = new Map<string, { name: string }>();

    if (userIds.length > 0) {
      const users = await db
        .select({ id: authUsers.id, name: authUsers.name, email: authUsers.email, image: authUsers.image })
        .from(authUsers)
        .where(inArray(authUsers.id, userIds));
      for (const u of users) userMap.set(u.id, u);
    }
    if (agentIds.length > 0) {
      const agentRows = await db
        .select({ id: agents.id, name: agents.name })
        .from(agents)
        .where(inArray(agents.id, agentIds));
      for (const a of agentRows) agentMap.set(a.id, a);
    }

    return members.map((m) => {
      const user = m.principalType === "user" ? userMap.get(m.principalId) : null;
      const agent = m.principalType === "agent" ? agentMap.get(m.principalId) : null;
      return {
        ...m,
        displayName: user?.name ?? agent?.name ?? null,
        email: user?.email ?? null,
        image: user?.image ?? null,
        grants: grants
          .filter(
            (g) =>
              g.principalType === m.principalType &&
              g.principalId === m.principalId,
          )
          .map((g) => g.permissionKey),
      };
    });
  }

  async function addProjectMember(
    projectId: string,
    companyId: string,
    principalType: PrincipalType,
    principalId: string,
    role: string,
    addedByUserId: string | null,
  ) {
    const preset = PROJECT_ROLE_PRESETS.find((p) => p.id === role);
    const presetGrants = preset?.permissions ?? [];

    const member = await db.transaction(async (tx) => {
      const [row] = await tx
        .insert(projectMembers)
        .values({
          projectId,
          companyId,
          principalType,
          principalId,
          role,
          addedByUserId,
        })
        .onConflictDoUpdate({
          target: [projectMembers.projectId, projectMembers.principalType, projectMembers.principalId],
          set: { role, updatedAt: new Date() },
        })
        .returning();

      // Delete existing grants for this principal in this project
      await tx
        .delete(projectPermissionGrants)
        .where(
          and(
            eq(projectPermissionGrants.projectId, projectId),
            eq(projectPermissionGrants.principalType, principalType),
            eq(projectPermissionGrants.principalId, principalId),
          ),
        );

      // Insert preset grants
      if (presetGrants.length > 0) {
        await tx.insert(projectPermissionGrants).values(
          presetGrants.map((permissionKey) => ({
            projectId,
            companyId,
            principalType,
            principalId,
            permissionKey,
            grantedByUserId: addedByUserId,
            createdAt: new Date(),
            updatedAt: new Date(),
          })),
        );
      }

      return row;
    });

    return member;
  }

  async function removeProjectMember(projectId: string, memberId: string) {
    const member = await db
      .select()
      .from(projectMembers)
      .where(and(eq(projectMembers.id, memberId), eq(projectMembers.projectId, projectId)))
      .then((rows) => rows[0] ?? null);
    if (!member) return null;

    await db.transaction(async (tx) => {
      await tx
        .delete(projectPermissionGrants)
        .where(
          and(
            eq(projectPermissionGrants.projectId, projectId),
            eq(projectPermissionGrants.principalType, member.principalType),
            eq(projectPermissionGrants.principalId, member.principalId),
          ),
        );
      await tx
        .delete(projectMembers)
        .where(eq(projectMembers.id, member.id));
    });

    return member;
  }

  async function setProjectMemberPermissions(
    projectId: string,
    memberId: string,
    grants: { permissionKey: ProjectPermissionKey }[],
    grantedByUserId: string | null,
  ) {
    const member = await db
      .select()
      .from(projectMembers)
      .where(and(eq(projectMembers.id, memberId), eq(projectMembers.projectId, projectId)))
      .then((rows) => rows[0] ?? null);
    if (!member) return null;

    await db.transaction(async (tx) => {
      await tx
        .delete(projectPermissionGrants)
        .where(
          and(
            eq(projectPermissionGrants.projectId, projectId),
            eq(projectPermissionGrants.principalType, member.principalType),
            eq(projectPermissionGrants.principalId, member.principalId),
          ),
        );
      if (grants.length > 0) {
        await tx.insert(projectPermissionGrants).values(
          grants.map((grant) => ({
            projectId,
            companyId: member.companyId,
            principalType: member.principalType,
            principalId: member.principalId,
            permissionKey: grant.permissionKey,
            grantedByUserId,
            createdAt: new Date(),
            updatedAt: new Date(),
          })),
        );
      }
    });

    return member;
  }

  async function listAccessibleProjects(companyId: string, userId: string): Promise<string[]> {
    if (await isCompanyOwner(companyId, userId)) return [];

    // Projects where user is an explicit member
    const memberProjectIds = await db
      .select({ projectId: projectMembers.projectId })
      .from(projectMembers)
      .where(
        and(
          eq(projectMembers.companyId, companyId),
          eq(projectMembers.principalType, "user"),
          eq(projectMembers.principalId, userId),
        ),
      )
      .then((rows) => rows.map((r) => r.projectId));

    // Legacy mode: projects with zero members
    const legacyProjectIds = await db
      .select({ id: projects.id })
      .from(projects)
      .leftJoin(projectMembers, eq(projects.id, projectMembers.projectId))
      .where(
        and(
          eq(projects.companyId, companyId),
          isNull(projectMembers.id),
        ),
      )
      .then((rows) => rows.map((r) => r.id));

    // Combine unique IDs
    const idSet = new Set([...memberProjectIds, ...legacyProjectIds]);
    return Array.from(idSet);
  }

  async function listProjectAgents(projectId: string) {
    return db
      .select({
        id: projectAgents.id,
        projectId: projectAgents.projectId,
        agentId: projectAgents.agentId,
        addedByUserId: projectAgents.addedByUserId,
        createdAt: projectAgents.createdAt,
        agentName: agents.name,
        agentRole: agents.role,
        agentIcon: agents.icon,
      })
      .from(projectAgents)
      .innerJoin(agents, eq(projectAgents.agentId, agents.id))
      .where(eq(projectAgents.projectId, projectId));
  }

  async function addProjectAgent(
    projectId: string,
    companyId: string,
    agentId: string,
    addedByUserId: string | null,
  ) {
    return db
      .insert(projectAgents)
      .values({
        projectId,
        companyId,
        agentId,
        addedByUserId,
      })
      .onConflictDoNothing()
      .returning()
      .then((rows) => rows[0] ?? null);
  }

  async function removeProjectAgent(projectId: string, agentId: string) {
    return db
      .delete(projectAgents)
      .where(
        and(
          eq(projectAgents.projectId, projectId),
          eq(projectAgents.agentId, agentId),
        ),
      )
      .returning()
      .then((rows) => rows[0] ?? null);
  }

  return {
    isInstanceAdmin,
    canUser,
    hasPermission,
    getMembership,
    ensureMembership,
    listMembers,
    listMembersWithGrants,
    setMemberPermissions,
    promoteInstanceAdmin,
    demoteInstanceAdmin,
    listUserCompanyAccess,
    setUserCompanyAccess,
    setPrincipalGrants,
    // Project-level access
    isCompanyOwner,
    getProjectMembership,
    hasProjectPermission,
    canUserAccessProject,
    listProjectMembers,
    addProjectMember,
    removeProjectMember,
    setProjectMemberPermissions,
    listAccessibleProjects,
    listProjectAgents,
    addProjectAgent,
    removeProjectAgent,
  };
}
