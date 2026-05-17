import { and, eq, gte, lt, isNull, or, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, approvals, companies, costEvents, heartbeatRuns, issues } from "@paperclipai/db";
import { AGENT_DORMANT_THRESHOLD_MS, canonicalAgentStatus } from "@paperclipai/shared";
import { notFound } from "../errors.js";
import { budgetService } from "./budgets.js";

const DASHBOARD_RUN_ACTIVITY_DAYS = 14;

function formatUtcDateKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function getUtcMonthStart(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
}

function getRecentUtcDateKeys(now: Date, days: number): string[] {
  const todayUtc = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return Array.from({ length: days }, (_, index) => {
    const dayOffset = index - (days - 1);
    return formatUtcDateKey(new Date(todayUtc + dayOffset * 24 * 60 * 60 * 1000));
  });
}

export function dashboardService(db: Db) {
  const budgets = budgetService(db);
  return {
    summary: async (companyId: string) => {
      const company = await db
        .select()
        .from(companies)
        .where(eq(companies.id, companyId))
        .then((rows) => rows[0] ?? null);

      if (!company) throw notFound("Company not found");

      const agentRows = await db
        .select({
          status: agents.status,
          pauseOrigin: agents.pauseOrigin,
          count: sql<number>`count(*)`,
        })
        .from(agents)
        .where(eq(agents.companyId, companyId))
        .groupBy(agents.status, agents.pauseOrigin);

      const dormantCutoff = new Date(Date.now() - AGENT_DORMANT_THRESHOLD_MS);
      const dormantAgents = await db
        .select({ count: sql<number>`count(*)` })
        .from(agents)
        .where(
          and(
            eq(agents.companyId, companyId),
            // Orthogonal liveness flag: roster agents (not terminated /
            // pending) that have not heartbeated within the dormant window.
            sql`${agents.status} not in ('terminated', 'pending_approval')`,
            or(
              isNull(agents.lastHeartbeatAt),
              lt(agents.lastHeartbeatAt, dormantCutoff),
            ),
          ),
        )
        .then((rows) => Number(rows[0]?.count ?? 0));

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

      // Canonical run-state taxonomy buckets (ZERA-579 / ZERA-580). The five
      // mutually-exclusive operational states; `terminated` / `pending_approval`
      // are not operational and excluded from the roster invariant
      // (working + idle + paused + suspended + error == operational roster).
      const agentCounts = {
        working: 0,
        idle: 0,
        paused: 0,
        suspended: 0,
        error: 0,
      };
      for (const row of agentRows) {
        const count = Number(row.count);
        const status = canonicalAgentStatus(row.status);
        if (status === "working") agentCounts.working += count;
        else if (status === "error") agentCounts.error += count;
        else if (status === "paused") {
          // Operator-initiated → `paused`; platform safety halt → `suspended`.
          if (row.pauseOrigin === "platform") agentCounts.suspended += count;
          else agentCounts.paused += count;
        } else if (status === "idle" || status === "active") {
          // Legacy `active` was always an idle agent (the ZERA-579 mislabel).
          agentCounts.idle += count;
        }
        // terminated / pending_approval: intentionally not on the dashboard.
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
      const monthStart = getUtcMonthStart(now);
      const runActivityDays = getRecentUtcDateKeys(now, DASHBOARD_RUN_ACTIVITY_DAYS);
      const runActivityStart = new Date(`${runActivityDays[0]}T00:00:00.000Z`);
      const [{ monthSpend }] = await db
        .select({
          monthSpend: sql<number>`coalesce(sum(${costEvents.costCents}), 0)::double precision`,
        })
        .from(costEvents)
        .where(
          and(
            eq(costEvents.companyId, companyId),
            gte(costEvents.occurredAt, monthStart),
          ),
        );

      const monthSpendCents = Number(monthSpend);
      const runActivityDayExpr = sql<string>`to_char(${heartbeatRuns.createdAt} at time zone 'UTC', 'YYYY-MM-DD')`;
      const runActivityRows = await db
        .select({
          date: runActivityDayExpr,
          status: heartbeatRuns.status,
          count: sql<number>`count(*)::double precision`,
        })
        .from(heartbeatRuns)
        .where(
          and(
            eq(heartbeatRuns.companyId, companyId),
            gte(heartbeatRuns.createdAt, runActivityStart),
          ),
        )
        .groupBy(runActivityDayExpr, heartbeatRuns.status);

      const runActivity = new Map(
        runActivityDays.map((date) => [
          date,
          { date, succeeded: 0, failed: 0, other: 0, total: 0 },
        ]),
      );
      for (const row of runActivityRows) {
        const bucket = runActivity.get(row.date);
        if (!bucket) continue;
        const count = Number(row.count);
        if (row.status === "succeeded") bucket.succeeded += count;
        else if (row.status === "failed" || row.status === "timed_out") bucket.failed += count;
        else bucket.other += count;
        bucket.total += count;
      }

      const utilization =
        company.budgetMonthlyCents > 0
          ? (monthSpendCents / company.budgetMonthlyCents) * 100
          : 0;
      const budgetOverview = await budgets.overview(companyId);

      return {
        companyId,
        agents: {
          working: agentCounts.working,
          idle: agentCounts.idle,
          paused: agentCounts.paused,
          suspended: agentCounts.suspended,
          error: agentCounts.error,
          dormant: dormantAgents,
          // Deprecated one-release aliases — see DashboardSummary.agents.
          active: agentCounts.idle,
          running: agentCounts.working,
        },
        tasks: taskCounts,
        costs: {
          monthSpendCents,
          monthBudgetCents: company.budgetMonthlyCents,
          monthUtilizationPercent: Number(utilization.toFixed(2)),
        },
        pendingApprovals,
        budgets: {
          activeIncidents: budgetOverview.activeIncidents.length,
          pendingApprovals: budgetOverview.pendingApprovalCount,
          pausedAgents: budgetOverview.pausedAgentCount,
          pausedProjects: budgetOverview.pausedProjectCount,
        },
        runActivity: Array.from(runActivity.values()),
      };
    },
  };
}
