import { and, eq, inArray, ne, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  agents,
  companyMemberships,
  instanceUserRoles,
  issues,
  principalPermissionGrants,
} from "@paperclipai/db";
import type { PermissionKey, PrincipalType } from "@paperclipai/shared";
import { conflict } from "../errors.js";

type MembershipRow = typeof companyMemberships.$inferSelect;
type GrantInput = {
  permissionKey: PermissionKey;
  scope?: Record<string, unknown> | null;
};

type MemberArchiveInput = {
  reassignment?: {
    assigneeAgentId?: string | null;
    assigneeUserId?: string | null;
  } | null;
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

  async function getMemberById(companyId: string, memberId: string) {
    return db
      .select()
      .from(companyMemberships)
      .where(and(eq(companyMemberships.companyId, companyId), eq(companyMemberships.id, memberId)))
      .then((rows) => rows[0] ?? null);
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
    const member = await getMemberById(companyId, memberId);
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

  async function updateMemberAndPermissions(
    companyId: string,
    memberId: string,
    data: {
      membershipRole?: string | null;
      status?: "pending" | "active" | "suspended";
      grants: GrantInput[];
    },
    grantedByUserId: string | null,
  ) {
    return db.transaction(async (tx) => {
      await tx.execute(sql`
        select ${companyMemberships.id}
        from ${companyMemberships}
        where ${companyMemberships.companyId} = ${companyId}
          and ${companyMemberships.principalType} = 'user'
          and ${companyMemberships.status} = 'active'
          and ${companyMemberships.membershipRole} = 'owner'
        for update
      `);

      const existing = await tx
        .select()
        .from(companyMemberships)
        .where(and(eq(companyMemberships.companyId, companyId), eq(companyMemberships.id, memberId)))
        .then((rows) => rows[0] ?? null);
      if (!existing) return null;

      const nextMembershipRole =
        data.membershipRole !== undefined ? data.membershipRole : existing.membershipRole;
      const nextStatus = data.status ?? existing.status;

      if (
        existing.principalType === "user" &&
        existing.status === "active" &&
        existing.membershipRole === "owner" &&
        (nextStatus !== "active" || nextMembershipRole !== "owner")
      ) {
        const activeOwnerCount = await tx
          .select({ id: companyMemberships.id })
          .from(companyMemberships)
          .where(
            and(
              eq(companyMemberships.companyId, companyId),
              eq(companyMemberships.principalType, "user"),
              eq(companyMemberships.status, "active"),
              eq(companyMemberships.membershipRole, "owner"),
            ),
          )
          .then((rows) => rows.length);
        if (activeOwnerCount <= 1) {
          throw conflict("Cannot remove the last active owner");
        }
      }

      const now = new Date();
      const updated = await tx
        .update(companyMemberships)
        .set({
          membershipRole: nextMembershipRole,
          status: nextStatus,
          updatedAt: now,
        })
        .where(eq(companyMemberships.id, existing.id))
        .returning()
        .then((rows) => rows[0] ?? existing);

      await tx
        .delete(principalPermissionGrants)
        .where(
          and(
            eq(principalPermissionGrants.companyId, companyId),
            eq(principalPermissionGrants.principalType, existing.principalType),
            eq(principalPermissionGrants.principalId, existing.principalId),
          ),
        );
      if (data.grants.length > 0) {
        await tx.insert(principalPermissionGrants).values(
          data.grants.map((grant) => ({
            companyId,
            principalType: existing.principalType,
            principalId: existing.principalId,
            permissionKey: grant.permissionKey,
            scope: grant.scope ?? null,
            grantedByUserId,
            createdAt: now,
            updatedAt: now,
          })),
        );
      }

      return updated;
    });
  }

  async function assertCanRemoveActiveOwner(
    companyId: string,
    principalType: PrincipalType,
    status: string,
    membershipRole: string | null,
    tx: Pick<Db, "select">,
  ) {
    if (
      principalType !== "user" ||
      status !== "active" ||
      membershipRole !== "owner"
    ) {
      return;
    }

    const activeOwnerCount = await tx
      .select({ id: companyMemberships.id })
      .from(companyMemberships)
      .where(
        and(
          eq(companyMemberships.companyId, companyId),
          eq(companyMemberships.principalType, "user"),
          eq(companyMemberships.status, "active"),
          eq(companyMemberships.membershipRole, "owner"),
        ),
      )
      .then((rows) => rows.length);
    if (activeOwnerCount <= 1) {
      throw conflict("Cannot remove the last active owner");
    }
  }

  async function assertAssignableArchiveTarget(
    companyId: string,
    input: MemberArchiveInput["reassignment"],
    tx: Pick<Db, "select">,
  ) {
    if (!input?.assigneeAgentId && !input?.assigneeUserId) return;
    if (input.assigneeAgentId && input.assigneeUserId) {
      throw conflict("Choose either an agent or user reassignment target");
    }
    if (input.assigneeUserId) {
      const membership = await tx
        .select({ id: companyMemberships.id })
        .from(companyMemberships)
        .where(
          and(
            eq(companyMemberships.companyId, companyId),
            eq(companyMemberships.principalType, "user"),
            eq(companyMemberships.principalId, input.assigneeUserId),
            eq(companyMemberships.status, "active"),
          ),
        )
        .then((rows) => rows[0] ?? null);
      if (!membership) {
        throw conflict("Replacement user must be an active company member");
      }
      return;
    }

    const agent = await tx
      .select({
        id: agents.id,
        companyId: agents.companyId,
        status: agents.status,
      })
      .from(agents)
      .where(eq(agents.id, input.assigneeAgentId!))
      .then((rows) => rows[0] ?? null);
    if (!agent || agent.companyId !== companyId) {
      throw conflict("Replacement agent must belong to the same company");
    }
    if (agent.status === "pending_approval" || agent.status === "terminated") {
      throw conflict("Replacement agent must be assignable");
    }
  }

  async function archiveMember(companyId: string, memberId: string, input: MemberArchiveInput = {}) {
    return db.transaction(async (tx) => {
      await tx.execute(sql`
        select ${companyMemberships.id}
        from ${companyMemberships}
        where ${companyMemberships.companyId} = ${companyId}
          and ${companyMemberships.principalType} = 'user'
          and ${companyMemberships.status} = 'active'
          and ${companyMemberships.membershipRole} = 'owner'
        for update
      `);

      const existing = await tx
        .select()
        .from(companyMemberships)
        .where(and(eq(companyMemberships.companyId, companyId), eq(companyMemberships.id, memberId)))
        .then((rows) => rows[0] ?? null);
      if (!existing) return null;
      if (existing.principalType !== "user") {
        throw conflict("Only human company members can be archived");
      }
      if (existing.status === "archived") {
        return { member: existing, reassignedIssueCount: 0 };
      }
      if (input.reassignment?.assigneeUserId === existing.principalId) {
        throw conflict("Replacement user cannot be the archived member");
      }

      await assertCanRemoveActiveOwner(
        companyId,
        existing.principalType,
        existing.status,
        existing.membershipRole,
        tx,
      );
      await assertAssignableArchiveTarget(companyId, input.reassignment, tx);

      const now = new Date();
      const assignmentPatch = {
        assigneeAgentId: input.reassignment?.assigneeAgentId ?? null,
        assigneeUserId: input.reassignment?.assigneeUserId ?? null,
        updatedAt: now,
      };
      const assignedOpenIssueWhere = and(
        eq(issues.companyId, companyId),
        eq(issues.assigneeUserId, existing.principalId),
        sql`${issues.status} not in ('done', 'cancelled')`,
      );
      const resetInProgress = await tx
        .update(issues)
        .set({
          ...assignmentPatch,
          status: "todo",
          startedAt: null,
          checkoutRunId: null,
          executionRunId: null,
          executionLockedAt: null,
        })
        .where(and(assignedOpenIssueWhere, eq(issues.status, "in_progress")))
        .returning({ id: issues.id });
      const reassigned = await tx
        .update(issues)
        .set(assignmentPatch)
        .where(and(assignedOpenIssueWhere, ne(issues.status, "in_progress")))
        .returning({ id: issues.id });

      await tx
        .delete(principalPermissionGrants)
        .where(
          and(
            eq(principalPermissionGrants.companyId, companyId),
            eq(principalPermissionGrants.principalType, existing.principalType),
            eq(principalPermissionGrants.principalId, existing.principalId),
          ),
        );

      const archived = await tx
        .update(companyMemberships)
        .set({
          status: "archived",
          updatedAt: now,
        })
        .where(eq(companyMemberships.id, existing.id))
        .returning()
        .then((rows) => rows[0] ?? existing);

      return {
        member: archived,
        reassignedIssueCount: resetInProgress.length + reassigned.length,
      };
    });
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

  async function setUserCompanyAccess(
    userId: string,
    companyIds: string[],
    options: { actorUserId?: string | null } = {},
  ) {
    const existing = await listUserCompanyAccess(userId);
    const existingByCompany = new Map(existing.map((row) => [row.companyId, row]));
    const target = new Set(companyIds);

    await db.transaction(async (tx) => {
      const toArchive = existing.filter((row) => !target.has(row.companyId) && row.status !== "archived");
      if (toArchive.length > 0 && options.actorUserId && options.actorUserId === userId) {
        throw conflict("You cannot remove yourself");
      }
      if (toArchive.length > 0 && (await isInstanceAdmin(userId))) {
        throw conflict("Instance admins cannot be removed from company access");
      }
      const protectedArchives = toArchive.filter((row) => row.membershipRole === "owner" || row.membershipRole === "admin");
      if (protectedArchives.length > 0) {
        throw conflict("Owners and admins cannot be removed from company access");
      }
      const activeOwnerArchives = toArchive.filter(
        (row) => row.status === "active" && row.membershipRole === "owner",
      );
      if (activeOwnerArchives.length > 0) {
        const activeOwnerRows = await tx
          .select({ companyId: companyMemberships.companyId, id: companyMemberships.id })
          .from(companyMemberships)
          .where(
            and(
              eq(companyMemberships.principalType, "user"),
              eq(companyMemberships.status, "active"),
              eq(companyMemberships.membershipRole, "owner"),
              inArray(companyMemberships.companyId, activeOwnerArchives.map((row) => row.companyId)),
            ),
          );
        for (const row of activeOwnerArchives) {
          const remainingOwners =
            activeOwnerRows.filter((owner) => owner.companyId === row.companyId).length - 1;
          if (remainingOwners <= 0) {
            throw conflict("Cannot remove the last active owner");
          }
        }
      }
      if (toArchive.length > 0) {
        await tx
          .update(companyMemberships)
          .set({ status: "archived", updatedAt: new Date() })
          .where(inArray(companyMemberships.id, toArchive.map((row) => row.id)));
        await tx
          .delete(principalPermissionGrants)
          .where(
            and(
              eq(principalPermissionGrants.principalType, "user"),
              eq(principalPermissionGrants.principalId, userId),
              inArray(principalPermissionGrants.companyId, toArchive.map((row) => row.companyId)),
            ),
          );
      }

      for (const companyId of target) {
        const existingMembership = existingByCompany.get(companyId);
        if (existingMembership) {
          if (existingMembership.status !== "active") {
            await tx
              .update(companyMemberships)
              .set({
                status: "active",
                membershipRole: existingMembership.membershipRole ?? "operator",
                updatedAt: new Date(),
              })
              .where(eq(companyMemberships.id, existingMembership.id));
          }
          continue;
        }
        await tx.insert(companyMemberships).values({
          companyId,
          principalType: "user",
          principalId: userId,
          status: "active",
          membershipRole: "operator",
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
    scope: Record<string, unknown> | null = null,
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

  async function updateMember(
    companyId: string,
    memberId: string,
    data: {
      membershipRole?: string | null;
      status?: "pending" | "active" | "suspended";
    },
  ) {
    return db.transaction(async (tx) => {
      await tx.execute(sql`
        select ${companyMemberships.id}
        from ${companyMemberships}
        where ${companyMemberships.companyId} = ${companyId}
          and ${companyMemberships.principalType} = 'user'
          and ${companyMemberships.status} = 'active'
          and ${companyMemberships.membershipRole} = 'owner'
        for update
      `);

      const existing = await tx
        .select()
        .from(companyMemberships)
        .where(and(eq(companyMemberships.companyId, companyId), eq(companyMemberships.id, memberId)))
        .then((rows) => rows[0] ?? null);
      if (!existing) return null;

      const nextMembershipRole =
        data.membershipRole !== undefined ? data.membershipRole : existing.membershipRole;
      const nextStatus = data.status ?? existing.status;

      if (
        existing.principalType === "user" &&
        existing.status === "active" &&
        existing.membershipRole === "owner" &&
        (nextStatus !== "active" || nextMembershipRole !== "owner")
      ) {
        const activeOwnerCount = await tx
          .select({ id: companyMemberships.id })
          .from(companyMemberships)
          .where(
            and(
              eq(companyMemberships.companyId, companyId),
              eq(companyMemberships.principalType, "user"),
              eq(companyMemberships.status, "active"),
              eq(companyMemberships.membershipRole, "owner"),
            ),
          )
          .then((rows) => rows.length);
        if (activeOwnerCount <= 1) {
          throw conflict("Cannot remove the last active owner");
        }
      }

      return tx
        .update(companyMemberships)
        .set({
          membershipRole: nextMembershipRole,
          status: nextStatus,
          updatedAt: new Date(),
        })
        .where(eq(companyMemberships.id, existing.id))
        .returning()
        .then((rows) => rows[0] ?? existing);
    });
  }

  return {
    isInstanceAdmin,
    canUser,
    hasPermission,
    getMembership,
    getMemberById,
    ensureMembership,
    listMembers,
    listActiveUserMemberships,
    copyActiveUserMemberships,
    archiveMember,
    setMemberPermissions,
    updateMemberAndPermissions,
    promoteInstanceAdmin,
    demoteInstanceAdmin,
    listUserCompanyAccess,
    setUserCompanyAccess,
    setPrincipalGrants,
    listPrincipalGrants,
    setPrincipalPermission,
    updateMember,
  };
}
