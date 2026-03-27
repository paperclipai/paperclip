import { and, desc, eq, gte, isNotNull, lte, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { activityLog, agents, companies, costEvents, heartbeatRuns, issues, projects } from "@paperclipai/db";
import { notFound, unprocessable } from "../errors.js";

export interface CostDateRange {
  from?: Date;
  to?: Date;
}

export function costService(db: Db) {
  return {
    createEvent: async (companyId: string, data: Omit<typeof costEvents.$inferInsert, "companyId">) => {
      const agent = await db
        .select()
        .from(agents)
        .where(eq(agents.id, data.agentId))
        .then((rows) => rows[0] ?? null);

      if (!agent) throw notFound("Agent not found");
      if (agent.companyId !== companyId) {
        throw unprocessable("Agent does not belong to company");
      }

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

      const updatedAgent = await db
        .select()
        .from(agents)
        .where(eq(agents.id, event.agentId))
        .then((rows) => rows[0] ?? null);

      if (
        updatedAgent &&
        updatedAgent.budgetMonthlyCents > 0 &&
        updatedAgent.spentMonthlyCents >= updatedAgent.budgetMonthlyCents &&
        updatedAgent.status !== "paused" &&
        updatedAgent.status !== "terminated"
      ) {
        await db
          .update(agents)
          .set({ status: "paused", updatedAt: new Date() })
          .where(eq(agents.id, updatedAgent.id));
      }

      return event;
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

      const totalRows = await db
        .select({
          total: sql<number>`coalesce(sum(${costEvents.costCents}), 0)::int`,
        })
        .from(costEvents)
        .where(and(...conditions));
      const { total } = totalRows[0] ?? { total: 0 };

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

    trend: async (companyId: string, range?: CostDateRange) => {
      const company = await db
        .select()
        .from(companies)
        .where(eq(companies.id, companyId))
        .then((rows) => rows[0] ?? null);

      if (!company) throw notFound("Company not found");

      const conditions: ReturnType<typeof eq>[] = [eq(costEvents.companyId, companyId)];
      if (range?.from) conditions.push(gte(costEvents.occurredAt, range.from));
      if (range?.to) conditions.push(lte(costEvents.occurredAt, range.to));

      const rows = await db
        .select({
          date: sql<string>`date(${costEvents.occurredAt} at time zone 'UTC')`,
          spendCents: sql<number>`coalesce(sum(${costEvents.costCents}), 0)::int`,
        })
        .from(costEvents)
        .where(and(...conditions))
        .groupBy(sql`date(${costEvents.occurredAt} at time zone 'UTC')`)
        .orderBy(sql`date(${costEvents.occurredAt} at time zone 'UTC')`);

      let cumulative = 0;
      const points = rows.map((row) => {
        cumulative += Number(row.spendCents);
        return {
          date: String(row.date),
          spendCents: Number(row.spendCents),
          cumulativeCents: cumulative,
        };
      });

      return {
        points,
        budgetCents: company.budgetMonthlyCents,
      };
    },

    forecast: async (companyId: string) => {
      const company = await db
        .select()
        .from(companies)
        .where(eq(companies.id, companyId))
        .then((rows) => rows[0] ?? null);

      if (!company) throw notFound("Company not found");

      const now = new Date();
      const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
      const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
      const dayOfMonth = now.getDate();

      const totalRows = await db
        .select({
          total: sql<number>`coalesce(sum(${costEvents.costCents}), 0)::int`,
        })
        .from(costEvents)
        .where(
          and(
            eq(costEvents.companyId, companyId),
            gte(costEvents.occurredAt, monthStart),
            lte(costEvents.occurredAt, now),
          ),
        );

      const spentSoFar = Number(totalRows[0]?.total ?? 0);
      const dailyAvgCents = dayOfMonth > 0 ? Math.round(spentSoFar / dayOfMonth) : 0;
      const projectedMonthEndCents = dailyAvgCents * daysInMonth;

      const budgetCents = company.budgetMonthlyCents;
      const remaining = budgetCents - spentSoFar;
      const daysUntilExhaustion =
        dailyAvgCents > 0 && budgetCents > 0
          ? Math.max(0, Math.round(remaining / dailyAvgCents))
          : null;

      let pacingStatus: "on_track" | "over_pacing" | "critical";
      if (budgetCents <= 0) {
        pacingStatus = "on_track";
      } else if (projectedMonthEndCents > budgetCents) {
        pacingStatus = "critical";
      } else if (projectedMonthEndCents > budgetCents * 0.8) {
        pacingStatus = "over_pacing";
      } else {
        pacingStatus = "on_track";
      }

      return {
        projectedMonthEndCents,
        daysUntilExhaustion,
        dailyAvgCents,
        pacingStatus,
      };
    },

    efficiency: async (companyId: string, range?: CostDateRange) => {
      const costConditions: ReturnType<typeof eq>[] = [eq(costEvents.companyId, companyId)];
      if (range?.from) costConditions.push(gte(costEvents.occurredAt, range.from));
      if (range?.to) costConditions.push(lte(costEvents.occurredAt, range.to));

      const costRows = await db
        .select({
          agentId: costEvents.agentId,
          agentName: agents.name,
          totalCostCents: sql<number>`coalesce(sum(${costEvents.costCents}), 0)::int`,
        })
        .from(costEvents)
        .leftJoin(agents, eq(costEvents.agentId, agents.id))
        .where(and(...costConditions))
        .groupBy(costEvents.agentId, agents.name);

      const agentIds = costRows.map((r) => r.agentId);
      if (agentIds.length === 0) return [];

      // Count tasks completed & attempted per agent
      const taskRows = await db
        .select({
          agentId: issues.assigneeAgentId,
          tasksCompleted: sql<number>`coalesce(sum(case when ${issues.status} = 'done' then 1 else 0 end), 0)::int`,
          tasksAttempted: sql<number>`coalesce(sum(case when ${issues.status} in ('done', 'cancelled', 'blocked') then 1 else 0 end), 0)::int`,
        })
        .from(issues)
        .where(
          and(
            eq(issues.companyId, companyId),
            sql`${issues.assigneeAgentId} = ANY(${agentIds})`,
          ),
        )
        .groupBy(issues.assigneeAgentId);

      const taskMap = new Map(taskRows.map((r) => [r.agentId, r]));

      // Count runs per agent
      const runConditions: ReturnType<typeof eq>[] = [eq(heartbeatRuns.companyId, companyId)];
      if (range?.from) runConditions.push(gte(heartbeatRuns.finishedAt, range.from));
      if (range?.to) runConditions.push(lte(heartbeatRuns.finishedAt, range.to));

      const runRows = await db
        .select({
          agentId: heartbeatRuns.agentId,
          totalRuns: sql<number>`count(*)::int`,
        })
        .from(heartbeatRuns)
        .where(
          and(
            ...runConditions,
            sql`${heartbeatRuns.agentId} = ANY(${agentIds})`,
          ),
        )
        .groupBy(heartbeatRuns.agentId);

      const runMap = new Map(runRows.map((r) => [r.agentId, r]));

      return costRows.map((row) => {
        const tasks = taskMap.get(row.agentId);
        const runs = runMap.get(row.agentId);
        const cost = Number(row.totalCostCents);
        const completed = Number(tasks?.tasksCompleted ?? 0);
        const attempted = Number(tasks?.tasksAttempted ?? 0);
        const totalRuns = Number(runs?.totalRuns ?? 0);

        return {
          agentId: row.agentId,
          agentName: row.agentName,
          costPerTaskCompleted: completed > 0 ? Math.round(cost / completed) : null,
          costPerTaskAttempted: attempted > 0 ? Math.round(cost / attempted) : null,
          avgCostPerRun: totalRuns > 0 ? Math.round(cost / totalRuns) : null,
          tasksCompleted: completed,
          tasksAttempted: attempted,
          totalRuns,
          totalCostCents: cost,
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
