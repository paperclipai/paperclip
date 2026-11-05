import { and, asc, eq, isNull } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { goals } from "@paperclipai/db";
import { updateGoalSchema, type UpdateGoal } from "@paperclipai/shared";
import { unprocessable } from "../errors.js";

type GoalReader = Pick<Db, "select">;

async function assertParentCompany(
  db: GoalReader,
  companyId: string,
  parentId: string | null | undefined,
) {
  if (!parentId) return;
  const [parent] = await db.select({ id: goals.id }).from(goals)
    .where(and(eq(goals.id, parentId), eq(goals.companyId, companyId))).for("key share");
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

    create: (companyId: string, data: Omit<typeof goals.$inferInsert, "companyId">) =>
      db.transaction(async (tx) => {
        await assertParentCompany(tx, companyId, data.parentId);
        return tx
          .insert(goals)
          .values({ ...data, companyId })
          .returning()
          .then((rows) => rows[0]);
      }),

    update: (id: string, data: UpdateGoal) =>
      db.transaction(async (tx) => {
        const [existing] = await tx.select({ companyId: goals.companyId }).from(goals)
          .where(eq(goals.id, id)).for("no key update");
        if (!existing) return null;
        // Plugin RPC bypasses the HTTP validator, so enforce the same PATCH
        // contract here before reading or persisting its raw fields.
        const parsed = updateGoalSchema.safeParse(data);
        if (!parsed.success) {
          throw unprocessable("Invalid goal update", parsed.error.issues);
        }
        const requestedCompanyId = (data as Record<string, unknown>).companyId;
        if (requestedCompanyId !== undefined && requestedCompanyId !== existing.companyId) {
          throw unprocessable("Goal company cannot be changed");
        }
        const patch = parsed.data;
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
