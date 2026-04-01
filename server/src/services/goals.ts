import { and, asc, eq, isNull } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, goals } from "@paperclipai/db";
import { notFound, unprocessable } from "../errors.js";

type GoalReader = Pick<Db, "select">;

export async function getDefaultCompanyGoal(db: GoalReader, companyId: string) {
  const activeRootGoal = await db
    .select()
    .from(goals)
    .where(
      and(
        eq(goals.companyId, companyId),
        eq(goals.level, "company"),
        eq(goals.status, "active"),
        isNull(goals.parentId),
      ),
    )
    .orderBy(asc(goals.createdAt))
    .then((rows) => rows[0] ?? null);
  if (activeRootGoal) return activeRootGoal;

  const anyRootGoal = await db
    .select()
    .from(goals)
    .where(
      and(
        eq(goals.companyId, companyId),
        eq(goals.level, "company"),
        isNull(goals.parentId),
      ),
    )
    .orderBy(asc(goals.createdAt))
    .then((rows) => rows[0] ?? null);
  if (anyRootGoal) return anyRootGoal;

  return db
    .select()
    .from(goals)
    .where(and(eq(goals.companyId, companyId), eq(goals.level, "company")))
    .orderBy(asc(goals.createdAt))
    .then((rows) => rows[0] ?? null);
}

export function goalService(db: Db) {
  async function resolveOwnerSeatIdForAgent(companyId: string, ownerAgentId: string | null | undefined) {
    if (!ownerAgentId) return null;
    const row = await db
      .select({
        seatId: agents.seatId,
        companyId: agents.companyId,
      })
      .from(agents)
      .where(eq(agents.id, ownerAgentId))
      .then((rows) => rows[0] ?? null);
    if (!row) throw notFound("Owner agent not found");
    if (row.companyId !== companyId) throw unprocessable("Owner agent must belong to same company");
    return row.seatId ?? null;
  }

  return {
    list: (companyId: string) => db.select().from(goals).where(eq(goals.companyId, companyId)),

    getById: (id: string) =>
      db
        .select()
        .from(goals)
        .where(eq(goals.id, id))
        .then((rows) => rows[0] ?? null),

    getDefaultCompanyGoal: (companyId: string) => getDefaultCompanyGoal(db, companyId),

    create: async (companyId: string, data: Omit<typeof goals.$inferInsert, "companyId">) => {
      const derivedOwnerSeatId =
        data.ownerSeatId !== undefined
          ? data.ownerSeatId
          : await resolveOwnerSeatIdForAgent(companyId, data.ownerAgentId);
      return db
        .insert(goals)
        .values({ ...data, ownerSeatId: derivedOwnerSeatId, companyId })
        .returning()
        .then((rows) => rows[0]);
    },

    update: async (id: string, data: Partial<typeof goals.$inferInsert>) => {
      const existing = await db
        .select()
        .from(goals)
        .where(eq(goals.id, id))
        .then((rows) => rows[0] ?? null);
      if (!existing) return null;
      const patch: Partial<typeof goals.$inferInsert> = { ...data, updatedAt: new Date() };
      if (data.ownerSeatId === undefined && data.ownerAgentId !== undefined) {
        patch.ownerSeatId = await resolveOwnerSeatIdForAgent(existing.companyId, data.ownerAgentId);
      }
      return db
        .update(goals)
        .set(patch)
        .where(eq(goals.id, id))
        .returning()
        .then((rows) => rows[0] ?? null);
    },

    remove: (id: string) =>
      db
        .delete(goals)
        .where(eq(goals.id, id))
        .returning()
        .then((rows) => rows[0] ?? null),
  };
}
