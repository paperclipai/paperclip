import { and, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  agents,
  companyMemberships,
  instanceUserRoles,
  principalPermissionGrants,
} from "@paperclipai/db";
import type { PermissionKey, PrincipalType } from "@paperclipai/shared";

type MembershipRow = typeof companyMemberships.$inferSelect;
type GrantInput = {
  permissionKey: PermissionKey;
  scope?: Record<string, unknown> | null;
};

export type AssignmentScopeRule =
  | { type: "subtree"; anchorId: string }
  | { type: "exclude"; targetId: string };

export function parseAssignmentScope(
  raw: Record<string, unknown> | null | undefined,
): AssignmentScopeRule[] {
  try {
    if (raw == null) return [];
    const rules = raw["rules"];
    if (!Array.isArray(rules)) return [];
    const parsed: AssignmentScopeRule[] = [];
    for (const item of rules) {
      if (item == null || typeof item !== "object") continue;
      const r = item as Record<string, unknown>;
      if (r["type"] === "subtree" && typeof r["anchorId"] === "string") {
        parsed.push({ type: "subtree", anchorId: r["anchorId"] });
      } else if (r["type"] === "exclude" && typeof r["targetId"] === "string") {
        parsed.push({ type: "exclude", targetId: r["targetId"] });
      }
    }
    return parsed;
  } catch {
    return [];
  }
}

export function evaluateAssignmentScope(
  rules: AssignmentScopeRule[],
  assigneeId: string,
  ancestors: string[],
): { allowed: boolean; reason?: string } {
  if (rules.length === 0) return { allowed: true };
  for (const rule of rules) {
    if (rule.type === "subtree") {
      if (rule.anchorId !== assigneeId && !ancestors.includes(rule.anchorId)) {
        return { allowed: false, reason: `assignee is outside permitted subtree (anchor: ${rule.anchorId})` };
      }
    } else if (rule.type === "exclude") {
      if (rule.targetId === assigneeId) {
        return { allowed: false, reason: `assignee is explicitly excluded (target: ${rule.targetId})` };
      }
    } else {
      const _exhaustive: never = rule;
      void _exhaustive;
    }
  }
  return { allowed: true };
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

  async function resolveAssigneeAncestors(
    companyId: string,
    assigneeType: "agent" | "user",
    assigneeId: string,
  ): Promise<string[]> {
    const MAX_HOPS = 20;
    const ancestors: string[] = [];
    const visited = new Set<string>();
    let currentId = assigneeId;

    for (let hop = 0; hop < MAX_HOPS; hop++) {
      const visitedKey = `${assigneeType}:${currentId}`;
      if (visited.has(visitedKey)) break;
      visited.add(visitedKey);

      if (assigneeType === "agent") {
        const row = await db
          .select({ reportsTo: agents.reportsTo, reportsToUserId: agents.reportsToUserId })
          .from(agents)
          .where(and(eq(agents.id, currentId), eq(agents.companyId, companyId)))
          .then((rows) => rows[0] ?? null);
        if (!row) break;
        // Agent hierarchy: reportsTo is another agent, reportsToUserId is a user
        if (row.reportsTo) {
          ancestors.push(row.reportsTo);
          currentId = row.reportsTo;
        } else if (row.reportsToUserId) {
          ancestors.push(row.reportsToUserId);
          // Switch to user walk so we continue up the user's supervisor chain
          assigneeType = "user";
          currentId = row.reportsToUserId;
        } else {
          break;
        }
      } else {
        const row = await db
          .select({
            supervisorAgentId: companyMemberships.supervisorAgentId,
            supervisorUserId: companyMemberships.supervisorUserId,
          })
          .from(companyMemberships)
          .where(
            and(
              eq(companyMemberships.companyId, companyId),
              eq(companyMemberships.principalType, "user"),
              eq(companyMemberships.principalId, currentId),
            ),
          )
          .then((rows) => rows[0] ?? null);
        if (!row) break;
        if (row.supervisorAgentId) {
          ancestors.push(row.supervisorAgentId);
          // Supervisor is an agent — switch to agent walk
          assigneeType = "agent";
          currentId = row.supervisorAgentId;
        } else if (row.supervisorUserId) {
          ancestors.push(row.supervisorUserId);
          currentId = row.supervisorUserId;
        } else {
          break;
        }
      }
    }

    return ancestors;
  }

  async function getPermissionGrant(
    companyId: string,
    principalType: PrincipalType,
    principalId: string,
    permissionKey: PermissionKey,
  ) {
    return db
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

  return {
    isInstanceAdmin,
    canUser,
    hasPermission,
    getMembership,
    ensureMembership,
    listMembers,
    setMemberPermissions,
    promoteInstanceAdmin,
    demoteInstanceAdmin,
    listUserCompanyAccess,
    setUserCompanyAccess,
    setPrincipalGrants,
    resolveAssigneeAncestors,
    getPermissionGrant,
  };
}
