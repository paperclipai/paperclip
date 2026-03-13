import { and, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  authUsers,
  companyMemberships,
  instanceUserRoles,
  principalPermissionGrants,
} from "@paperclipai/db";
import type { MembershipRole, PermissionKey, PrincipalType } from "@paperclipai/shared";
import { ROLE_HIERARCHY, PERMISSION_KEYS } from "@paperclipai/shared";
import { logActivity } from "./activity-log.js";

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
  ): Promise<{ granted: boolean; scope: Record<string, unknown> | null }> {
    const membership = await getMembership(companyId, principalType, principalId);
    if (!membership || membership.status !== "active") return { granted: false, scope: null };
    const grant = await db
      .select({ id: principalPermissionGrants.id, scope: principalPermissionGrants.scope })
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
    if (!grant) return { granted: false, scope: null };
    return { granted: true, scope: grant.scope as Record<string, unknown> | null };
  }

  async function canUser(
    companyId: string,
    userId: string | null | undefined,
    permissionKey: PermissionKey,
  ): Promise<boolean> {
    if (!userId) return false;
    if (await isInstanceAdmin(userId)) return true;
    return hasPermission(companyId, "user", userId, permissionKey).then((r) => r.granted);
  }

  async function listMembers(companyId: string) {
    return db
      .select()
      .from(companyMemberships)
      .where(eq(companyMemberships.companyId, companyId))
      .orderBy(sql`${companyMemberships.createdAt} desc`);
  }

  function canModifyMember(actorRole: string | null, targetRole: string | null): boolean {
    if (!actorRole || !targetRole) return false;
    const actorOrdinal = ROLE_HIERARCHY[actorRole as MembershipRole];
    const targetOrdinal = ROLE_HIERARCHY[targetRole as MembershipRole];
    if (actorOrdinal === undefined || targetOrdinal === undefined) return false;
    return actorOrdinal < targetOrdinal;
  }

  async function setMemberPermissions(
    companyId: string,
    memberId: string,
    grants: GrantInput[],
    grantedByUserId: string | null,
    membershipRole?: MembershipRole,
  ) {
    const member = await db
      .select()
      .from(companyMemberships)
      .where(and(eq(companyMemberships.companyId, companyId), eq(companyMemberships.id, memberId)))
      .then((rows) => rows[0] ?? null);
    if (!member) return null;

    let updatedMember = member;
    await db.transaction(async (tx) => {
      if (membershipRole !== undefined) {
        const [row] = await tx
          .update(companyMemberships)
          .set({ membershipRole, updatedAt: new Date() })
          .where(eq(companyMemberships.id, memberId))
          .returning();
        if (row) updatedMember = row;
      }
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

    await logActivity(db, {
      companyId,
      actorType: "user",
      actorId: grantedByUserId ?? "system",
      action: "permissions.updated",
      entityType: "membership",
      entityId: memberId,
      details: { grants: grants.map((g) => g.permissionKey), ...(membershipRole !== undefined ? { membershipRole } : {}) },
    });

    return updatedMember;
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
          membershipRole: "contributor",
        });
      }
    });

    return listUserCompanyAccess(userId);
  }

  async function ensureMembership(
    companyId: string,
    principalType: PrincipalType,
    principalId: string,
    membershipRole: string | null = "contributor",
    status: "active" | "suspended" = "active",
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
    await logActivity(db, {
      companyId,
      actorType: "system",
      actorId: grantedByUserId ?? "system",
      action: "permissions.updated",
      entityType: "principal",
      entityId: principalId,
      details: { principalType, grants: grants.map((g) => g.permissionKey) },
    });
  }

  async function removeMember(companyId: string, memberId: string, actorUserId: string) {
    const member = await db
      .select()
      .from(companyMemberships)
      .where(and(eq(companyMemberships.companyId, companyId), eq(companyMemberships.id, memberId)))
      .then((rows) => rows[0] ?? null);
    if (!member) return null;
    await db.transaction(async (tx) => {
      await tx.delete(principalPermissionGrants).where(
        and(
          eq(principalPermissionGrants.companyId, companyId),
          eq(principalPermissionGrants.principalType, member.principalType),
          eq(principalPermissionGrants.principalId, member.principalId),
        ),
      );
      await tx.delete(companyMemberships).where(eq(companyMemberships.id, memberId));
    });
    await logActivity(db, {
      companyId,
      actorType: "user",
      actorId: actorUserId,
      action: "member.removed",
      entityType: "membership",
      entityId: memberId,
      details: { principalType: member.principalType, principalId: member.principalId },
    });
    return member;
  }

  async function suspendMember(companyId: string, memberId: string, actorUserId: string) {
    const updated = await db
      .update(companyMemberships)
      .set({ status: "suspended", updatedAt: new Date() })
      .where(and(eq(companyMemberships.companyId, companyId), eq(companyMemberships.id, memberId)))
      .returning()
      .then((rows) => rows[0] ?? null);
    if (!updated) return null;
    await logActivity(db, {
      companyId,
      actorType: "user",
      actorId: actorUserId,
      action: "member.suspended",
      entityType: "membership",
      entityId: memberId,
    });
    return updated;
  }

  async function unsuspendMember(companyId: string, memberId: string, actorUserId: string) {
    const updated = await db
      .update(companyMemberships)
      .set({ status: "active", updatedAt: new Date() })
      .where(and(eq(companyMemberships.companyId, companyId), eq(companyMemberships.id, memberId)))
      .returning()
      .then((rows) => rows[0] ?? null);
    if (!updated) return null;
    await logActivity(db, {
      companyId,
      actorType: "user",
      actorId: actorUserId,
      action: "member.unsuspended",
      entityType: "membership",
      entityId: memberId,
    });
    return updated;
  }

  async function listPeople(companyId: string) {
    const rows = await db
      .select({
        id: authUsers.id,
        name: authUsers.name,
        email: authUsers.email,
        avatar: authUsers.image,
        membershipRole: companyMemberships.membershipRole,
        status: companyMemberships.status,
      })
      .from(companyMemberships)
      .leftJoin(authUsers, eq(companyMemberships.principalId, authUsers.id))
      .where(
        and(
          eq(companyMemberships.companyId, companyId),
          eq(companyMemberships.principalType, "user"),
        ),
      )
      .orderBy(sql`${authUsers.name} asc nulls last`);
    return rows.filter((r) => r.id !== null);
  }

  async function getMyPermissions(
    companyId: string,
    principalType: PrincipalType,
    principalId: string,
  ): Promise<{ membershipRole: MembershipRole | null; permissions: PermissionKey[] }> {
    const membership = await getMembership(companyId, principalType, principalId);
    if (!membership || membership.status !== "active") {
      return { membershipRole: null, permissions: [] };
    }

    const grants = await db
      .select({ permissionKey: principalPermissionGrants.permissionKey })
      .from(principalPermissionGrants)
      .where(
        and(
          eq(principalPermissionGrants.companyId, companyId),
          eq(principalPermissionGrants.principalType, principalType),
          eq(principalPermissionGrants.principalId, principalId),
        ),
      );

    const permissions = grants
      .map((g) => g.permissionKey)
      .filter((k): k is PermissionKey => PERMISSION_KEYS.includes(k as PermissionKey));

    return {
      membershipRole: (membership.membershipRole as MembershipRole) ?? null,
      permissions,
    };
  }

  return {
    isInstanceAdmin,
    canUser,
    hasPermission,
    getMembership,
    ensureMembership,
    listMembers,
    listPeople,
    canModifyMember,
    setMemberPermissions,
    promoteInstanceAdmin,
    demoteInstanceAdmin,
    listUserCompanyAccess,
    setUserCompanyAccess,
    setPrincipalGrants,
    removeMember,
    suspendMember,
    unsuspendMember,
    getMyPermissions,
  };
}
