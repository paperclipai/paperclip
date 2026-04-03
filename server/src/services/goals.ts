import { and, asc, eq, isNull } from "drizzle-orm";
import type { Db } from "@ironworksai/db";
import { goals, goalKeyResults } from "@ironworksai/db";

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
      db
        .insert(goals)
        .values({ ...data, companyId })
        .returning()
        .then((rows) => rows[0]),

    update: (id: string, data: Partial<typeof goals.$inferInsert>) =>
      db
        .update(goals)
        .set({ ...data, updatedAt: new Date() })
        .where(eq(goals.id, id))
        .returning()
        .then((rows) => rows[0] ?? null),

    remove: (id: string) =>
      db
        .delete(goals)
        .where(eq(goals.id, id))
        .returning()
        .then((rows) => rows[0] ?? null),

    // Key Results
    listKeyResults: (goalId: string) =>
      db
        .select()
        .from(goalKeyResults)
        .where(eq(goalKeyResults.goalId, goalId)),

    createKeyResult: (goalId: string, companyId: string, data: { description: string; targetValue?: string; unit?: string }) =>
      db
        .insert(goalKeyResults)
        .values({
          goalId,
          companyId,
          description: data.description,
          targetValue: data.targetValue ?? "100",
          unit: data.unit ?? "%",
        })
        .returning()
        .then((rows) => rows[0]),

    updateKeyResult: (krId: string, data: { description?: string; targetValue?: string; currentValue?: string; unit?: string }) =>
      db
        .update(goalKeyResults)
        .set({ ...data, updatedAt: new Date() })
        .where(eq(goalKeyResults.id, krId))
        .returning()
        .then((rows) => rows[0] ?? null),

    removeKeyResult: (krId: string) =>
      db
        .delete(goalKeyResults)
        .where(eq(goalKeyResults.id, krId))
        .returning()
        .then((rows) => rows[0] ?? null),
  };
}
