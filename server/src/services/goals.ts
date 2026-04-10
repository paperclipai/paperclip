import { and, asc, eq, isNull, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { goals, issues } from "@paperclipai/db";

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

    /**
     * Progress summary for a goal, computed from linked issues. Scoped to
     * the goal's company as defense-in-depth: the calling route already
     * enforces company access via `assertCompanyAccess`, but the query
     * itself also filters by `companyId` so a misrouted call cannot leak
     * cross-tenant data.
     *
     * Counts only `done` toward completion. Cancelled issues are excluded
     * from BOTH numerator and denominator — they're abandoned work, not
     * completed work, so including them would either inflate the
     * completion percentage (if counted as done) or deflate it (if left
     * in the total with the cancelled work still open).
     */
    getProgress: async (companyId: string, goalId: string) => {
      const rows = await db
        .select({
          totalIssues: sql<number>`count(*) filter (where ${issues.status} <> 'cancelled')::int`,
          doneIssues: sql<number>`count(*) filter (where ${issues.status} = 'done')::int`,
        })
        .from(issues)
        .where(and(eq(issues.goalId, goalId), eq(issues.companyId, companyId)));

      const row = rows[0] ?? { totalIssues: 0, doneIssues: 0 };
      const total = Number(row.totalIssues) || 0;
      const done = Number(row.doneIssues) || 0;
      const completionPct = total === 0 ? 0 : Math.round((done / total) * 100);
      return { totalIssues: total, doneIssues: done, completionPct };
    },
  };
}
