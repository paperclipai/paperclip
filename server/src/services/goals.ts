import { asc, count, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  costEvents,
  goals,
  issues,
  projectGoals,
  projects,
} from "@paperclipai/db";
import { conflict } from "../errors.js";

function countValue(rows: Array<{ count: unknown }>) {
  return Number(rows[0]?.count ?? 0);
}

function buildDeleteConflictMessage(dependencies: string[]) {
  if (dependencies.length === 1) {
    return `Roadmap item cannot be deleted while ${dependencies[0]} still reference it. Clear those dependencies or set this roadmap item to cancelled instead.`;
  }

  const leadingDependencies = dependencies.slice(0, -1);
  const lastDependency = dependencies[dependencies.length - 1];
  return `Roadmap item cannot be deleted while ${leadingDependencies.join(
    ", "
  )} and ${lastDependency} still reference it. Clear those dependencies or set this roadmap item to cancelled instead.`;
}

function isForeignKeyConflict(error: unknown) {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: string }).code === "23503"
  );
}

export function goalService(db: Db) {
  return {
    list: (companyId: string) =>
      db
        .select()
        .from(goals)
        .where(eq(goals.companyId, companyId))
        // Roadmap consumers expect a stable order so parent/child trees render predictably.
        .orderBy(asc(goals.sortOrder), asc(goals.createdAt)),

    getById: (id: string) =>
      db
        .select()
        .from(goals)
        .where(eq(goals.id, id))
        .then((rows) => rows[0] ?? null),

    create: (
      companyId: string,
      data: Omit<typeof goals.$inferInsert, "companyId">
    ) =>
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
      db.transaction(async (tx) => {
        // Check the direct UI-visible blockers first so delete failures stay explainable and deterministic.
        const childGoalCount = countValue(
          await tx
            .select({ count: count() })
            .from(goals)
            .where(eq(goals.parentId, id))
        );
        const directProjectCount = countValue(
          await tx
            .select({ count: count() })
            .from(projects)
            .where(eq(projects.goalId, id))
        );
        const linkedProjectCount = countValue(
          await tx
            .select({ count: count() })
            .from(projectGoals)
            .where(eq(projectGoals.goalId, id))
        );

        // These relations are not surfaced on the detail screen today, but they still need friendly copy instead of a raw FK failure.
        const linkedIssueCount = countValue(
          await tx
            .select({ count: count() })
            .from(issues)
            .where(eq(issues.goalId, id))
        );
        const historicalCostCount = countValue(
          await tx
            .select({ count: count() })
            .from(costEvents)
            .where(eq(costEvents.goalId, id))
        );

        const dependencies: string[] = [];
        if (childGoalCount > 0) dependencies.push("child roadmap items");
        if (directProjectCount > 0 || linkedProjectCount > 0)
          dependencies.push("linked projects");
        if (linkedIssueCount > 0) dependencies.push("linked issues");
        if (historicalCostCount > 0)
          dependencies.push("historical cost records");

        if (dependencies.length > 0) {
          throw conflict(buildDeleteConflictMessage(dependencies), {
            childGoalCount,
            linkedIssueCount,
            linkedProjectCount: directProjectCount + linkedProjectCount,
            historicalCostCount,
          });
        }

        try {
          const rows = await tx
            .delete(goals)
            .where(eq(goals.id, id))
            .returning();
          return rows[0] ?? null;
        } catch (error) {
          if (isForeignKeyConflict(error)) {
            throw conflict(
              "Roadmap item cannot be deleted while other records still reference it. Clear those dependencies or set this roadmap item to cancelled instead."
            );
          }
          throw error;
        }
      }),
  };
}
