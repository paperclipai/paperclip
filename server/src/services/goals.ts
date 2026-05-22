import { and, asc, desc, eq, isNull, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { goals, issues } from "@paperclipai/db";

type GoalReader = Pick<Db, "select">;

export const GOAL_LINKED_ISSUES_PREVIEW_LIMIT = 20;

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

    getByIdWithLinkedIssues: async (id: string) => {
      const goal = await db
        .select()
        .from(goals)
        .where(eq(goals.id, id))
        .then((rows) => rows[0] ?? null);
      if (!goal) return null;

      const linkedIssues = await db
        .select()
        .from(issues)
        .where(and(eq(issues.companyId, goal.companyId), eq(issues.goalId, id), isNull(issues.hiddenAt)))
        .orderBy(desc(issues.updatedAt))
        .limit(GOAL_LINKED_ISSUES_PREVIEW_LIMIT);
      const [countRow] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(issues)
        .where(and(eq(issues.companyId, goal.companyId), eq(issues.goalId, id), isNull(issues.hiddenAt)));

      return {
        ...goal,
        linkedIssues,
        linkedIssueIdentifiers: linkedIssues.map((issue) => issue.identifier ?? issue.id),
        linkedIssueCount: Number(countRow?.count ?? linkedIssues.length),
      };
    },

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
  };
}
