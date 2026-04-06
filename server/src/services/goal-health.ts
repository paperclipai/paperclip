import { eq, sql } from "drizzle-orm";
import type { Db } from "@ironworksai/db";
import { goals, issues } from "@ironworksai/db";
import type { GoalHealthStatus } from "@ironworksai/shared";

export interface HealthResult {
  score: number;
  status: GoalHealthStatus;
}

/**
 * Compute a unified health score (0-100) for a goal.
 *
 * Inputs:
 *  - progress %
 *  - time elapsed % (from start_date/target_date)
 *  - blocked issue count
 *  - overdue issues (issues with due date past)
 *  - confidence (from latest check-in or goal)
 *  - days since last check-in
 *
 * Weights:
 *  - pace (progress vs time elapsed): 40%
 *  - confidence: 25%
 *  - blockers penalty: 20%
 *  - recency of check-in: 15%
 */
export async function computeGoalHealth(db: Db, goalId: string): Promise<HealthResult> {
  const [goal] = await db
    .select()
    .from(goals)
    .where(eq(goals.id, goalId))
    .limit(1);

  if (!goal) {
    return { score: 0, status: "no_data" };
  }

  // If the goal is already achieved/cancelled, return early
  if (goal.status === "achieved") {
    await db.update(goals).set({ healthScore: 100, healthStatus: "achieved" }).where(eq(goals.id, goalId));
    return { score: 100, status: "achieved" };
  }

  // Get issue stats
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
  const blocked = Number(counts?.blockedIssues ?? 0);

  if (total === 0) {
    await db.update(goals).set({ healthScore: null, healthStatus: "no_data" }).where(eq(goals.id, goalId));
    return { score: 0, status: "no_data" };
  }

  const progressPercent = (completed / total) * 100;

  // Time elapsed
  let timeElapsedPercent = 50; // default if no dates set
  const now = Date.now();
  const startMs = goal.startDate ? new Date(goal.startDate).getTime() : goal.createdAt.getTime();
  const endMs = goal.targetDate ? new Date(goal.targetDate).getTime() : 0;

  if (endMs > startMs) {
    const elapsed = now - startMs;
    const duration = endMs - startMs;
    timeElapsedPercent = Math.min(100, Math.max(0, (elapsed / duration) * 100));
  }

  // Pace score: how progress compares to time elapsed (40%)
  // If progress >= timeElapsed, pace is 100. Otherwise degrade linearly.
  let paceScore: number;
  if (timeElapsedPercent === 0) {
    paceScore = 100;
  } else {
    const ratio = progressPercent / timeElapsedPercent;
    paceScore = Math.min(100, ratio * 100);
  }

  // Confidence score (25%) - use goal's confidence, default 50
  const confidenceScore = goal.confidence ?? 50;

  // Blocker penalty (20%) - each blocker reduces score
  const blockerRatio = total > 0 ? blocked / total : 0;
  const blockerScore = Math.max(0, 100 - blockerRatio * 200); // 50% blocked = score 0

  // Recency score (15%) - placeholder, based on updatedAt for now
  const daysSinceUpdate = (now - goal.updatedAt.getTime()) / (1000 * 60 * 60 * 24);
  const recencyScore = daysSinceUpdate <= 7 ? 100 : daysSinceUpdate <= 14 ? 70 : daysSinceUpdate <= 30 ? 40 : 10;

  // Weighted composite
  const score = Math.round(
    paceScore * 0.4 +
    confidenceScore * 0.25 +
    blockerScore * 0.2 +
    recencyScore * 0.15,
  );

  const clampedScore = Math.min(100, Math.max(0, score));

  let status: GoalHealthStatus;
  if (clampedScore > 66) {
    status = "on_track";
  } else if (clampedScore >= 33) {
    status = "at_risk";
  } else {
    status = "off_track";
  }

  // Persist to goals table
  await db
    .update(goals)
    .set({ healthScore: clampedScore, healthStatus: status, updatedAt: new Date() })
    .where(eq(goals.id, goalId));

  return { score: clampedScore, status };
}
