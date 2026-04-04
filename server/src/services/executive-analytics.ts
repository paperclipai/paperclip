import { and, desc, eq, gte, inArray, isNotNull, lt, ne, sql } from "drizzle-orm";
import type { Db } from "@ironworksai/db";
import { agents, companies, costEvents, goals, heartbeatRuns, issues, projects } from "@ironworksai/db";
import { SLA_TARGETS } from "@ironworksai/shared";
import type { IssuePriority, RiskLevel } from "@ironworksai/shared";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function currentUtcMonthWindow(now = new Date()) {
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  return {
    start: new Date(Date.UTC(year, month, 1, 0, 0, 0, 0)),
    end: new Date(Date.UTC(year, month + 1, 1, 0, 0, 0, 0)),
  };
}

function priorMonthWindow(now = new Date()) {
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  const priorStart = new Date(Date.UTC(year, month - 1, 1, 0, 0, 0, 0));
  const priorEnd = new Date(Date.UTC(year, month, 1, 0, 0, 0, 0));
  return { start: priorStart, end: priorEnd };
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export function executiveAnalyticsService(db: Db) {
  return {
    /**
     * Unit economics: cost per completed issue and cost per active heartbeat hour.
     * Includes prior-period comparison for trend.
     */
    unitEconomics: async (companyId: string) => {
      const now = new Date();
      const current = currentUtcMonthWindow(now);
      const prior = priorMonthWindow(now);

      async function periodMetrics(start: Date, end: Date) {
        const [spendRow] = await db
          .select({
            totalCents: sql<number>`coalesce(sum(${costEvents.costCents}), 0)::int`,
          })
          .from(costEvents)
          .where(
            and(
              eq(costEvents.companyId, companyId),
              gte(costEvents.occurredAt, start),
              lt(costEvents.occurredAt, end),
            ),
          );

        const [issuesDone] = await db
          .select({ count: sql<number>`count(*)::int` })
          .from(issues)
          .where(
            and(
              eq(issues.companyId, companyId),
              eq(issues.status, "done"),
              isNotNull(issues.completedAt),
              gte(issues.completedAt, start),
              lt(issues.completedAt, end),
            ),
          );

        const [runHoursRow] = await db
          .select({
            totalMinutes: sql<number>`coalesce(sum(extract(epoch from (${heartbeatRuns.finishedAt} - ${heartbeatRuns.startedAt})) / 60.0), 0)::int`,
          })
          .from(heartbeatRuns)
          .where(
            and(
              eq(heartbeatRuns.companyId, companyId),
              isNotNull(heartbeatRuns.finishedAt),
              gte(heartbeatRuns.startedAt, start),
              lt(heartbeatRuns.startedAt, end),
            ),
          );

        const totalCents = Number(spendRow?.totalCents ?? 0);
        const doneCount = Number(issuesDone?.count ?? 0);
        const activeMinutes = Number(runHoursRow?.totalMinutes ?? 0);
        const activeHours = activeMinutes / 60;

        return {
          totalCents,
          issuesDone: doneCount,
          activeHours: Math.round(activeHours * 100) / 100,
          costPerIssue: doneCount > 0 ? Math.round(totalCents / doneCount) : 0,
          costPerActiveHour: activeHours > 0 ? Math.round(totalCents / activeHours) : 0,
        };
      }

      const currentMetrics = await periodMetrics(current.start, current.end);
      const priorMetrics = await periodMetrics(prior.start, prior.end);

      return {
        current: currentMetrics,
        prior: priorMetrics,
        costPerIssueTrend: currentMetrics.costPerIssue - priorMetrics.costPerIssue,
        costPerHourTrend: currentMetrics.costPerActiveHour - priorMetrics.costPerActiveHour,
      };
    },

    /**
     * Burn rate: extrapolate current month spend from last 7 days.
     * Runway: if a budget is set, how many days/months until exhausted.
     */
    burnRate: async (companyId: string) => {
      const now = new Date();
      const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

      const [weekSpendRow] = await db
        .select({
          totalCents: sql<number>`coalesce(sum(${costEvents.costCents}), 0)::int`,
        })
        .from(costEvents)
        .where(
          and(
            eq(costEvents.companyId, companyId),
            gte(costEvents.occurredAt, sevenDaysAgo),
          ),
        );

      const weekSpendCents = Number(weekSpendRow?.totalCents ?? 0);
      const dailyRate = weekSpendCents / 7;
      const monthlyRate = Math.round(dailyRate * 30.44);

      const company = await db
        .select({
          budgetMonthlyCents: companies.budgetMonthlyCents,
          spentMonthlyCents: companies.spentMonthlyCents,
        })
        .from(companies)
        .where(eq(companies.id, companyId))
        .then((rows) => rows[0] ?? null);

      const budgetCents = company?.budgetMonthlyCents ?? 0;
      const spentCents = company?.spentMonthlyCents ?? 0;
      const remainingCents = Math.max(0, budgetCents - spentCents);

      let runwayDays: number | null = null;
      let runwayMonths: number | null = null;

      if (budgetCents > 0 && dailyRate > 0) {
        runwayDays = Math.round(remainingCents / dailyRate);
        runwayMonths = Math.round((runwayDays / 30.44) * 10) / 10;
      }

      return {
        weekSpendCents,
        dailyRateCents: Math.round(dailyRate),
        monthlyRateCents: monthlyRate,
        budgetCents,
        spentCents,
        remainingCents,
        runwayDays,
        runwayMonths,
      };
    },

    /**
     * Cost allocation by project with issue count and cost per issue.
     */
    costAllocation: async (companyId: string) => {
      const current = currentUtcMonthWindow();

      const rows = await db
        .select({
          projectId: issues.projectId,
          projectName: projects.name,
          costCents: sql<number>`coalesce(sum(${costEvents.costCents}), 0)::int`,
          issueCount: sql<number>`count(distinct ${issues.id})::int`,
        })
        .from(costEvents)
        .innerJoin(issues, and(
          eq(costEvents.companyId, issues.companyId),
          sql`${costEvents.agentId} = ${issues.assigneeAgentId}`,
        ))
        .innerJoin(projects, eq(issues.projectId, projects.id))
        .where(
          and(
            eq(costEvents.companyId, companyId),
            isNotNull(issues.projectId),
            gte(costEvents.occurredAt, current.start),
            lt(costEvents.occurredAt, current.end),
          ),
        )
        .groupBy(issues.projectId, projects.name)
        .orderBy(desc(sql`coalesce(sum(${costEvents.costCents}), 0)::int`));

      return rows.map((row) => ({
        projectId: row.projectId,
        projectName: row.projectName,
        costCents: Number(row.costCents),
        issueCount: Number(row.issueCount),
        costPerIssue: Number(row.issueCount) > 0
          ? Math.round(Number(row.costCents) / Number(row.issueCount))
          : 0,
      }));
    },

    /**
     * SLA compliance: percentage of completed issues resolved within SLA.
     */
    slaCompliance: async (companyId: string) => {
      const completedIssues = await db
        .select({
          id: issues.id,
          priority: issues.priority,
          createdAt: issues.createdAt,
          completedAt: issues.completedAt,
        })
        .from(issues)
        .where(
          and(
            eq(issues.companyId, companyId),
            eq(issues.status, "done"),
            isNotNull(issues.completedAt),
          ),
        );

      let total = 0;
      let withinSla = 0;
      const byPriority: Record<string, { total: number; met: number; avgMinutes: number; sumMinutes: number }> = {};

      for (const issue of completedIssues) {
        if (!issue.completedAt) continue;
        const priority = issue.priority as IssuePriority;
        const target = SLA_TARGETS[priority as keyof typeof SLA_TARGETS];
        if (target == null) continue;

        const resolutionMinutes =
          (new Date(issue.completedAt).getTime() - new Date(issue.createdAt).getTime()) / (1000 * 60);

        total += 1;
        const met = resolutionMinutes <= target;
        if (met) withinSla += 1;

        if (!byPriority[priority]) {
          byPriority[priority] = { total: 0, met: 0, avgMinutes: 0, sumMinutes: 0 };
        }
        byPriority[priority].total += 1;
        if (met) byPriority[priority].met += 1;
        byPriority[priority].sumMinutes += resolutionMinutes;
      }

      // Compute averages
      for (const p of Object.keys(byPriority)) {
        const entry = byPriority[p];
        entry.avgMinutes = entry.total > 0 ? Math.round(entry.sumMinutes / entry.total) : 0;
      }

      return {
        total,
        withinSla,
        compliancePercent: total > 0 ? Math.round((withinSla / total) * 100) : 100,
        byPriority: Object.entries(byPriority).map(([priority, data]) => ({
          priority,
          total: data.total,
          met: data.met,
          compliancePercent: data.total > 0 ? Math.round((data.met / data.total) * 100) : 100,
          avgResolutionMinutes: data.avgMinutes,
          targetMinutes: SLA_TARGETS[priority as keyof typeof SLA_TARGETS] ?? 0,
        })),
      };
    },

    /**
     * Tech debt: count of issues matching tech debt patterns.
     */
    techDebtCount: async (companyId: string) => {
      const now = new Date();
      const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
      const sixtyDaysAgo = new Date(now.getTime() - 60 * 24 * 60 * 60 * 1000);

      async function countDebt(since: Date, until: Date) {
        const [row] = await db
          .select({ count: sql<number>`count(*)::int` })
          .from(issues)
          .where(
            and(
              eq(issues.companyId, companyId),
              ne(issues.status, "cancelled"),
              sql`(
                lower(${issues.title}) like '%tech debt%'
                or lower(${issues.title}) like '%technical debt%'
                or lower(${issues.title}) like '%refactor%'
                or lower(coalesce(${issues.description}, '')) like '%tech debt%'
                or lower(coalesce(${issues.description}, '')) like '%technical debt%'
              )`,
              gte(issues.createdAt, since),
              lt(issues.createdAt, until),
            ),
          );
        return Number(row?.count ?? 0);
      }

      const currentCount = await countDebt(thirtyDaysAgo, now);
      const priorCount = await countDebt(sixtyDaysAgo, thirtyDaysAgo);

      // Also get total open tech debt
      const [openRow] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(issues)
        .where(
          and(
            eq(issues.companyId, companyId),
            inArray(issues.status, ["backlog", "todo", "in_progress", "in_review", "blocked"]),
            sql`(
              lower(${issues.title}) like '%tech debt%'
              or lower(${issues.title}) like '%technical debt%'
              or lower(${issues.title}) like '%refactor%'
              or lower(coalesce(${issues.description}, '')) like '%tech debt%'
              or lower(coalesce(${issues.description}, '')) like '%technical debt%'
            )`,
          ),
        );

      return {
        openCount: Number(openRow?.count ?? 0),
        createdLast30d: currentCount,
        createdPrior30d: priorCount,
        trend: currentCount - priorCount,
      };
    },

    /**
     * Risk register: identifies high-risk items.
     */
    riskRegister: async (companyId: string) => {
      const now = new Date();
      const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

      // Critical/high priority open issues that are overdue by SLA
      const overdueIssues = await db
        .select({
          id: issues.id,
          title: issues.title,
          priority: issues.priority,
          status: issues.status,
          createdAt: issues.createdAt,
          assigneeAgentId: issues.assigneeAgentId,
        })
        .from(issues)
        .where(
          and(
            eq(issues.companyId, companyId),
            inArray(issues.priority, ["critical", "high"]),
            inArray(issues.status, ["backlog", "todo", "in_progress", "in_review", "blocked"]),
          ),
        );

      // Issues open > 7 days with no progress (still in backlog or todo)
      const staleIssues = await db
        .select({
          id: issues.id,
          title: issues.title,
          priority: issues.priority,
          createdAt: issues.createdAt,
        })
        .from(issues)
        .where(
          and(
            eq(issues.companyId, companyId),
            inArray(issues.status, ["backlog", "todo"]),
            lt(issues.createdAt, sevenDaysAgo),
          ),
        );

      // Agents with low performance score
      const lowPerfAgents = await db
        .select({
          id: agents.id,
          name: agents.name,
          performanceScore: agents.performanceScore,
        })
        .from(agents)
        .where(
          and(
            eq(agents.companyId, companyId),
            ne(agents.status, "terminated"),
            isNotNull(agents.performanceScore),
            lt(agents.performanceScore, 40),
          ),
        );

      // Classify risks
      const risks: Array<{
        level: RiskLevel;
        category: string;
        title: string;
        entityType: string;
        entityId: string;
        detail: string;
      }> = [];

      for (const issue of overdueIssues) {
        const priority = issue.priority as IssuePriority;
        const targetMinutes = SLA_TARGETS[priority as keyof typeof SLA_TARGETS];
        if (!targetMinutes) continue;
        const ageMinutes = (now.getTime() - new Date(issue.createdAt).getTime()) / (1000 * 60);
        if (ageMinutes > targetMinutes) {
          risks.push({
            level: priority === "critical" ? "critical" : "high",
            category: "overdue_issue",
            title: issue.title,
            entityType: "issue",
            entityId: issue.id,
            detail: `Open ${priority} issue overdue by ${Math.round((ageMinutes - targetMinutes) / 60)}h`,
          });
        }
      }

      for (const issue of staleIssues) {
        const ageDays = Math.round(
          (now.getTime() - new Date(issue.createdAt).getTime()) / (1000 * 60 * 60 * 24),
        );
        risks.push({
          level: "medium",
          category: "stale_issue",
          title: issue.title,
          entityType: "issue",
          entityId: issue.id,
          detail: `No progress for ${ageDays} days`,
        });
      }

      for (const agent of lowPerfAgents) {
        risks.push({
          level: (agent.performanceScore ?? 0) < 20 ? "high" : "medium",
          category: "low_performance",
          title: agent.name,
          entityType: "agent",
          entityId: agent.id,
          detail: `Performance score: ${agent.performanceScore}`,
        });
      }

      // Sort by severity
      const levelOrder: Record<RiskLevel, number> = { critical: 0, high: 1, medium: 2, low: 3 };
      risks.sort((a, b) => levelOrder[a.level] - levelOrder[b.level]);

      const countByLevel: Record<RiskLevel, number> = { critical: 0, high: 0, medium: 0, low: 0 };
      for (const r of risks) countByLevel[r.level] += 1;

      return {
        totalRisks: risks.length,
        countByLevel,
        risks: risks.slice(0, 25), // Cap at 25 items
      };
    },

    /**
     * Circuit breaker check: returns whether an agent's recent runs show anomalous token usage.
     */
    checkCostAnomaly: async (agentId: string) => {
      const recentRuns = await db
        .select({
          id: heartbeatRuns.id,
          usageJson: heartbeatRuns.usageJson,
        })
        .from(heartbeatRuns)
        .where(
          and(
            eq(heartbeatRuns.agentId, agentId),
            inArray(heartbeatRuns.status, ["succeeded", "failed"]),
            isNotNull(heartbeatRuns.usageJson),
          ),
        )
        .orderBy(desc(heartbeatRuns.createdAt))
        .limit(10);

      if (recentRuns.length < 5) return { anomaly: false, reason: "insufficient_data" };

      // Look at last 5 runs
      const last5 = recentRuns.slice(0, 5);

      // Compute token usage for last 5 and the historical average from runs 5-10
      function extractTokens(usageJson: unknown): number {
        if (!usageJson || typeof usageJson !== "object") return 0;
        const usage = usageJson as Record<string, unknown>;
        const input = Number(usage.inputTokens ?? usage.input_tokens ?? 0);
        const output = Number(usage.outputTokens ?? usage.output_tokens ?? 0);
        return input + output;
      }

      const recent5Tokens = last5.map((r) => extractTokens(r.usageJson));
      const older = recentRuns.slice(5);

      if (older.length === 0) {
        // No baseline available, cannot determine anomaly
        return { anomaly: false, reason: "no_baseline" };
      }

      const olderTokens = older.map((r) => extractTokens(r.usageJson));
      const avgOlder = olderTokens.reduce((s, t) => s + t, 0) / olderTokens.length;

      if (avgOlder <= 0) return { anomaly: false, reason: "zero_baseline" };

      // Check if ALL of the last 5 exceed 3x the baseline
      const allExceed = recent5Tokens.every((t) => t > avgOlder * 3);

      return {
        anomaly: allExceed,
        reason: allExceed ? "all_recent_runs_exceed_3x_baseline" : "within_normal_range",
        recentAvgTokens: Math.round(recent5Tokens.reduce((s, t) => s + t, 0) / recent5Tokens.length),
        baselineAvgTokens: Math.round(avgOlder),
      };
    },

    /**
     * Composite company health score (0-100) with breakdown by category.
     */
    companyHealthScore: async (companyId: string): Promise<{
      score: number;
      breakdown: {
        agentPerformance: number;
        goalCompletion: number;
        budgetHealth: number;
        slaCompliance: number;
        riskLevel: number;
      };
    }> => {
      // 1. Agent performance: average performance_score (0-100)
      const perfResult = await db
        .select({
          avg: sql<number>`coalesce(avg(${agents.performanceScore}), 0)::int`,
        })
        .from(agents)
        .where(
          and(
            eq(agents.companyId, companyId),
            ne(agents.status, "terminated"),
            isNotNull(agents.performanceScore),
          ),
        );
      const agentPerformance = Math.min(100, Math.max(0, Number(perfResult[0]?.avg ?? 0)));

      // 2. Goal completion: % of goals that are active/completed vs total
      const goalCounts = await db
        .select({
          total: sql<number>`count(*)::int`,
          onTrack: sql<number>`count(*) filter (where ${goals.status} in ('active', 'completed'))::int`,
        })
        .from(goals)
        .where(eq(goals.companyId, companyId));
      const totalGoals = Number(goalCounts[0]?.total ?? 0);
      const onTrackGoals = Number(goalCounts[0]?.onTrack ?? 0);
      const goalCompletion = totalGoals > 0
        ? Math.round((onTrackGoals / totalGoals) * 100)
        : 100; // No goals = full score (not penalized)

      // 3. Budget health: under budget = 100, over budget scales down
      const [companyRow] = await db
        .select({
          budgetMonthlyCents: companies.budgetMonthlyCents,
          spentMonthlyCents: companies.spentMonthlyCents,
        })
        .from(companies)
        .where(eq(companies.id, companyId))
        .limit(1);

      let budgetHealth = 100;
      if (companyRow && companyRow.budgetMonthlyCents > 0) {
        const ratio = companyRow.spentMonthlyCents / companyRow.budgetMonthlyCents;
        if (ratio <= 1) {
          budgetHealth = 100;
        } else {
          // Scale down: at 150% of budget = 50, at 200% = 0
          budgetHealth = Math.max(0, Math.round(100 - (ratio - 1) * 100));
        }
      }

      // 4. SLA compliance (reuse existing method)
      const slaResult = await db
        .select({
          id: issues.id,
          priority: issues.priority,
          createdAt: issues.createdAt,
          completedAt: issues.completedAt,
        })
        .from(issues)
        .where(
          and(
            eq(issues.companyId, companyId),
            eq(issues.status, "done"),
            isNotNull(issues.completedAt),
          ),
        );

      let slaTotal = 0;
      let slaWithin = 0;
      for (const issue of slaResult) {
        if (!issue.completedAt) continue;
        const priority = issue.priority as IssuePriority;
        const target = SLA_TARGETS[priority as keyof typeof SLA_TARGETS];
        if (target == null) continue;
        const resolutionMinutes =
          (new Date(issue.completedAt).getTime() - new Date(issue.createdAt).getTime()) / (1000 * 60);
        slaTotal += 1;
        if (resolutionMinutes <= target) slaWithin += 1;
      }
      const slaCompliance = slaTotal > 0 ? Math.round((slaWithin / slaTotal) * 100) : 100;

      // 5. Risk level: inverse of open risk count
      const now = new Date();
      const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

      const [critHighCount] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(issues)
        .where(
          and(
            eq(issues.companyId, companyId),
            inArray(issues.priority, ["critical", "high"]),
            inArray(issues.status, ["backlog", "todo", "in_progress", "in_review", "blocked"]),
          ),
        );

      const [staleCount] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(issues)
        .where(
          and(
            eq(issues.companyId, companyId),
            inArray(issues.status, ["backlog", "todo"]),
            lt(issues.createdAt, sevenDaysAgo),
          ),
        );

      const [lowPerfCount] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(agents)
        .where(
          and(
            eq(agents.companyId, companyId),
            ne(agents.status, "terminated"),
            isNotNull(agents.performanceScore),
            lt(agents.performanceScore, 40),
          ),
        );

      const totalRisks =
        Number(critHighCount?.count ?? 0) +
        Math.ceil(Number(staleCount?.count ?? 0) / 2) + // Stale items count less
        Number(lowPerfCount?.count ?? 0) * 2; // Low perf agents count double

      // Map risk count to a 0-100 score: 0 risks = 100, 10+ risks = 0
      const riskLevel = Math.max(0, Math.min(100, 100 - totalRisks * 10));

      // Composite score: weighted average
      const weights = {
        agentPerformance: 0.25,
        goalCompletion: 0.20,
        budgetHealth: 0.20,
        slaCompliance: 0.20,
        riskLevel: 0.15,
      };

      const score = Math.round(
        agentPerformance * weights.agentPerformance +
        goalCompletion * weights.goalCompletion +
        budgetHealth * weights.budgetHealth +
        slaCompliance * weights.slaCompliance +
        riskLevel * weights.riskLevel,
      );

      return {
        score: Math.min(100, Math.max(0, score)),
        breakdown: {
          agentPerformance,
          goalCompletion,
          budgetHealth,
          slaCompliance,
          riskLevel,
        },
      };
    },
  };
}
