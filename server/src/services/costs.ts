import { and, desc, eq, gte, isNotNull, lte, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { activityLog, agents, companies, costEvents, heartbeatRuns, issues, projects } from "@paperclipai/db";
import { notFound, unprocessable } from "../errors.js";

export type BudgetBlockScope = "company" | "agent";
export type BudgetBlockReason = "budget.company_limit_reached" | "budget.agent_limit_reached";

export interface BudgetBlock {
  scope: BudgetBlockScope;
  reason: BudgetBlockReason;
  message: string;
  budgetCents: number;
  spentCents: number;
}

export function resolveBudgetBlock(input: {
  companyBudgetMonthlyCents: number;
  companySpentMonthlyCents: number;
  agentBudgetMonthlyCents: number;
  agentSpentMonthlyCents: number;
}): BudgetBlock | null {
  if (
    input.companyBudgetMonthlyCents > 0 &&
    input.companySpentMonthlyCents >= input.companyBudgetMonthlyCents
  ) {
    return {
      scope: "company",
      reason: "budget.company_limit_reached",
      message: "Company monthly budget has been exhausted; new heartbeats are blocked until the budget is raised or the month rolls over.",
      budgetCents: input.companyBudgetMonthlyCents,
      spentCents: input.companySpentMonthlyCents,
    };
  }

  if (
    input.agentBudgetMonthlyCents > 0 &&
    input.agentSpentMonthlyCents >= input.agentBudgetMonthlyCents
  ) {
    return {
      scope: "agent",
      reason: "budget.agent_limit_reached",
      message: "Agent monthly budget has been exhausted; new heartbeats are blocked until the budget is raised or the month rolls over.",
      budgetCents: input.agentBudgetMonthlyCents,
      spentCents: input.agentSpentMonthlyCents,
    };
  }

  return null;
}

export interface CostDateRange {
  from?: Date;
  to?: Date;
}

export function costService(db: Db) {
  async function getBudgetSnapshot(companyId: string, agentId: string) {
    const [company, agent] = await Promise.all([
      db
        .select()
        .from(companies)
        .where(eq(companies.id, companyId))
        .then((rows) => rows[0] ?? null),
      db
        .select()
        .from(agents)
        .where(eq(agents.id, agentId))
        .then((rows) => rows[0] ?? null),
    ]);

    if (!company) throw notFound("Company not found");
    if (!agent) throw notFound("Agent not found");
    if (agent.companyId !== companyId) {
      throw unprocessable("Agent does not belong to company");
    }

    return { company, agent };
  }

  async function pauseAgentIfBudgetBlocked(agentId: string, status: string) {
    if (status === "paused" || status === "terminated" || status === "pending_approval") {
      return;
    }

    await db
      .update(agents)
      .set({ status: "paused", updatedAt: new Date() })
      .where(eq(agents.id, agentId));
  }

  return {
    createEvent: async (companyId: string, data: Omit<typeof costEvents.$inferInsert, "companyId">) => {
      await getBudgetSnapshot(companyId, data.agentId);

      const event = await db
        .insert(costEvents)
        .values({ ...data, companyId })
        .returning()
        .then((rows) => rows[0]);

      await db
        .update(agents)
        .set({
          spentMonthlyCents: sql`${agents.spentMonthlyCents} + ${event.costCents}`,
          updatedAt: new Date(),
        })
        .where(eq(agents.id, event.agentId));

      await db
        .update(companies)
        .set({
          spentMonthlyCents: sql`${companies.spentMonthlyCents} + ${event.costCents}`,
          updatedAt: new Date(),
        })
        .where(eq(companies.id, companyId));

      const {
        company: updatedCompany,
        agent: updatedAgent,
      } = await getBudgetSnapshot(companyId, event.agentId);
      const budgetBlock = resolveBudgetBlock({
        companyBudgetMonthlyCents: updatedCompany.budgetMonthlyCents,
        companySpentMonthlyCents: updatedCompany.spentMonthlyCents,
        agentBudgetMonthlyCents: updatedAgent.budgetMonthlyCents,
        agentSpentMonthlyCents: updatedAgent.spentMonthlyCents,
      });

      if (budgetBlock) {
        await pauseAgentIfBudgetBlocked(updatedAgent.id, updatedAgent.status);
      }

      return event;
    },

    getBudgetBlock: async (companyId: string, agentId: string) => {
      const { company, agent } = await getBudgetSnapshot(companyId, agentId);
      return resolveBudgetBlock({
        companyBudgetMonthlyCents: company.budgetMonthlyCents,
        companySpentMonthlyCents: company.spentMonthlyCents,
        agentBudgetMonthlyCents: agent.budgetMonthlyCents,
        agentSpentMonthlyCents: agent.spentMonthlyCents,
      });
    },

    enforceBudgetBlock: async (companyId: string, agentId: string) => {
      const { company, agent } = await getBudgetSnapshot(companyId, agentId);
      const budgetBlock = resolveBudgetBlock({
        companyBudgetMonthlyCents: company.budgetMonthlyCents,
        companySpentMonthlyCents: company.spentMonthlyCents,
        agentBudgetMonthlyCents: agent.budgetMonthlyCents,
        agentSpentMonthlyCents: agent.spentMonthlyCents,
      });

      if (budgetBlock) {
        await pauseAgentIfBudgetBlocked(agent.id, agent.status);
      }

      return budgetBlock;
    },

    summary: async (companyId: string, range?: CostDateRange) => {
      const company = await db
        .select()
        .from(companies)
        .where(eq(companies.id, companyId))
        .then((rows) => rows[0] ?? null);

      if (!company) throw notFound("Company not found");

      const conditions: ReturnType<typeof eq>[] = [eq(costEvents.companyId, companyId)];
      if (range?.from) conditions.push(gte(costEvents.occurredAt, range.from));
      if (range?.to) conditions.push(lte(costEvents.occurredAt, range.to));

      const [{ total }] = await db
        .select({
          total: sql<number>`coalesce(sum(${costEvents.costCents}), 0)::int`,
        })
        .from(costEvents)
        .where(and(...conditions));

      const spendCents = Number(total);
      const utilization =
        company.budgetMonthlyCents > 0
          ? (spendCents / company.budgetMonthlyCents) * 100
          : 0;

      return {
        companyId,
        spendCents,
        budgetCents: company.budgetMonthlyCents,
        utilizationPercent: Number(utilization.toFixed(2)),
      };
    },

    byAgent: async (companyId: string, range?: CostDateRange) => {
      const conditions: ReturnType<typeof eq>[] = [eq(costEvents.companyId, companyId)];
      if (range?.from) conditions.push(gte(costEvents.occurredAt, range.from));
      if (range?.to) conditions.push(lte(costEvents.occurredAt, range.to));

      const costRows = await db
        .select({
          agentId: costEvents.agentId,
          agentName: agents.name,
          agentStatus: agents.status,
          costCents: sql<number>`coalesce(sum(${costEvents.costCents}), 0)::int`,
          inputTokens: sql<number>`coalesce(sum(${costEvents.inputTokens}), 0)::int`,
          outputTokens: sql<number>`coalesce(sum(${costEvents.outputTokens}), 0)::int`,
        })
        .from(costEvents)
        .leftJoin(agents, eq(costEvents.agentId, agents.id))
        .where(and(...conditions))
        .groupBy(costEvents.agentId, agents.name, agents.status)
        .orderBy(desc(sql`coalesce(sum(${costEvents.costCents}), 0)::int`));

      const runConditions: ReturnType<typeof eq>[] = [eq(heartbeatRuns.companyId, companyId)];
      if (range?.from) runConditions.push(gte(heartbeatRuns.finishedAt, range.from));
      if (range?.to) runConditions.push(lte(heartbeatRuns.finishedAt, range.to));

      const runRows = await db
        .select({
          agentId: heartbeatRuns.agentId,
          apiRunCount:
            sql<number>`coalesce(sum(case when coalesce((${heartbeatRuns.usageJson} ->> 'billingType'), 'unknown') = 'api' then 1 else 0 end), 0)::int`,
          subscriptionRunCount:
            sql<number>`coalesce(sum(case when coalesce((${heartbeatRuns.usageJson} ->> 'billingType'), 'unknown') = 'subscription' then 1 else 0 end), 0)::int`,
          subscriptionInputTokens:
            sql<number>`coalesce(sum(case when coalesce((${heartbeatRuns.usageJson} ->> 'billingType'), 'unknown') = 'subscription' then coalesce((${heartbeatRuns.usageJson} ->> 'inputTokens')::int, 0) else 0 end), 0)::int`,
          subscriptionOutputTokens:
            sql<number>`coalesce(sum(case when coalesce((${heartbeatRuns.usageJson} ->> 'billingType'), 'unknown') = 'subscription' then coalesce((${heartbeatRuns.usageJson} ->> 'outputTokens')::int, 0) else 0 end), 0)::int`,
        })
        .from(heartbeatRuns)
        .where(and(...runConditions))
        .groupBy(heartbeatRuns.agentId);

      const runRowsByAgent = new Map(runRows.map((row) => [row.agentId, row]));
      return costRows.map((row) => {
        const runRow = runRowsByAgent.get(row.agentId);
        return {
          ...row,
          apiRunCount: runRow?.apiRunCount ?? 0,
          subscriptionRunCount: runRow?.subscriptionRunCount ?? 0,
          subscriptionInputTokens: runRow?.subscriptionInputTokens ?? 0,
          subscriptionOutputTokens: runRow?.subscriptionOutputTokens ?? 0,
        };
      });
    },

    byProject: async (companyId: string, range?: CostDateRange) => {
      const issueIdAsText = sql<string>`${issues.id}::text`;
      const runProjectLinks = db
        .selectDistinctOn([activityLog.runId, issues.projectId], {
          runId: activityLog.runId,
          projectId: issues.projectId,
        })
        .from(activityLog)
        .innerJoin(
          issues,
          and(
            eq(activityLog.entityType, "issue"),
            eq(activityLog.entityId, issueIdAsText),
          ),
        )
        .where(
          and(
            eq(activityLog.companyId, companyId),
            eq(issues.companyId, companyId),
            isNotNull(activityLog.runId),
            isNotNull(issues.projectId),
          ),
        )
        .orderBy(activityLog.runId, issues.projectId, desc(activityLog.createdAt))
        .as("run_project_links");

      const conditions: ReturnType<typeof eq>[] = [eq(heartbeatRuns.companyId, companyId)];
      if (range?.from) conditions.push(gte(heartbeatRuns.finishedAt, range.from));
      if (range?.to) conditions.push(lte(heartbeatRuns.finishedAt, range.to));

      const costCentsExpr = sql<number>`coalesce(sum(round(coalesce((${heartbeatRuns.usageJson} ->> 'costUsd')::numeric, 0) * 100)), 0)::int`;

      return db
        .select({
          projectId: runProjectLinks.projectId,
          projectName: projects.name,
          costCents: costCentsExpr,
          inputTokens: sql<number>`coalesce(sum(coalesce((${heartbeatRuns.usageJson} ->> 'inputTokens')::int, 0)), 0)::int`,
          outputTokens: sql<number>`coalesce(sum(coalesce((${heartbeatRuns.usageJson} ->> 'outputTokens')::int, 0)), 0)::int`,
        })
        .from(runProjectLinks)
        .innerJoin(heartbeatRuns, eq(runProjectLinks.runId, heartbeatRuns.id))
        .innerJoin(projects, eq(runProjectLinks.projectId, projects.id))
        .where(and(...conditions))
        .groupBy(runProjectLinks.projectId, projects.name)
        .orderBy(desc(costCentsExpr));
    },
  };
}
