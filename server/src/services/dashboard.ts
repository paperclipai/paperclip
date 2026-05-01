import { and, desc, eq, gte, isNull, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, approvals, companies, costEvents, heartbeatRuns, issues } from "@paperclipai/db";
import { notFound } from "../errors.js";
import { budgetService } from "./budgets.js";

const DASHBOARD_RUN_ACTIVITY_DAYS = 14;
const DASHBOARD_ISSUE_ACTIVITY_DAYS = 14;
// Top N most-recently-updated issues. Drives the Recent Issues panel (renders
// the first 10) AND the activity-feed entityName/entityTitle lookup map
// (covers issues referenced by the 10 latest activity events). 50 is generous
// for the lookup case while staying under ~30 KB on the wire.
const DASHBOARD_RECENT_ISSUE_LIMIT = 50;

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

      // ----- Issue creation activity (14d, by priority + status) ----
      // Replaces the Dashboard's previous practice of fetching the full
      // company-scoped issue list (~1.28 MB on a busy company) just to bin
      // issues by createdAt-day client-side. With ~2k issues across 14 days,
      // each GROUP BY runs in a few ms against the (company_id, created_at)
      // index.
      const issueActivityDays = getRecentUtcDateKeys(now, DASHBOARD_ISSUE_ACTIVITY_DAYS);
      const issueActivityStart = new Date(`${issueActivityDays[0]}T00:00:00.000Z`);
      const issueDayExpr = sql<string>`to_char(${issues.createdAt} at time zone 'UTC', 'YYYY-MM-DD')`;

      const [issuePriorityRows, issueStatusRows, recentIssuesRows] = await Promise.all([
        db
          .select({
            date: issueDayExpr,
            priority: issues.priority,
            count: sql<number>`count(*)::int`,
          })
          .from(issues)
          .where(and(
            eq(issues.companyId, companyId),
            gte(issues.createdAt, issueActivityStart),
            isNull(issues.hiddenAt),
          ))
          .groupBy(issueDayExpr, issues.priority),
        db
          .select({
            date: issueDayExpr,
            status: issues.status,
            count: sql<number>`count(*)::int`,
          })
          .from(issues)
          .where(and(
            eq(issues.companyId, companyId),
            gte(issues.createdAt, issueActivityStart),
            isNull(issues.hiddenAt),
          ))
          .groupBy(issueDayExpr, issues.status),
        db
          .select({
            id: issues.id,
            identifier: issues.identifier,
            title: issues.title,
            status: issues.status,
            priority: issues.priority,
            projectId: issues.projectId,
            parentId: issues.parentId,
            assigneeAgentId: issues.assigneeAgentId,
            createdAt: issues.createdAt,
            updatedAt: issues.updatedAt,
            lastActivityAt: issues.lastActivityAt,
          })
          .from(issues)
          .where(and(eq(issues.companyId, companyId), isNull(issues.hiddenAt)))
          .orderBy(desc(issues.updatedAt))
          .limit(DASHBOARD_RECENT_ISSUE_LIMIT),
      ]);

      const issueActivity = issueActivityDays.map((date) => ({
        date,
        total: 0,
        byPriority: {} as Record<string, number>,
        byStatus: {} as Record<string, number>,
      }));
      const issueActivityByDate = new Map(issueActivity.map((day) => [day.date, day]));
      for (const row of issuePriorityRows) {
        const bucket = issueActivityByDate.get(row.date);
        if (!bucket) continue;
        const count = Number(row.count);
        bucket.byPriority[row.priority] = (bucket.byPriority[row.priority] ?? 0) + count;
        bucket.total += count;
      }
      for (const row of issueStatusRows) {
        const bucket = issueActivityByDate.get(row.date);
        if (!bucket) continue;
        bucket.byStatus[row.status] = (bucket.byStatus[row.status] ?? 0) + Number(row.count);
        // Note: don't also add to total here — issuePriorityRows already
        // counted every issue in this window. byStatus is a parallel
        // breakdown of the same issue set on the same day.
      }

      const utilization =
        company.budgetMonthlyCents > 0
          ? (monthSpendCents / company.budgetMonthlyCents) * 100
          : 0;
      const budgetOverview = await budgets.overview(companyId);

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
        budgets: {
          activeIncidents: budgetOverview.activeIncidents.length,
          pendingApprovals: budgetOverview.pendingApprovalCount,
          pausedAgents: budgetOverview.pausedAgentCount,
          pausedProjects: budgetOverview.pausedProjectCount,
        },
        runActivity: Array.from(runActivity.values()),
        issueActivity,
        recentIssues: recentIssuesRows,
      };
    },
  };
}
