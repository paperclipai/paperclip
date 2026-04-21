import { and, asc, count, eq, isNull, ne } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { goals } from "@paperclipai/db";
import { unprocessable } from "../errors.js";

type GoalReader = Pick<Db, "select">;

function isRootCompanyGoal(goal: { level: string; parentId: string | null }) {
  return goal.level === "company" && goal.parentId == null;
}

async function countOtherRootCompanyGoals(
  db: GoalReader,
  companyId: string,
  excludeGoalId: string,
) {
  const [row] = await db
    .select({ c: count() })
    .from(goals)
    .where(
      and(
        eq(goals.companyId, companyId),
        eq(goals.level, "company"),
        isNull(goals.parentId),
        ne(goals.id, excludeGoalId),
      ),
    );
  return Number(row?.c ?? 0);
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
      db
        .insert(goals)
        .values({ ...data, companyId })
        .returning()
        .then((rows) => rows[0]),

    update: async (id: string, data: Partial<typeof goals.$inferInsert>) => {
      const existing = await db
        .select()
        .from(goals)
        .where(eq(goals.id, id))
        .then((rows) => rows[0] ?? null);
      if (!existing) return null;

      const mergedLevel = data.level ?? existing.level;
      const mergedParentId = data.parentId !== undefined ? data.parentId : existing.parentId;

      if (
        isRootCompanyGoal(existing) &&
        !isRootCompanyGoal({ level: mergedLevel, parentId: mergedParentId })
      ) {
        const others = await countOtherRootCompanyGoals(db, existing.companyId, id);
        if (others === 0) {
          throw unprocessable("Companies must keep at least one root company-level goal.");
        }
      }

      return db
        .update(goals)
        .set({ ...data, updatedAt: new Date() })
        .where(eq(goals.id, id))
        .returning()
        .then((rows) => rows[0] ?? null);
    },

    remove: async (id: string) => {
      const existing = await db
        .select()
        .from(goals)
        .where(eq(goals.id, id))
        .then((rows) => rows[0] ?? null);
      if (!existing) return null;

      if (isRootCompanyGoal(existing)) {
        const others = await countOtherRootCompanyGoals(db, existing.companyId, id);
        if (others === 0) {
          throw unprocessable("Companies must keep at least one root company-level goal.");
        }
      }

      return db
        .delete(goals)
        .where(eq(goals.id, id))
        .returning()
        .then((rows) => rows[0] ?? null);
    },
  };
}
