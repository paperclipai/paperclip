import { and, asc, eq, isNull } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { goals } from "@paperclipai/db";
import { unprocessable } from "../errors.js";

type GoalReader = Pick<Db, "select">;
type GoalUpdate = Partial<Pick<typeof goals.$inferInsert,
  "title" | "description" | "level" | "status" | "parentId" | "ownerAgentId"
>>;

async function assertParentCompany(
  db: GoalReader,
  companyId: string,
  parentId: string | null | undefined,
) {
  if (!parentId) return;
  const [parent] = await db.select({ id: goals.id }).from(goals)
    .where(and(eq(goals.id, parentId), eq(goals.companyId, companyId)));
  if (!parent) throw unprocessable("Parent goal not found in this company");
}

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
      await assertParentCompany(db, companyId, data.parentId);
      return db
        .insert(goals)
        .values({ ...data, companyId })
        .returning()
        .then((rows) => rows[0]);
    },

    update: (id: string, data: GoalUpdate) =>
      db.transaction(async (tx) => {
        const [existing] = await tx.select({ companyId: goals.companyId }).from(goals)
          .where(eq(goals.id, id)).for("no key update");
        if (!existing) return null;
        const requestedCompanyId = (data as Record<string, unknown>).companyId;
        if (requestedCompanyId !== undefined && requestedCompanyId !== existing.companyId) {
          throw unprocessable("Goal company cannot be changed");
        }
        // Plugin RPC patches are untyped at runtime. Only the documented
        // update fields may reach SQL; neither ID nor company is mutable.
        const patch = {
          title: data.title,
          description: data.description,
          level: data.level,
          status: data.status,
          parentId: data.parentId,
          ownerAgentId: data.ownerAgentId,
        };
        await assertParentCompany(tx, existing.companyId, patch.parentId);
        return tx
          .update(goals)
          .set({ ...patch, updatedAt: new Date() })
          .where(eq(goals.id, id))
          .returning()
          .then((rows) => rows[0] ?? null);
      }),

    remove: (id: string) =>
      db
        .delete(goals)
        .where(eq(goals.id, id))
        .returning()
        .then((rows) => rows[0] ?? null),
  };
}
