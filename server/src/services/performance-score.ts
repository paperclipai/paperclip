import { and, asc, eq, gte, ne, sql } from "drizzle-orm";
import type { Db } from "@ironworksai/db";
import { agents, agentMemoryEntries, companies, heartbeatRuns, issues } from "@ironworksai/db";
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

// ── Agent Utilization Tracking ─────────────────────────────────────────────

const DEFAULT_RUN_DURATION_MINUTES = 5;

/**
 * Compute agent utilization as a percentage of calendar time spent actively running.
 *
 * Counts heartbeat runs in the period, uses actual run durations where available
 * (startedAt to finishedAt), or falls back to a default estimate per run.
 */
export async function computeAgentUtilization(
  db: Db,
  agentId: string,
  periodDays: number = 30,
): Promise<{
  activeMinutes: number;
  totalMinutes: number;
  utilizationPct: number;
}> {
  const periodStart = new Date(Date.now() - periodDays * 24 * 60 * 60 * 1000);
  const totalMinutes = periodDays * 24 * 60;

  // Get runs with timing data
  const runs = await db
    .select({
      startedAt: heartbeatRuns.startedAt,
      finishedAt: heartbeatRuns.finishedAt,
    })
    .from(heartbeatRuns)
    .where(
      and(
        eq(heartbeatRuns.agentId, agentId),
        gte(heartbeatRuns.createdAt, periodStart),
      ),
    );

  let activeMinutes = 0;
  for (const run of runs) {
    if (run.startedAt && run.finishedAt) {
      const durationMs = run.finishedAt.getTime() - run.startedAt.getTime();
      activeMinutes += Math.max(0, durationMs / (60 * 1000));
    } else {
      activeMinutes += DEFAULT_RUN_DURATION_MINUTES;
    }
  }

  activeMinutes = Math.round(activeMinutes);
  const utilizationPct = totalMinutes > 0
    ? Math.min(100, Math.round((activeMinutes / totalMinutes) * 100))
    : 0;

  return { activeMinutes, totalMinutes, utilizationPct };
}

// ── Performance Snapshots ──────────────────────────────────────────────────

// ── Onboarding Effectiveness Metrics ──────────────────────────────────────────

/**
 * Compute onboarding effectiveness metrics for a single agent.
 *
 * Returns:
 *   - hiredAt: when the agent was created/hired
 *   - firstIssueCompletedAt: timestamp of their first completed issue
 *   - rampTimeDays: days from hire to first completed issue (null if no issues done yet)
 *   - firstWeekIssues: number of issues completed within 7 days of hire
 */
export async function onboardingMetrics(
  db: Db,
  agentId: string,
): Promise<{
  hiredAt: Date | null;
  firstIssueCompletedAt: Date | null;
  rampTimeDays: number | null;
  firstWeekIssues: number;
}> {
  const agentRow = await db
    .select({ hiredAt: agents.hiredAt })
    .from(agents)
    .where(eq(agents.id, agentId))
    .then((rows) => rows[0] ?? null);

  const hiredAt = agentRow?.hiredAt ? new Date(agentRow.hiredAt) : null;

  const completedIssues = await db
    .select({ completedAt: issues.completedAt })
    .from(issues)
    .where(
      and(
        eq(issues.assigneeAgentId, agentId),
        eq(issues.status, "done"),
        sql`${issues.completedAt} is not null`,
      ),
    )
    .orderBy(asc(issues.completedAt));

  const firstIssueCompletedAt =
    completedIssues.length > 0 && completedIssues[0]?.completedAt
      ? new Date(completedIssues[0].completedAt)
      : null;

  let rampTimeDays: number | null = null;
  if (hiredAt && firstIssueCompletedAt) {
    const diffMs = firstIssueCompletedAt.getTime() - hiredAt.getTime();
    rampTimeDays = Math.max(0, Math.round(diffMs / (1000 * 60 * 60 * 24)));
  }

  let firstWeekIssues = 0;
  if (hiredAt) {
    const oneWeekAfterHire = new Date(hiredAt.getTime() + 7 * 24 * 60 * 60 * 1000);
    firstWeekIssues = completedIssues.filter((i) => {
      if (!i.completedAt) return false;
      const d = new Date(i.completedAt);
      return d >= hiredAt && d <= oneWeekAfterHire;
    }).length;
  }

  return { hiredAt, firstIssueCompletedAt, rampTimeDays, firstWeekIssues };
}

/**
 * Capture a weekly performance snapshot for all agents in a company.
 *
 * Stores each agent's current performance_score as a semantic memory entry
 * with category "performance_snapshot". Intended to run alongside weekly reports.
 */
export async function capturePerformanceSnapshot(
  db: Db,
  companyId: string,
): Promise<void> {
  const companyAgents = await db
    .select({
      id: agents.id,
      performanceScore: agents.performanceScore,
    })
    .from(agents)
    .where(
      and(
        eq(agents.companyId, companyId),
        ne(agents.status, "terminated"),
      ),
    );

  const now = new Date();
  const dateStr = now.toISOString().slice(0, 10);

  for (const agent of companyAgents) {
    const snapshotData = JSON.stringify({
      agentId: agent.id,
      score: agent.performanceScore ?? 0,
      date: dateStr,
    });

    await db.insert(agentMemoryEntries).values({
      agentId: agent.id,
      companyId,
      memoryType: "semantic",
      category: "performance_snapshot",
      content: snapshotData,
      confidence: 100,
      lastAccessedAt: now,
    });
  }

  logger.info(
    { companyId, agentsSnapshotted: companyAgents.length },
    "captured performance snapshots for company agents",
  );
}

/**
 * Capture performance snapshots for ALL companies.
 */
export async function captureAllPerformanceSnapshots(db: Db): Promise<void> {
  const allCompanies = await db
    .select({ id: companies.id })
    .from(companies)
    .where(ne(companies.status, "pending_erasure"));

  for (const company of allCompanies) {
    try {
      await capturePerformanceSnapshot(db, company.id);
    } catch (err) {
      logger.error({ err, companyId: company.id }, "failed to capture performance snapshots for company");
    }
  }

  logger.info({ companiesProcessed: allCompanies.length }, "performance snapshots capture complete");
}
