import { and, desc, eq, gte, isNull, or, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, approvals, companies, costEvents, heartbeatRuns, issues } from "@paperclipai/db";
import {
  ISSUE_PRIORITIES,
  ISSUE_STATUSES,
  type DashboardIssueActivityDay,
  type DashboardPartialError,
  type DashboardPartialErrorSource,
  type DashboardRecentIssue,
  type DashboardRunActivityDay,
} from "@paperclipai/shared";
import { notFound } from "../errors.js";
import { budgetService } from "./budgets.js";

const DASHBOARD_RUN_ACTIVITY_DAYS = 14;
const DASHBOARD_RECENT_ISSUE_LIMIT = 10;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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

function zeroRecord<T extends readonly string[]>(keys: T): Record<T[number], number> {
  return Object.fromEntries(keys.map((key) => [key, 0])) as Record<T[number], number>;
}

function newIssueActivityBucket(date: string): DashboardIssueActivityDay {
  return {
    date,
    byPriority: zeroRecord(ISSUE_PRIORITIES),
    byStatus: zeroRecord(ISSUE_STATUSES),
    total: 0,
  };
}

function dashboardErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) return error.message;
  return "Dashboard source query failed";
}

async function readDashboardSource<T>(
  partialErrors: DashboardPartialError[],
  source: DashboardPartialErrorSource,
  fallback: T,
  load: () => Promise<T>,
): Promise<T> {
  try {
    return await load();
  } catch (error) {
    partialErrors.push({ source, message: dashboardErrorMessage(error) });
    return fallback;
  }
}

export function dashboardService(db: Db) {
  const budgets = budgetService(db);
  return {
    resolveCompanyReference: async (companyRef: string) => {
      const normalizedRef = companyRef.trim();
      const normalizedPrefix = normalizedRef.toUpperCase();
      const companyPredicate = UUID_RE.test(normalizedRef)
        ? or(eq(companies.id, normalizedRef), eq(companies.issuePrefix, normalizedPrefix))
        : eq(companies.issuePrefix, normalizedPrefix);

      return db
        .select()
        .from(companies)
        .where(companyPredicate)
        .then((rows) => rows[0] ?? null);
    },

    summary: async (companyRef: string) => {
      const company = await db
        .select()
        .from(companies)
        .where(UUID_RE.test(companyRef) ? eq(companies.id, companyRef) : eq(companies.issuePrefix, companyRef.trim().toUpperCase()))
        .then((rows) => rows[0] ?? null);

      if (!company) throw notFound("Company not found");

      const companyId = company.id;
      const generatedAt = new Date();
      const partialErrors: DashboardPartialError[] = [];
      const agentCounts: Record<string, number> = {
        active: 0,
        running: 0,
        paused: 0,
        error: 0,
      };
      const taskCounts: Record<string, number> = {
        open: 0,
        inProgress: 0,
        blocked: 0,
        done: 0,
      };
      const now = generatedAt;
      const monthStart = getUtcMonthStart(now);
      const activityDays = getRecentUtcDateKeys(now, DASHBOARD_RUN_ACTIVITY_DAYS);
      const activityStart = new Date(`${activityDays[0]}T00:00:00.000Z`);

      const agentRows = await readDashboardSource(partialErrors, "agents", [], () =>
        db
          .select({ status: agents.status, count: sql<number>`count(*)` })
          .from(agents)
          .where(eq(agents.companyId, companyId))
          .groupBy(agents.status),
      );

      for (const row of agentRows) {
        const count = Number(row.count);
        // "idle" agents are operational — count them as active
        const bucket = row.status === "idle" ? "active" : row.status;
        agentCounts[bucket] = (agentCounts[bucket] ?? 0) + count;
      }

      const taskRows = await readDashboardSource(partialErrors, "tasks", [], () =>
        db
          .select({ status: issues.status, count: sql<number>`count(*)` })
          .from(issues)
          .where(and(eq(issues.companyId, companyId), isNull(issues.hiddenAt)))
          .groupBy(issues.status),
      );

      for (const row of taskRows) {
        const count = Number(row.count);
        if (row.status === "in_progress") taskCounts.inProgress += count;
        if (row.status === "blocked") taskCounts.blocked += count;
        if (row.status === "done") taskCounts.done += count;
        if (row.status !== "done" && row.status !== "cancelled") taskCounts.open += count;
      }

      const pendingApprovals = await readDashboardSource(partialErrors, "approvals", 0, () =>
        db
          .select({ count: sql<number>`count(*)` })
          .from(approvals)
          .where(and(eq(approvals.companyId, companyId), eq(approvals.status, "pending")))
          .then((rows) => Number(rows[0]?.count ?? 0)),
      );

      const monthSpendCents = await readDashboardSource(partialErrors, "costs", 0, async () => {
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
        return Number(monthSpend);
      });

      const runActivityDayExpr = sql<string>`to_char(${heartbeatRuns.createdAt} at time zone 'UTC', 'YYYY-MM-DD')`;
      const runActivityRows = await readDashboardSource(partialErrors, "runActivity", [], () =>
        db
          .select({
            date: runActivityDayExpr,
            status: heartbeatRuns.status,
            count: sql<number>`count(*)::double precision`,
          })
          .from(heartbeatRuns)
          .where(
            and(
              eq(heartbeatRuns.companyId, companyId),
              gte(heartbeatRuns.createdAt, activityStart),
            ),
          )
          .groupBy(runActivityDayExpr, heartbeatRuns.status),
      );

      const runActivity = new Map(
        activityDays.map((date) => [
          date,
          { date, succeeded: 0, failed: 0, other: 0, total: 0 } satisfies DashboardRunActivityDay,
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

      const issueActivityDayExpr = sql<string>`to_char(${issues.createdAt} at time zone 'UTC', 'YYYY-MM-DD')`;
      const issueActivityRows = await readDashboardSource(partialErrors, "issueActivity", [], () =>
        db
          .select({
            date: issueActivityDayExpr,
            priority: issues.priority,
            status: issues.status,
            count: sql<number>`count(*)::double precision`,
          })
          .from(issues)
          .where(
            and(
              eq(issues.companyId, companyId),
              isNull(issues.hiddenAt),
              gte(issues.createdAt, activityStart),
            ),
          )
          .groupBy(issueActivityDayExpr, issues.priority, issues.status),
      );

      const issueActivity = new Map(
        activityDays.map((date) => [date, newIssueActivityBucket(date)]),
      );

      for (const row of issueActivityRows) {
        const bucket = issueActivity.get(row.date);
        if (!bucket) continue;
        const count = Number(row.count);
        if (ISSUE_PRIORITIES.includes(row.priority as typeof ISSUE_PRIORITIES[number])) {
          bucket.byPriority[row.priority as typeof ISSUE_PRIORITIES[number]] += count;
        }
        if (ISSUE_STATUSES.includes(row.status as typeof ISSUE_STATUSES[number])) {
          bucket.byStatus[row.status as typeof ISSUE_STATUSES[number]] += count;
        }
        bucket.total += count;
      }

      const recentIssues = await readDashboardSource<DashboardRecentIssue[]>(partialErrors, "recentIssues", [], async () => {
        const rows = await db
          .select({
            id: issues.id,
            identifier: issues.identifier,
            title: issues.title,
            status: issues.status,
            priority: issues.priority,
            assigneeAgentId: issues.assigneeAgentId,
            assigneeUserId: issues.assigneeUserId,
            createdAt: issues.createdAt,
            updatedAt: issues.updatedAt,
          })
          .from(issues)
          .where(and(eq(issues.companyId, companyId), isNull(issues.hiddenAt)))
          .orderBy(desc(issues.updatedAt))
          .limit(DASHBOARD_RECENT_ISSUE_LIMIT);

        return rows.map((row) => ({
          id: row.id,
          identifier: row.identifier,
          title: row.title,
          status: row.status as DashboardRecentIssue["status"],
          priority: row.priority as DashboardRecentIssue["priority"],
          assigneeAgentId: row.assigneeAgentId,
          assigneeUserId: row.assigneeUserId,
          createdAt: row.createdAt.toISOString(),
          updatedAt: row.updatedAt.toISOString(),
        }));
      });

      const utilization =
        company.budgetMonthlyCents > 0
          ? (monthSpendCents / company.budgetMonthlyCents) * 100
          : 0;
      const budgetOverview = await readDashboardSource(partialErrors, "budgets", {
        companyId,
        policies: [],
        activeIncidents: [],
        pendingApprovalCount: 0,
        pausedAgentCount: 0,
        pausedProjectCount: 0,
      }, () => budgets.overview(companyId));

      return {
        companyId,
        generatedAt: generatedAt.toISOString(),
        sourceStatus: partialErrors.length > 0 ? "partial" as const : "complete" as const,
        partialErrors,
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
        issueActivity: Array.from(issueActivity.values()),
        recentIssues,
      };
    },
  };
}
