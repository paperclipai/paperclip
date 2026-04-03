import { and, eq, gte, ne, sql } from "drizzle-orm";
import type { Db } from "@ironworksai/db";
import { agents, issues } from "@ironworksai/db";
import { logger } from "../middleware/logger.js";

// ── Agent Performance Score ─────────────────────────────────────────────────
//
// Computes a 0-100 score for each agent based on four factors (each 0-25):
//   1. Issue completion rate
//   2. Approval pass rate (placeholder - approvals system pending)
//   3. Budget efficiency
//   4. Activity level (recent issue throughput)

const NEUTRAL_SCORE = 15;

/**
 * Compute the performance score (0-100) for a single agent.
 *
 * Score breakdown:
 *   - Issue completion rate (0-25): completed / (completed + cancelled) * 25
 *   - Approval pass rate (0-25): currently returns neutral (15) as placeholder
 *   - Budget efficiency (0-25): based on budget vs spend ratio
 *   - Activity level (0-25): based on issues completed in the last 30 days
 */
export async function computePerformanceScore(
  db: Db,
  agentId: string,
  companyId: string,
): Promise<number> {
  // ── Factor 1: Issue completion rate ─────────────────────────────
  const completionStats = await db
    .select({
      completed: sql<number>`count(case when ${issues.status} = 'done' then 1 end)::int`,
      cancelled: sql<number>`count(case when ${issues.status} = 'cancelled' then 1 end)::int`,
    })
    .from(issues)
    .where(
      and(
        eq(issues.companyId, companyId),
        eq(issues.assigneeAgentId, agentId),
      ),
    );

  const stats = completionStats[0];
  const completed = Number(stats?.completed ?? 0);
  const cancelled = Number(stats?.cancelled ?? 0);
  const totalResolved = completed + cancelled;

  const completionScore =
    totalResolved > 0 ? Math.round((completed / totalResolved) * 25) : NEUTRAL_SCORE;

  // ── Factor 2: Approval pass rate ────────────────────────────────
  // TODO: Wire into the approvals system when first-time-approval tracking is added
  const approvalScore = NEUTRAL_SCORE;

  // ── Factor 3: Budget efficiency ─────────────────────────────────
  const agentRow = await db
    .select({
      budgetMonthlyCents: agents.budgetMonthlyCents,
      spentMonthlyCents: agents.spentMonthlyCents,
    })
    .from(agents)
    .where(eq(agents.id, agentId))
    .then((rows) => rows[0] ?? null);

  let budgetScore = NEUTRAL_SCORE;
  if (agentRow && agentRow.budgetMonthlyCents > 0) {
    const ratio = agentRow.spentMonthlyCents / agentRow.budgetMonthlyCents;
    if (ratio <= 1.0) {
      budgetScore = 25;
    } else if (ratio <= 1.2) {
      budgetScore = 15;
    } else {
      budgetScore = 5;
    }
  }

  // ── Factor 4: Activity level (last 30 days) ────────────────────
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

  const recentActivity = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(issues)
    .where(
      and(
        eq(issues.companyId, companyId),
        eq(issues.assigneeAgentId, agentId),
        eq(issues.status, "done"),
        gte(issues.completedAt, thirtyDaysAgo),
      ),
    );

  const recentCompleted = Number(recentActivity[0]?.count ?? 0);
  let activityScore: number;
  if (recentCompleted > 10) {
    activityScore = 25;
  } else if (recentCompleted >= 5) {
    activityScore = 20;
  } else if (recentCompleted >= 1) {
    activityScore = 15;
  } else {
    activityScore = 5;
  }

  const totalScore = completionScore + approvalScore + budgetScore + activityScore;

  return Math.min(100, Math.max(0, totalScore));
}

/**
 * Recompute and persist performance scores for all non-terminated agents
 * in the given company.
 */
export async function updateAllPerformanceScores(
  db: Db,
  companyId: string,
): Promise<void> {
  const companyAgents = await db
    .select({ id: agents.id })
    .from(agents)
    .where(
      and(
        eq(agents.companyId, companyId),
        ne(agents.status, "terminated"),
      ),
    );

  const now = new Date();
  let updated = 0;

  for (const agent of companyAgents) {
    const score = await computePerformanceScore(db, agent.id, companyId);

    await db
      .update(agents)
      .set({
        performanceScore: score,
        updatedAt: now,
      })
      .where(eq(agents.id, agent.id));

    updated++;
  }

  logger.info(
    { companyId, agentsUpdated: updated },
    "updated performance scores for company agents",
  );
}
