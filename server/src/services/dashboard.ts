import { and, eq, gte, inArray, not, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, approvals, companies, costEvents, issues } from "@paperclipai/db";
import { notFound } from "../errors.js";
import { budgetService } from "./budgets.js";

const RUNNABLE_STATUSES = ["todo", "in_progress"];
const NON_RUNNABLE_STATUSES = ["backlog", "blocked"];

export function dashboardService(db: Db) {
  const budgets = budgetService(db);

  async function detectQueueStarvation(companyId: string) {
    // Find all non-terminated agents in the company
    const activeAgents = await db
      .select({ id: agents.id, name: agents.name })
      .from(agents)
      .where(
        and(
          eq(agents.companyId, companyId),
          not(eq(agents.status, "terminated")),
        ),
      );

    if (activeAgents.length === 0) return [];

    const agentIds = activeAgents.map((a) => a.id);

    // Count runnable (todo/in_progress) issues per agent
    const runnableCounts = await db
      .select({
        agentId: issues.assigneeAgentId,
        count: sql<number>`count(*)`,
      })
      .from(issues)
      .where(
        and(
          eq(issues.companyId, companyId),
          inArray(issues.assigneeAgentId, agentIds),
          inArray(issues.status, RUNNABLE_STATUSES),
        ),
      )
      .groupBy(issues.assigneeAgentId);

    const runnableByAgent = new Map(
      runnableCounts.map((r) => [r.agentId, Number(r.count)]),
    );

    // Find agents with 0 runnable issues
    const starvedAgentIds = agentIds.filter(
      (id) => !runnableByAgent.has(id) || runnableByAgent.get(id) === 0,
    );

    if (starvedAgentIds.length === 0) return [];

    // Get non-runnable (backlog/blocked) issues for starved agents
    const nonRunnableIssues = await db
      .select({
        assigneeAgentId: issues.assigneeAgentId,
        id: issues.id,
        identifier: issues.identifier,
        title: issues.title,
        status: issues.status,
      })
      .from(issues)
      .where(
        and(
          eq(issues.companyId, companyId),
          inArray(issues.assigneeAgentId, starvedAgentIds),
          inArray(issues.status, NON_RUNNABLE_STATUSES),
        ),
      );

    // Group by agent — only include agents that actually have non-runnable work
    const byAgent = new Map<
      string,
      Array<{ id: string; identifier: string | null; title: string; status: string }>
    >();
    for (const issue of nonRunnableIssues) {
      const agentId = issue.assigneeAgentId!;
      if (!byAgent.has(agentId)) byAgent.set(agentId, []);
      byAgent.get(agentId)!.push({
        id: issue.id,
        identifier: issue.identifier,
        title: issue.title,
        status: issue.status,
      });
    }

    const agentMap = new Map(activeAgents.map((a) => [a.id, a.name]));

    return Array.from(byAgent.entries()).map(([agentId, stalled]) => ({
      agentId,
      agentName: agentMap.get(agentId) ?? agentId,
      runnableCount: 0,
      stalledIssues: stalled,
    }));
  }

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
      const starvedAgents = await detectQueueStarvation(companyId);

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
        queueStarvation: {
          starvedAgentCount: starvedAgents.length,
          starvedAgents,
        },
      };
    },
  };
}
