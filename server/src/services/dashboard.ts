import { and, desc, eq, gte, inArray, ne, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, approvals, companies, costEvents, heartbeatRuns, issues } from "@paperclipai/db";
import { notFound } from "../errors.js";
import { budgetService } from "./budgets.js";

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

      const staleCutoff = new Date(Date.now() - 60 * 60 * 1000);
      const staleTasks = await db
        .select({ count: sql<number>`count(*)` })
        .from(issues)
        .where(
          and(
            eq(issues.companyId, companyId),
            eq(issues.status, "in_progress"),
            // Include issues with NULL startedAt — those are stuck with no start time.
            sql`(${issues.startedAt} is null or ${issues.startedAt} < ${staleCutoff.toISOString()})`,
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
        staleTasks,
        budgets: {
          activeIncidents: budgetOverview.activeIncidents.length,
          pendingApprovals: budgetOverview.pendingApprovalCount,
          pausedAgents: budgetOverview.pausedAgentCount,
          pausedProjects: budgetOverview.pausedProjectCount,
        },
      };
    },

    runs: async (companyId: string) => {
      const rows = await db
        .select({
          id: heartbeatRuns.id,
          agentId: heartbeatRuns.agentId,
          agentName: agents.name,
          issueId: sql<string | null>`${heartbeatRuns.contextSnapshot} ->> 'issueId'`.as("issueId"),
          status: heartbeatRuns.status,
          invocationSource: heartbeatRuns.invocationSource,
          startedAt: heartbeatRuns.startedAt,
          finishedAt: heartbeatRuns.finishedAt,
          errorCode: heartbeatRuns.errorCode,
          usageJson: heartbeatRuns.usageJson,
          createdAt: heartbeatRuns.createdAt,
        })
        .from(heartbeatRuns)
        .leftJoin(agents, eq(heartbeatRuns.agentId, agents.id))
        .where(and(
          eq(heartbeatRuns.companyId, companyId),
          ne(heartbeatRuns.invocationSource, "checkout_upsert"),
        ))
        .orderBy(desc(heartbeatRuns.startedAt))
        .limit(50);

      const issueIds = [...new Set(rows.map((r) => r.issueId).filter(Boolean))] as string[];
      const issueMap = new Map<string, { title: string; identifier: string | null }>();
      if (issueIds.length > 0) {
        const issueRows = await db
          .select({ id: issues.id, title: issues.title, identifier: issues.identifier })
          .from(issues)
          .where(inArray(issues.id, issueIds));
        for (const row of issueRows) {
          issueMap.set(row.id, { title: row.title, identifier: row.identifier });
        }
      }

      return rows.map((r) => {
        const usage = r.usageJson as Record<string, unknown> | null;
        const rawInput = usage?.inputTokens ?? usage?.input_tokens;
        const rawOutput = usage?.outputTokens ?? usage?.output_tokens;
        const inputTokens = rawInput != null ? Number(rawInput) : null;
        const outputTokens = rawOutput != null ? Number(rawOutput) : null;
        const durationMs =
          r.startedAt && r.finishedAt
            ? new Date(r.finishedAt).getTime() - new Date(r.startedAt).getTime()
            : null;
        const issue = r.issueId ? issueMap.get(r.issueId) : null;

        return {
          id: r.id,
          agentId: r.agentId,
          agentName: r.agentName ?? "Unknown",
          issueId: r.issueId,
          issueTitle: issue?.title ?? null,
          issueIdentifier: issue?.identifier ?? null,
          status: r.status,
          invocationSource: r.invocationSource,
          startedAt: r.startedAt,
          finishedAt: r.finishedAt,
          durationMs,
          inputTokens,
          outputTokens,
          errorCode: r.errorCode,
          createdAt: r.createdAt,
        };
      });
    },

    runStats: async (companyId: string) => {
      const fourteenDaysAgo = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);

      const [stats] = await db
        .select({
          totalRuns: sql<number>`count(*)::int`,
          succeededRuns: sql<number>`count(*) filter (where ${heartbeatRuns.status} = 'succeeded')::int`,
          failedRuns: sql<number>`count(*) filter (where ${heartbeatRuns.status} = 'failed')::int`,
          avgDurationMs: sql<number | null>`avg(extract(epoch from (${heartbeatRuns.finishedAt} - ${heartbeatRuns.startedAt})) * 1000)::int`,
          avgInputTokens: sql<number | null>`avg(coalesce((${heartbeatRuns.usageJson} ->> 'inputTokens')::int, (${heartbeatRuns.usageJson} ->> 'input_tokens')::int))::int`,
          avgOutputTokens: sql<number | null>`avg(coalesce((${heartbeatRuns.usageJson} ->> 'outputTokens')::int, (${heartbeatRuns.usageJson} ->> 'output_tokens')::int))::int`,
        })
        .from(heartbeatRuns)
        .where(
          and(
            eq(heartbeatRuns.companyId, companyId),
            ne(heartbeatRuns.invocationSource, "checkout_upsert"),
            gte(heartbeatRuns.startedAt, fourteenDaysAgo),
          ),
        );

      const totalRuns = Number(stats.totalRuns);
      return {
        totalRuns,
        succeededRuns: Number(stats.succeededRuns),
        failedRuns: Number(stats.failedRuns),
        successRate: totalRuns > 0 ? Number(((Number(stats.succeededRuns) / totalRuns) * 100).toFixed(1)) : 0,
        avgDurationMs: stats.avgDurationMs ? Number(stats.avgDurationMs) : null,
        avgInputTokens: stats.avgInputTokens ? Number(stats.avgInputTokens) : null,
        avgOutputTokens: stats.avgOutputTokens ? Number(stats.avgOutputTokens) : null,
      };
    },
  };
}
