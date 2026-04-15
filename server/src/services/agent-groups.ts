import { and, asc, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agentGroups, agents } from "@paperclipai/db";
import { notFound } from "../errors.js";

export function agentGroupService(db: Db) {
  return {
    list: async (companyId: string) => {
      return db
        .select()
        .from(agentGroups)
        .where(eq(agentGroups.companyId, companyId))
        .orderBy(asc(agentGroups.sortOrder), asc(agentGroups.name));
    },

    getById: async (companyId: string, groupId: string) => {
      const row = await db
        .select()
        .from(agentGroups)
        .where(and(eq(agentGroups.id, groupId), eq(agentGroups.companyId, companyId)))
        .then((rows) => rows[0] ?? null);
      return row;
    },

    create: async (companyId: string, data: { name: string; sortOrder?: number }) => {
      const created = await db
        .insert(agentGroups)
        .values({
          companyId,
          name: data.name,
          sortOrder: data.sortOrder ?? 0,
        })
        .returning()
        .then((rows) => rows[0]);
      return created;
    },

    update: async (companyId: string, groupId: string, data: { name?: string; sortOrder?: number }) => {
      const existing = await db
        .select()
        .from(agentGroups)
        .where(and(eq(agentGroups.id, groupId), eq(agentGroups.companyId, companyId)))
        .then((rows) => rows[0] ?? null);
      if (!existing) throw notFound("Agent group not found");

      const updated = await db
        .update(agentGroups)
        .set({
          ...(data.name !== undefined ? { name: data.name } : {}),
          ...(data.sortOrder !== undefined ? { sortOrder: data.sortOrder } : {}),
          updatedAt: new Date(),
        })
        .where(eq(agentGroups.id, groupId))
        .returning()
        .then((rows) => rows[0] ?? null);
      return updated;
    },

    delete: async (companyId: string, groupId: string) => {
      const existing = await db
        .select()
        .from(agentGroups)
        .where(and(eq(agentGroups.id, groupId), eq(agentGroups.companyId, companyId)))
        .then((rows) => rows[0] ?? null);
      if (!existing) throw notFound("Agent group not found");

      // Unassign agents from this group before deleting
      await db
        .update(agents)
        .set({ groupId: null, updatedAt: new Date() })
        .where(and(eq(agents.companyId, companyId), eq(agents.groupId, groupId)));

      await db.delete(agentGroups).where(eq(agentGroups.id, groupId));
      return existing;
    },
  };
}
