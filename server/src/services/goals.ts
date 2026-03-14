import { and, asc, eq, inArray, isNull, notInArray, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, goals, issues, projectGoals, projects } from "@paperclipai/db";

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

export async function resolveCeoAgentId(db: Pick<Db, "select">, companyId: string): Promise<string | null> {
  const row = await db
    .select({ id: agents.id })
    .from(agents)
    .where(and(eq(agents.companyId, companyId), eq(agents.role, "ceo")))
    .then((rows) => rows[0] ?? null);
  return row?.id ?? null;
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

    getAncestors: async (goalId: string) => {
      const result: Array<{ id: string; title: string; status: string; level: string; parentId: string | null }> = [];
      const visited = new Set<string>([goalId]);
      const start = await db.select().from(goals).where(eq(goals.id, goalId)).then((r) => r[0] ?? null);
      let currentId = start?.parentId ?? null;
      while (currentId && !visited.has(currentId) && result.length < 50) {
        visited.add(currentId);
        const parent = await db
          .select({ id: goals.id, title: goals.title, status: goals.status, level: goals.level, parentId: goals.parentId })
          .from(goals)
          .where(eq(goals.id, currentId))
          .then((r) => r[0] ?? null);
        if (!parent) break;
        result.push(parent);
        currentId = parent.parentId ?? null;
      }
      return result;
    },

    getChildren: (goalId: string) =>
      db
        .select({ id: goals.id, title: goals.title, status: goals.status, level: goals.level, ownerAgentId: goals.ownerAgentId })
        .from(goals)
        .where(eq(goals.parentId, goalId)),

    getLinkedProjects: async (goalId: string) => {
      const links = await db
        .select({ projectId: projectGoals.projectId })
        .from(projectGoals)
        .where(eq(projectGoals.goalId, goalId));
      if (links.length === 0) return [];
      return db
        .select({ id: projects.id, name: projects.name, status: projects.status, targetDate: projects.targetDate })
        .from(projects)
        .where(inArray(projects.id, links.map((l) => l.projectId)));
    },

    getIssuesForGoal: (goalId: string) =>
      db
        .select({
          id: issues.id, identifier: issues.identifier, title: issues.title,
          status: issues.status, priority: issues.priority,
          assigneeAgentId: issues.assigneeAgentId,
        })
        .from(issues)
        .where(eq(issues.goalId, goalId)),

    countOpenIssues: async (goalId: string): Promise<number> => {
      const result = await db
        .select({ count: sql<number>`count(*)` })
        .from(issues)
        .where(and(eq(issues.goalId, goalId), notInArray(issues.status, ["done", "cancelled"])));
      return Number(result[0]?.count ?? 0);
    },

    countOpenSubgoals: async (parentGoalId: string): Promise<number> => {
      const result = await db
        .select({ count: sql<number>`count(*)` })
        .from(goals)
        .where(and(eq(goals.parentId, parentGoalId), notInArray(goals.status, ["achieved", "cancelled"])));
      return Number(result[0]?.count ?? 0);
    },

    linkProject: async (goalId: string, projectId: string, companyId: string) => {
      await db
        .insert(projectGoals)
        .values({ goalId, projectId, companyId })
        .onConflictDoNothing();
    },

    unlinkProject: async (goalId: string, projectId: string) => {
      await db
        .delete(projectGoals)
        .where(and(eq(projectGoals.goalId, goalId), eq(projectGoals.projectId, projectId)));
    },
  };
}
