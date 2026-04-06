import { eq, sql } from "drizzle-orm";
import type { Db } from "@ironworksai/db";
import { goals, goalSnapshots, issues, costEvents } from "@ironworksai/db";
import { logger } from "../middleware/logger.js";

/**
 * Capture a point-in-time snapshot for a single goal.
 */
export async function snapshotGoal(db: Db, goalId: string): Promise<void> {
  const [goal] = await db
    .select()
    .from(goals)
    .where(eq(goals.id, goalId))
    .limit(1);

  if (!goal) return;

  const [counts] = await db
    .select({
      totalIssues: sql<number>`count(*)`,
      completedIssues: sql<number>`count(*) filter (where ${issues.status} = 'done')`,
      blockedIssues: sql<number>`count(*) filter (where ${issues.status} = 'blocked')`,
    })
    .from(issues)
    .where(eq(issues.goalId, goalId));

  const total = Number(counts?.totalIssues ?? 0);
  const completed = Number(counts?.completedIssues ?? 0);
  const progressPercent = total > 0 ? ((completed / total) * 100).toFixed(2) : null;

  // Budget spent - sum cost events for issues linked to this goal
  const [budgetRow] = await db
    .select({
      totalCents: sql<string>`coalesce(sum(${costEvents.costCents}), 0)`,
    })
    .from(costEvents)
    .innerJoin(issues, eq(costEvents.issueId, issues.id))
    .where(eq(issues.goalId, goalId));

  const budgetSpentCents = BigInt(budgetRow?.totalCents ?? "0");

  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD

  await db.insert(goalSnapshots).values({
    goalId,
    companyId: goal.companyId,
    snapshotDate: today,
    progressPercent,
    healthScore: goal.healthScore,
    confidence: goal.confidence,
    totalIssues: total,
    completedIssues: completed,
    blockedIssues: Number(counts?.blockedIssues ?? 0),
    budgetSpentCents,
  });
}

/**
 * Capture snapshots for all active goals in a company.
 */
export async function snapshotAllGoals(db: Db, companyId: string): Promise<void> {
  const companyGoals = await db
    .select({ id: goals.id })
    .from(goals)
    .where(eq(goals.companyId, companyId));

  for (const goal of companyGoals) {
    try {
      await snapshotGoal(db, goal.id);
    } catch (err) {
      logger.error({ goalId: goal.id, err }, "Failed to snapshot goal");
    }
  }
}

/**
 * Nightly batch: snapshot all goals across all companies.
 */
export async function snapshotAllCompanyGoals(db: Db): Promise<void> {
  const allCompanies = await db
    .selectDistinct({ companyId: goals.companyId })
    .from(goals);

  for (const row of allCompanies) {
    try {
      await snapshotAllGoals(db, row.companyId);
    } catch (err) {
      logger.error({ companyId: row.companyId, err }, "Failed to snapshot company goals");
    }
  }
}
