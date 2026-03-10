import { and, eq, gte, isNotNull, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, approvals, companies, costEvents, heartbeatRuns, issues } from "@paperclipai/db";
import { notFound } from "../errors.js";

export function dashboardService(db: Db) {
  return {
    summary: async (companyId: string) => {
      const company = await db
        .select()
        .from(companies)
        .where(eq(companies.id, companyId))
        .then((rows) => rows[0] ?? null);

      if (!company) throw notFound("Company not found");

      const agentRows = await db
        .select({ status: agents.status, count: sql<number>`count(*)` })
        .from(agents)
        .where(eq(agents.companyId, companyId))
        .groupBy(agents.status);

      const taskRows = await db
        .select({ status: issues.status, count: sql<number>`count(*)` })
        .from(issues)
        .where(eq(issues.companyId, companyId))
        .groupBy(issues.status);

      const pendingApprovals = await db
        .select({ count: sql<number>`count(*)` })
        .from(approvals)
        .where(and(eq(approvals.companyId, companyId), eq(approvals.status, "pending")))
        .then((rows) => Number(rows[0]?.count ?? 0));

      const staleCutoff = new Date(Date.now() - 60 * 60 * 1000);
      const staleTasks = await db
        .select({ count: sql<number>`count(*)` })
        .from(issues)
        .where(
          and(
            eq(issues.companyId, companyId),
            eq(issues.status, "in_progress"),
            sql`${issues.startedAt} < ${staleCutoff.toISOString()}`,
          ),
        )
        .then((rows) => Number(rows[0]?.count ?? 0));

      const agentCounts: Record<string, number> = {
        active: 0,
        running: 0,
        paused: 0,
        error: 0,
      };
      for (const row of agentRows) {
        const count = Number(row.count);
        // "idle" agents are operational — count them as active
        const bucket = row.status === "idle" ? "active" : row.status;
        agentCounts[bucket] = (agentCounts[bucket] ?? 0) + count;
      }

      const taskCounts: Record<string, number> = {
        open: 0,
        inProgress: 0,
        blocked: 0,
        done: 0,
      };
      for (const row of taskRows) {
        const count = Number(row.count);
        if (row.status === "in_progress") taskCounts.inProgress += count;
        if (row.status === "blocked") taskCounts.blocked += count;
        if (row.status === "done") taskCounts.done += count;
        if (row.status !== "done" && row.status !== "cancelled") taskCounts.open += count;
      }

      const now = new Date();
      const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
      const [{ monthSpend }] = await db
        .select({
          monthSpend: sql<number>`coalesce(sum(${costEvents.costCents}), 0)::int`,
        })
        .from(costEvents)
        .where(
          and(
            eq(costEvents.companyId, companyId),
            gte(costEvents.occurredAt, monthStart),
          ),
        );

      const monthSpendCents = Number(monthSpend);
      const utilization =
        company.budgetMonthlyCents > 0
          ? (monthSpendCents / company.budgetMonthlyCents) * 100
          : 0;

      // Phase 6: runtime health — last 7 days, this company only
      const healthSince = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
      const runRows = await db
        .select({
          invocationSource: heartbeatRuns.invocationSource,
          status: heartbeatRuns.status,
          stderrExcerpt: heartbeatRuns.stderrExcerpt,
          sessionIdBefore: heartbeatRuns.sessionIdBefore,
          inputTokens: sql<number>`COALESCE(
            (${heartbeatRuns.usageJson}->>'input_tokens')::int,
            (${heartbeatRuns.usageJson}->>'prompt_tokens')::int,
            0
          )`,
        })
        .from(heartbeatRuns)
        .where(
          and(
            eq(heartbeatRuns.companyId, companyId),
            gte(heartbeatRuns.createdAt, healthSince),
            isNotNull(heartbeatRuns.finishedAt),
          ),
        );

      const healthTotal = runRows.length;
      let runtimeHealth: { windowDays: number; totalRuns: number; timerWakeSkipPct: number | null; stderrNoisePct: number | null; sessionResumeRatePct: number | null; medianTimerInputTokens: number | null } | undefined;

      if (healthTotal > 0) {
        const timerRows = runRows.filter((r) => r.invocationSource === "timer");
        const skippedRows = runRows.filter((r) => r.status === "skipped");
        const succeededWithStderr = runRows.filter(
          (r) => r.status === "succeeded" && r.stderrExcerpt && r.stderrExcerpt.trim().length > 0,
        );
        const withSession = runRows.filter((r) => r.sessionIdBefore != null);

        const medianOf = (nums: number[]): number | null => {
          if (nums.length === 0) return null;
          const sorted = [...nums].sort((a, b) => a - b);
          const mid = Math.floor(sorted.length / 2);
          return sorted.length % 2 !== 0
            ? (sorted[mid] ?? null)
            : Math.round(((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2);
        };
        const timerTokens = timerRows.map((r) => Number(r.inputTokens ?? 0));

        runtimeHealth = {
          windowDays: 7,
          totalRuns: healthTotal,
          timerWakeSkipPct: timerRows.length > 0
            ? Math.round((skippedRows.length / timerRows.length) * 100)
            : null,
          stderrNoisePct: Math.round((succeededWithStderr.length / healthTotal) * 100),
          sessionResumeRatePct: Math.round((withSession.length / healthTotal) * 100),
          medianTimerInputTokens: medianOf(timerTokens),
        };
      }

      return {
        companyId,
        agents: {
          active: agentCounts.active,
          running: agentCounts.running,
          paused: agentCounts.paused,
          error: agentCounts.error,
        },
        tasks: taskCounts,
        costs: {
          monthSpendCents,
          monthBudgetCents: company.budgetMonthlyCents,
          monthUtilizationPercent: Number(utilization.toFixed(2)),
        },
        pendingApprovals,
        staleTasks,
        runtimeHealth,
      };
    },
  };
}
