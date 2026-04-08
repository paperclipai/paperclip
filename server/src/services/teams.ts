import { and, eq, asc } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { teams, teamMembers, teamWorkflowStatuses } from "@paperclipai/db";
import { DEFAULT_WORKFLOW_STATUSES } from "@paperclipai/shared";

export function teamService(db: Db) {
  return {
    list: (companyId: string) =>
      db
        .select()
        .from(teams)
        .where(eq(teams.companyId, companyId))
        .orderBy(asc(teams.name)),

    getById: (id: string) =>
      db
        .select()
        .from(teams)
        .where(eq(teams.id, id))
        .then((rows) => rows[0] ?? null),

    getByIdentifier: (companyId: string, identifier: string) =>
      db
        .select()
        .from(teams)
        .where(and(eq(teams.companyId, companyId), eq(teams.identifier, identifier)))
        .then((rows) => rows[0] ?? null),

    create: async (
      companyId: string,
      data: Omit<typeof teams.$inferInsert, "companyId">,
    ) => {
      const existing = await db
        .select()
        .from(teams)
        .where(and(eq(teams.companyId, companyId), eq(teams.identifier, data.identifier!)))
        .then((rows) => rows[0] ?? null);
      if (existing) {
        throw Object.assign(new Error("Team identifier already exists"), { status: 409 });
      }

      const team = await db
        .insert(teams)
        .values({ ...data, companyId })
        .returning()
        .then((rows) => rows[0]);

      // Seed default workflow statuses
      await db.insert(teamWorkflowStatuses).values(
        DEFAULT_WORKFLOW_STATUSES.map((s) => ({
          teamId: team.id,
          name: s.name,
          slug: s.slug,
          category: s.category,
          color: s.color,
          position: s.position,
          isDefault: s.isDefault,
        })),
      );

      // Sync lead_agent_id → team_members as lead role
      if (data.leadAgentId) {
        await db
          .insert(teamMembers)
          .values({ teamId: team.id, agentId: data.leadAgentId, role: "lead" })
          .onConflictDoUpdate({
            target: [teamMembers.teamId, teamMembers.agentId],
            set: { role: "lead", updatedAt: new Date() },
          });
      }

      return team;
    },

    update: async (id: string, data: Partial<typeof teams.$inferInsert>) => {
      const team = await db
        .update(teams)
        .set({ ...data, updatedAt: new Date() })
        .where(eq(teams.id, id))
        .returning()
        .then((rows) => rows[0] ?? null);

      // Sync lead_agent_id change → team_members
      if (team && data.leadAgentId !== undefined) {
        // Demote old leads
        await db
          .update(teamMembers)
          .set({ role: "member", updatedAt: new Date() })
          .where(and(eq(teamMembers.teamId, id), eq(teamMembers.role, "lead")));

        if (data.leadAgentId) {
          await db
            .insert(teamMembers)
            .values({ teamId: id, agentId: data.leadAgentId, role: "lead" })
            .onConflictDoUpdate({
              target: [teamMembers.teamId, teamMembers.agentId],
              set: { role: "lead", updatedAt: new Date() },
            });
        }
      }

      return team;
    },

    remove: (id: string) =>
      db
        .update(teams)
        .set({ status: "deleted", updatedAt: new Date() })
        .where(eq(teams.id, id))
        .returning()
        .then((rows) => rows[0] ?? null),

    // --- Members ---

    listMembers: (teamId: string) =>
      db
        .select()
        .from(teamMembers)
        .where(eq(teamMembers.teamId, teamId))
        .orderBy(asc(teamMembers.createdAt)),

    addMember: (teamId: string, data: { agentId?: string; userId?: string; role?: string }) =>
      db
        .insert(teamMembers)
        .values({ teamId, ...data })
        .onConflictDoNothing()
        .returning()
        .then((rows) => rows[0] ?? null),

    removeMember: (memberId: string) =>
      db
        .delete(teamMembers)
        .where(eq(teamMembers.id, memberId))
        .returning()
        .then((rows) => rows[0] ?? null),
  };
}
