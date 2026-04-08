import { and, eq, ne } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, companies, companyMemberships, departments, teams, teamMemberships } from "@paperclipai/db";
import { notFound, unprocessable, conflict } from "../errors.js";

export interface CreateTeamPayload {
  name: string;
  description?: string | null;
  departmentId?: string | null;
}

export interface UpdateTeamPayload {
  name?: string;
  description?: string | null;
  departmentId?: string | null;
}

export interface AddTeamMemberPayload {
  principalType: string;
  principalId: string;
  role?: string;
}

export function teamService(db: Db) {
  async function assertCompanyPrincipalExists(
    companyId: string,
    principalType: string,
    principalId: string,
  ) {
    if (principalType === "agent") {
      const agent = await db
        .select({ id: agents.id })
        .from(agents)
        .where(
          and(
            eq(agents.id, principalId),
            eq(agents.companyId, companyId),
            ne(agents.status, "terminated"),
          ),
        )
        .then((rows) => rows[0] ?? null);
      if (!agent) throw unprocessable("Agent must belong to the same company");
      return;
    }

    if (principalType === "user") {
      const membership = await db
        .select({ id: companyMemberships.id })
        .from(companyMemberships)
        .where(
          and(
            eq(companyMemberships.companyId, companyId),
            eq(companyMemberships.principalType, "user"),
            eq(companyMemberships.principalId, principalId),
            eq(companyMemberships.status, "active"),
          ),
        )
        .then((rows) => rows[0] ?? null);
      if (!membership) throw unprocessable("User must be an active member of the same company");
      return;
    }

    throw unprocessable("Unsupported principal type");
  }

  async function list(companyId: string) {
    return db
      .select()
      .from(teams)
      .where(and(eq(teams.companyId, companyId), eq(teams.status, "active")))
      .orderBy(teams.name);
  }

  async function getById(id: string) {
    const rows = await db.select().from(teams).where(eq(teams.id, id));
    return rows[0] ?? null;
  }

  async function create(companyId: string, data: CreateTeamPayload) {
    if (!data.name?.trim()) {
      throw unprocessable("Team name is required");
    }

    const company = await db.select({ id: companies.id }).from(companies).where(eq(companies.id, companyId));
    if (!company.length) throw notFound("Company not found");

    if (data.departmentId) {
      const dept = await db.select({ id: departments.id, companyId: departments.companyId })
        .from(departments).where(eq(departments.id, data.departmentId));
      if (!dept.length) throw notFound("Department not found");
      if (dept[0].companyId !== companyId) throw unprocessable("Department must belong to the same company");
    }

    try {
      const [result] = await db
        .insert(teams)
        .values({
          companyId,
          name: data.name.trim(),
          description: data.description ?? null,
          departmentId: data.departmentId ?? null,
        })
        .returning();
      return result;
    } catch (err: unknown) {
      if (err instanceof Error && err.message.includes("teams_company_name_uq")) {
        throw conflict(`Team "${data.name}" already exists in this company`);
      }
      throw err;
    }
  }

  async function update(id: string, data: UpdateTeamPayload) {
    const existing = await getById(id);
    if (!existing) throw notFound("Team not found");

    if (data.departmentId !== undefined && data.departmentId !== null) {
      const dept = await db.select({ id: departments.id, companyId: departments.companyId })
        .from(departments).where(eq(departments.id, data.departmentId));
      if (!dept.length) throw notFound("Department not found");
      if (dept[0].companyId !== existing.companyId) throw unprocessable("Department must belong to the same company");
    }

    try {
      const [result] = await db
        .update(teams)
        .set({
          ...(data.name !== undefined && { name: data.name.trim() }),
          ...(data.description !== undefined && { description: data.description }),
          ...(data.departmentId !== undefined && { departmentId: data.departmentId }),
          updatedAt: new Date(),
        })
        .where(eq(teams.id, id))
        .returning();
      return result;
    } catch (err: unknown) {
      if (err instanceof Error && err.message.includes("teams_company_name_uq")) {
        throw conflict(`Team "${data.name}" already exists in this company`);
      }
      throw err;
    }
  }

  async function archive(id: string) {
    const existing = await getById(id);
    if (!existing) throw notFound("Team not found");

    const [result] = await db
      .update(teams)
      .set({ status: "archived", updatedAt: new Date() })
      .where(eq(teams.id, id))
      .returning();
    return result;
  }

  async function addMember(teamId: string, companyId: string, data: AddTeamMemberPayload) {
    const team = await getById(teamId);
    if (!team) throw notFound("Team not found");
    if (team.companyId !== companyId) throw unprocessable("Team does not belong to this company");
    await assertCompanyPrincipalExists(companyId, data.principalType, data.principalId);

    try {
      const [result] = await db
        .insert(teamMemberships)
        .values({
          companyId,
          teamId,
          principalType: data.principalType,
          principalId: data.principalId,
          role: data.role ?? "member",
        })
        .returning();
      return result;
    } catch (err: unknown) {
      if (err instanceof Error && err.message.includes("team_memberships_team_principal_uq")) {
        throw conflict("This principal is already a member of this team");
      }
      throw err;
    }
  }

  async function removeMember(teamId: string, principalType: string, principalId: string) {
    const result = await db
      .delete(teamMemberships)
      .where(
        and(
          eq(teamMemberships.teamId, teamId),
          eq(teamMemberships.principalType, principalType),
          eq(teamMemberships.principalId, principalId),
        ),
      )
      .returning();

    if (!result.length) throw notFound("Membership not found");
  }

  async function listMembers(teamId: string) {
    return db
      .select()
      .from(teamMemberships)
      .where(eq(teamMemberships.teamId, teamId));
  }

  return { list, getById, create, update, archive, addMember, removeMember, listMembers };
}
