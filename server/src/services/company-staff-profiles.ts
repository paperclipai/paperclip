import { and, eq, inArray } from "drizzle-orm";
import { agents, authUsers, companyMemberships, companyStaffProfiles, type Db } from "@paperclipai/db";
import type { OrgPrincipalRef, UpdateCompanyStaffProfile } from "@paperclipai/shared";
import { badRequest, notFound } from "../errors.js";
import { assertHybridReportingAcyclic } from "./company-reporting-graph.js";

export type CompanyStaffProfileRecord = typeof companyStaffProfiles.$inferSelect;

export function companyStaffProfileService(db: Db) {
  return {
    listForCompany: async (companyId: string): Promise<CompanyStaffProfileRecord[]> => db
      .select()
      .from(companyStaffProfiles)
      .where(eq(companyStaffProfiles.companyId, companyId)),

    getForUser: async (companyId: string, userId: string) => db
      .select()
      .from(companyStaffProfiles)
      .where(and(eq(companyStaffProfiles.companyId, companyId), eq(companyStaffProfiles.userId, userId)))
      .then((rows) => rows[0] ?? null),

    validateForMember: async (
      companyId: string,
      userId: string,
      patch: UpdateCompanyStaffProfile,
    ): Promise<void> => {
      await validateStaffProfilePatch(db, companyId, userId, patch);
    },

    upsertForMember: async (
      companyId: string,
      userId: string,
      patch: UpdateCompanyStaffProfile,
    ): Promise<CompanyStaffProfileRecord> => {
      await validateStaffProfilePatch(db, companyId, userId, patch);

      const existing = await companyStaffProfileService(db).getForUser(companyId, userId);
      const normalizedReports = patch.reportsTo === undefined
        ? {}
        : patch.reportsTo && patch.reportsTo.id
          ? { reportsToPrincipalType: patch.reportsTo.type, reportsToPrincipalId: patch.reportsTo.id }
          : { reportsToPrincipalType: null, reportsToPrincipalId: null };

      if (existing) {
        const [updated] = await db
          .update(companyStaffProfiles)
          .set({
            ...(patch.jobTitle !== undefined ? { jobTitle: patch.jobTitle } : {}),
            ...(patch.orgRole !== undefined ? { orgRole: patch.orgRole } : {}),
            ...(patch.capabilities !== undefined ? { capabilities: patch.capabilities } : {}),
            ...(patch.reportsTo !== undefined ? normalizedReports : {}),
            updatedAt: new Date(),
          })
          .where(eq(companyStaffProfiles.id, existing.id))
          .returning();
        return updated!;
      }

      const [created] = await db
        .insert(companyStaffProfiles)
        .values({
          companyId,
          userId,
          jobTitle: patch.jobTitle ?? null,
          orgRole: patch.orgRole ?? null,
          capabilities: patch.capabilities ?? null,
          ...normalizedReports,
        })
        .returning();
      return created!;
    },
  };
}

async function validateStaffProfilePatch(
  db: Db,
  companyId: string,
  userId: string,
  patch: UpdateCompanyStaffProfile,
): Promise<void> {
  const [membership] = await db
    .select({ id: companyMemberships.id })
    .from(companyMemberships)
    .where(and(
      eq(companyMemberships.companyId, companyId),
      eq(companyMemberships.principalType, "user"),
      eq(companyMemberships.principalId, userId),
      inArray(companyMemberships.status, ["pending", "active", "suspended"]),
    ));
  if (!membership) throw notFound("Human member not found");

  if (patch.reportsTo !== undefined) {
    if (patch.reportsTo === null) {
      await assertHybridReportingAcyclic(db, companyId, { type: "user", id: userId }, null);
    } else if (patch.reportsTo.type === "user" && patch.reportsTo.id === userId) {
      throw badRequest("A member cannot report to themself");
    } else if (patch.reportsTo.type === "agent") {
      const [validAgent] = await db
        .select({ id: agents.id, status: agents.status })
        .from(agents)
        .where(and(eq(agents.companyId, companyId), eq(agents.id, patch.reportsTo.id)));
      if (!validAgent || validAgent.status === "terminated") throw badRequest("Reports-to agent is not in this company");
      await assertHybridReportingAcyclic(db, companyId, { type: "user", id: userId }, patch.reportsTo);
    } else if (patch.reportsTo.type === "user") {
      const [other] = await db
        .select({ id: companyMemberships.id })
        .from(companyMemberships)
        .where(and(
          eq(companyMemberships.companyId, companyId),
          eq(companyMemberships.principalType, "user"),
          eq(companyMemberships.principalId, patch.reportsTo.id),
          eq(companyMemberships.status, "active"),
        ));
      if (!other) throw badRequest("Reports-to member is not active in this company");
      await assertHybridReportingAcyclic(db, companyId, { type: "user", id: userId }, patch.reportsTo);
    }
  }
}

export async function loadStaffProfilesByUserId(
  db: Db,
  companyId: string,
): Promise<Map<string, CompanyStaffProfileRecord>> {
  const rows = await companyStaffProfileService(db).listForCompany(companyId);
  return new Map(rows.map((row) => [row.userId, row]));
}

export async function loadActiveHumanMembers(
  db: Db,
  companyId: string,
): Promise<Array<{ userId: string; membershipRole: string | null; status: string; displayName: string }>> {
  const members = await db
    .select({
      userId: companyMemberships.principalId,
      membershipRole: companyMemberships.membershipRole,
      status: companyMemberships.status,
    })
    .from(companyMemberships)
    .where(and(
      eq(companyMemberships.companyId, companyId),
      eq(companyMemberships.principalType, "user"),
      eq(companyMemberships.status, "active"),
    ));
  const userIds = [...new Set(members.map((member) => member.userId))];
  const users = userIds.length > 0
    ? await db.select().from(authUsers).where(inArray(authUsers.id, userIds))
    : [];
  const userMap = new Map(users.map((user) => [user.id, user]));
  return members.map((member) => {
    const user = userMap.get(member.userId);
    return {
      ...member,
      displayName: user?.name?.trim() || user?.email?.trim() || member.userId,
    };
  });
}
