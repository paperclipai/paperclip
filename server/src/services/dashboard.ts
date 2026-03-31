import { and, eq, gte, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, approvals, companies, costEvents, issues } from "@paperclipai/db";
import { normalizeAgentUrlKey, type AgentStatus } from "@paperclipai/shared";
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

      const operationalAgents = await db
        .select({
          id: agents.id,
          name: agents.name,
          status: agents.status,
        })
        .from(agents)
        .where(
          and(
            eq(agents.companyId, companyId),
            sql`${agents.status} not in ('paused', 'error', 'pending_approval', 'terminated')`,
          ),
        );

      const inProgressTasks = await db
        .select({
          id: issues.id,
          identifier: issues.identifier,
          title: issues.title,
          assigneeAgentId: issues.assigneeAgentId,
          startedAt: issues.startedAt,
        })
        .from(issues)
        .where(and(eq(issues.companyId, companyId), eq(issues.status, "in_progress")));

      const queuedTasks = await db
        .select({ count: sql<number>`count(*)` })
        .from(issues)
        .where(
          and(
            eq(issues.companyId, companyId),
            sql`${issues.status} in ('todo', 'backlog')`,
            sql`${issues.assigneeAgentId} is not null`,
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
      const [{ monthSpend, monthInputTokens, monthOutputTokens }] = await db
        .select({
          monthSpend: sql<number>`coalesce(sum(${costEvents.costCents}), 0)::int`,
          monthInputTokens: sql<number>`coalesce(sum(${costEvents.inputTokens}), 0)::int`,
          monthOutputTokens: sql<number>`coalesce(sum(${costEvents.outputTokens}), 0)::int`,
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

      const tasksByAgent = new Map<string, typeof inProgressTasks>();
      for (const task of inProgressTasks) {
        if (!task.assigneeAgentId) continue;
        const list = tasksByAgent.get(task.assigneeAgentId) ?? [];
        list.push(task);
        tasksByAgent.set(task.assigneeAgentId, list);
      }

      const engineers = operationalAgents.map((agent) => {
        const currentTasks = tasksByAgent.get(agent.id) ?? [];
        const earliest = currentTasks.reduce<Date | null>((earliestTaskStart, task) => {
          if (!task.startedAt) return earliestTaskStart;
          if (!earliestTaskStart || task.startedAt < earliestTaskStart) return task.startedAt;
          return earliestTaskStart;
        }, null);

        return {
          agentId: agent.id,
          name: agent.name,
          urlKey: normalizeAgentUrlKey(agent.name) ?? agent.id,
          status: agent.status as AgentStatus,
          currentTasks: currentTasks.map((task) => ({
            issueId: task.id,
            identifier: task.identifier,
            title: task.title,
            startedAt: task.startedAt?.toISOString() ?? null,
          })),
          timeInCurrentTaskSec: earliest
            ? Math.floor((now.getTime() - earliest.getTime()) / 1000)
            : null,
        };
      });

      const idleEngineers = engineers.filter((engineer) => engineer.currentTasks.length === 0).length;
      const allBusy = engineers.length > 0 && idleEngineers === 0;
      const capacityStatus =
        !allBusy
          ? "GREEN"
          : queuedTasks > 0
            ? "RED"
            : "YELLOW";

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
          monthInputTokens: Number(monthInputTokens),
          monthOutputTokens: Number(monthOutputTokens),
        },
        pendingApprovals,
        agentWorkload: {
          capacityStatus,
          idleEngineers,
          queuedTasks,
          engineers,
        },
        budgets: {
          activeIncidents: budgetOverview.activeIncidents.length,
          pendingApprovals: budgetOverview.pendingApprovalCount,
          pausedAgents: budgetOverview.pausedAgentCount,
          pausedProjects: budgetOverview.pausedProjectCount,
        },
      };
    },
  };
}
