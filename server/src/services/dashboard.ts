import { and, eq, gte, isNotNull, lte, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, approvals, companies, costEvents, heartbeatRuns, issues } from "@paperclipai/db";
import type { DashboardTokenUsageRange } from "@paperclipai/shared";
import { notFound } from "../errors.js";
import { budgetService } from "./budgets.js";

const DASHBOARD_RUN_ACTIVITY_DAYS = 14;
const DASHBOARD_TOKEN_USAGE_DAILY_BUCKETS = 7;
const DASHBOARD_TOKEN_USAGE_WEEKLY_BUCKETS = 8;
const DASHBOARD_TOKEN_USAGE_MONTHLY_BUCKETS = 6;
const UTC_DAY_MS = 24 * 60 * 60 * 1000;

function formatUtcDateKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function pad2(value: number): string {
  return value.toString().padStart(2, "0");
}

function startOfUtcDay(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

function endOfUtcDay(date: Date): Date {
  const start = startOfUtcDay(date);
  return new Date(start.getTime() + UTC_DAY_MS - 1);
}

function addUtcDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * UTC_DAY_MS);
}

function startOfUtcWeek(date: Date): Date {
  const dayStart = startOfUtcDay(date);
  const dayOfWeek = dayStart.getUTCDay();
  const offset = dayOfWeek === 0 ? -6 : 1 - dayOfWeek;
  return addUtcDays(dayStart, offset);
}

function startOfUtcMonth(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
}

function addUtcMonths(date: Date, months: number): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + months, 1));
}

type TokenUsageBucketWindow = {
  key: string;
  label: string;
  startAt: Date;
  endAt: Date;
};

function buildTokenUsageBucketWindows(range: DashboardTokenUsageRange, now: Date): TokenUsageBucketWindow[] {
  const anchorDay = startOfUtcDay(now);
  const anchorDayEnd = endOfUtcDay(now);

  if (range === "daily") {
    const firstStart = addUtcDays(anchorDay, -(DASHBOARD_TOKEN_USAGE_DAILY_BUCKETS - 1));
    return Array.from({ length: DASHBOARD_TOKEN_USAGE_DAILY_BUCKETS }, (_, index) => {
      const startAt = addUtcDays(firstStart, index);
      const label = `${pad2(startAt.getUTCMonth() + 1)}/${pad2(startAt.getUTCDate())}`;
      return {
        key: formatUtcDateKey(startAt),
        label,
        startAt,
        endAt: endOfUtcDay(startAt),
      };
    });
  }

  if (range === "weekly") {
    const currentWeekStart = startOfUtcWeek(now);
    const firstStart = addUtcDays(currentWeekStart, -7 * (DASHBOARD_TOKEN_USAGE_WEEKLY_BUCKETS - 1));
    return Array.from({ length: DASHBOARD_TOKEN_USAGE_WEEKLY_BUCKETS }, (_, index) => {
      const startAt = addUtcDays(firstStart, index * 7);
      const rawEnd = endOfUtcDay(addUtcDays(startAt, 6));
      const endAt = rawEnd.getTime() > anchorDayEnd.getTime() ? anchorDayEnd : rawEnd;
      const label = `${pad2(startAt.getUTCMonth() + 1)}/${pad2(startAt.getUTCDate())}-${pad2(endAt.getUTCMonth() + 1)}/${pad2(endAt.getUTCDate())}`;
      return {
        key: formatUtcDateKey(startAt),
        label,
        startAt,
        endAt,
      };
    });
  }

  const currentMonthStart = startOfUtcMonth(now);
  const firstStart = addUtcMonths(currentMonthStart, -(DASHBOARD_TOKEN_USAGE_MONTHLY_BUCKETS - 1));
  return Array.from({ length: DASHBOARD_TOKEN_USAGE_MONTHLY_BUCKETS }, (_, index) => {
    const startAt = addUtcMonths(firstStart, index);
    const rawEnd = new Date(addUtcMonths(startAt, 1).getTime() - 1);
    const endAt = rawEnd.getTime() > anchorDayEnd.getTime() ? anchorDayEnd : rawEnd;
    const label = `${startAt.getUTCFullYear()}/${pad2(startAt.getUTCMonth() + 1)}`;
    return {
      key: formatUtcDateKey(startAt),
      label,
      startAt,
      endAt,
    };
  });
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
      };
    },

    tokenUsage: async (
      companyId: string,
      options: {
        range?: DashboardTokenUsageRange;
        agentId?: string | null;
        now?: Date;
      } = {},
    ) => {
      const company = await db
        .select()
        .from(companies)
        .where(eq(companies.id, companyId))
        .then((rows) => rows[0] ?? null);
      if (!company) throw notFound("Company not found");

      const range = options.range ?? "daily";
      const selectedAgentId = options.agentId ?? null;
      let selectedAgentName: string | null = null;

      if (selectedAgentId) {
        const selectedAgent = await db
          .select({ name: agents.name })
          .from(agents)
          .where(and(eq(agents.id, selectedAgentId), eq(agents.companyId, companyId)))
          .then((rows) => rows[0] ?? null);
        if (!selectedAgent) throw notFound("Agent not found");
        selectedAgentName = selectedAgent.name;
      }

      const now = options.now ?? new Date();
      const bucketWindows = buildTokenUsageBucketWindows(range, now);
      const windowStartAt = bucketWindows[0]!.startAt;
      const windowEndAt = bucketWindows[bucketWindows.length - 1]!.endAt;

      const bucketKeyExpr = range === "daily"
        ? sql<string>`to_char(${heartbeatRuns.createdAt} at time zone 'UTC', 'YYYY-MM-DD')`
        : range === "weekly"
          ? sql<string>`to_char(date_trunc('week', ${heartbeatRuns.createdAt} at time zone 'UTC'), 'YYYY-MM-DD')`
          : sql<string>`to_char(date_trunc('month', ${heartbeatRuns.createdAt} at time zone 'UTC'), 'YYYY-MM-DD')`;

      const inputTokensExpr = sql<number>`coalesce(
        (${heartbeatRuns.usageJson} ->> 'inputTokens')::double precision,
        (${heartbeatRuns.usageJson} ->> 'input_tokens')::double precision,
        0
      )`;
      const cachedInputTokensExpr = sql<number>`coalesce(
        (${heartbeatRuns.usageJson} ->> 'cachedInputTokens')::double precision,
        (${heartbeatRuns.usageJson} ->> 'cached_input_tokens')::double precision,
        (${heartbeatRuns.usageJson} ->> 'cache_read_input_tokens')::double precision,
        0
      )`;
      const outputTokensExpr = sql<number>`coalesce(
        (${heartbeatRuns.usageJson} ->> 'outputTokens')::double precision,
        (${heartbeatRuns.usageJson} ->> 'output_tokens')::double precision,
        0
      )`;

      const conditions = [
        eq(heartbeatRuns.companyId, companyId),
        gte(heartbeatRuns.createdAt, windowStartAt),
        lte(heartbeatRuns.createdAt, windowEndAt),
        isNotNull(heartbeatRuns.usageJson),
      ];
      if (selectedAgentId) conditions.push(eq(heartbeatRuns.agentId, selectedAgentId));

      const usageRows = await db
        .select({
          bucketKey: bucketKeyExpr,
          inputTokens: sql<number>`coalesce(sum(${inputTokensExpr}), 0)::double precision`,
          cachedInputTokens: sql<number>`coalesce(sum(${cachedInputTokensExpr}), 0)::double precision`,
          outputTokens: sql<number>`coalesce(sum(${outputTokensExpr}), 0)::double precision`,
          runCount: sql<number>`count(*)::double precision`,
        })
        .from(heartbeatRuns)
        .where(and(...conditions))
        .groupBy(bucketKeyExpr);

      const bucketByKey = new Map(
        bucketWindows.map((bucket) => [
          bucket.key,
          {
            key: bucket.key,
            label: bucket.label,
            startAt: bucket.startAt.toISOString(),
            endAt: bucket.endAt.toISOString(),
            inputTokens: 0,
            cachedInputTokens: 0,
            outputTokens: 0,
            totalTokens: 0,
            runCount: 0,
          },
        ]),
      );

      for (const row of usageRows) {
        const bucket = bucketByKey.get(row.bucketKey);
        if (!bucket) continue;
        bucket.inputTokens = Math.max(0, Math.round(Number(row.inputTokens ?? 0)));
        bucket.cachedInputTokens = Math.max(0, Math.round(Number(row.cachedInputTokens ?? 0)));
        bucket.outputTokens = Math.max(0, Math.round(Number(row.outputTokens ?? 0)));
        bucket.totalTokens = bucket.inputTokens + bucket.cachedInputTokens + bucket.outputTokens;
        bucket.runCount = Math.max(0, Math.round(Number(row.runCount ?? 0)));
      }

      const buckets = Array.from(bucketByKey.values());
      const totals = buckets.reduce(
        (acc, bucket) => ({
          inputTokens: acc.inputTokens + bucket.inputTokens,
          cachedInputTokens: acc.cachedInputTokens + bucket.cachedInputTokens,
          outputTokens: acc.outputTokens + bucket.outputTokens,
          totalTokens: acc.totalTokens + bucket.totalTokens,
          runCount: acc.runCount + bucket.runCount,
        }),
        { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, totalTokens: 0, runCount: 0 },
      );

      return {
        companyId,
        range,
        scope: {
          type: selectedAgentId ? "single_agent" : "all_agents",
          agentId: selectedAgentId,
          agentName: selectedAgentName,
          label: selectedAgentName ? selectedAgentName : "All agents",
        },
        timezone: "UTC" as const,
        windowStartAt: windowStartAt.toISOString(),
        windowEndAt: windowEndAt.toISOString(),
        generatedAt: now.toISOString(),
        totals,
        buckets,
      };
    },
  };
}
