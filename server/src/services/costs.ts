import { and, desc, eq, gte, isNotNull, lte, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { activityLog, agents, companies, costEvents, heartbeatRuns, issues, projects } from "@paperclipai/db";
import type { CostByAgent, CostByProject, CostSummary, PricingState } from "@paperclipai/shared";
import { notFound, unprocessable } from "../errors.js";

export interface CostDateRange {
  from?: Date;
  to?: Date;
}

type UsageJson = Record<string, unknown> | null;

function usageNumber(usage: UsageJson, ...keys: string[]) {
  if (!usage) return 0;
  for (const key of keys) {
    const value = usage[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && value.trim().length > 0) {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return 0;
}

function usageString(usage: UsageJson, ...keys: string[]) {
  if (!usage) return null;
  for (const key of keys) {
    const value = usage[key];
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
  }
  return null;
}

function tokenCount(usage: UsageJson) {
  return (
    usageNumber(usage, "inputTokens", "input_tokens") +
    usageNumber(usage, "outputTokens", "output_tokens") +
    usageNumber(usage, "cachedInputTokens", "cached_input_tokens", "cache_read_input_tokens")
  );
}

function pricedCostCents(usage: UsageJson) {
  return Math.round(usageNumber(usage, "costUsd", "cost_usd", "total_cost_usd") * 100);
}

export function pricingStateForUsageRows(rows: Array<{ usageJson: UsageJson }>): PricingState {
  let tokenRuns = 0;
  let pricedRuns = 0;
  for (const row of rows) {
    const tokens = tokenCount(row.usageJson);
    if (tokens > 0) tokenRuns += 1;
    if (pricedCostCents(row.usageJson) > 0) pricedRuns += 1;
  }
  if (tokenRuns === 0) return "exact";
  if (pricedRuns === 0) return "unpriced";
  if (pricedRuns < tokenRuns) return "estimated";
  return "exact";
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

    summary: async (companyId: string, range?: CostDateRange): Promise<CostSummary> => {
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

      const runConditions: ReturnType<typeof eq>[] = [eq(heartbeatRuns.companyId, companyId)];
      if (range?.from) runConditions.push(gte(heartbeatRuns.finishedAt, range.from));
      if (range?.to) runConditions.push(lte(heartbeatRuns.finishedAt, range.to));

      const usageRows = await db
        .select({ usageJson: heartbeatRuns.usageJson })
        .from(heartbeatRuns)
        .where(and(...runConditions));

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
        pricingState: pricingStateForUsageRows(usageRows),
      };
    },

    byAgent: async (companyId: string, range?: CostDateRange): Promise<CostByAgent[]> => {
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
          usageJson: heartbeatRuns.usageJson,
        })
        .from(heartbeatRuns)
        .where(and(...runConditions));

      const runRowsByAgent = new Map<
        string,
        {
          usageRows: Array<{ usageJson: UsageJson }>;
          apiRunCount: number;
          subscriptionRunCount: number;
          subscriptionInputTokens: number;
          subscriptionOutputTokens: number;
        }
      >();
      for (const row of runRows) {
        const current = runRowsByAgent.get(row.agentId) ?? {
          usageRows: [],
          apiRunCount: 0,
          subscriptionRunCount: 0,
          subscriptionInputTokens: 0,
          subscriptionOutputTokens: 0,
        };
        current.usageRows.push({ usageJson: row.usageJson });
        const billingType = usageString(row.usageJson, "billingType", "billing_type");
        if (billingType === "api") current.apiRunCount += 1;
        if (billingType === "subscription") {
          current.subscriptionRunCount += 1;
          current.subscriptionInputTokens += usageNumber(row.usageJson, "inputTokens", "input_tokens");
          current.subscriptionOutputTokens += usageNumber(row.usageJson, "outputTokens", "output_tokens");
        }
        runRowsByAgent.set(row.agentId, current);
      }

      return costRows.map((row) => {
        const runRow = runRowsByAgent.get(row.agentId);
        return {
          ...row,
          pricingState: pricingStateForUsageRows(runRow?.usageRows ?? []),
          apiRunCount: runRow?.apiRunCount ?? 0,
          subscriptionRunCount: runRow?.subscriptionRunCount ?? 0,
          subscriptionInputTokens: runRow?.subscriptionInputTokens ?? 0,
          subscriptionOutputTokens: runRow?.subscriptionOutputTokens ?? 0,
        };
      });
    },

    byProject: async (companyId: string, range?: CostDateRange): Promise<CostByProject[]> => {
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

      const rows = await db
        .select({
          projectId: runProjectLinks.projectId,
          projectName: projects.name,
          usageJson: heartbeatRuns.usageJson,
        })
        .from(runProjectLinks)
        .innerJoin(heartbeatRuns, eq(runProjectLinks.runId, heartbeatRuns.id))
        .innerJoin(projects, eq(runProjectLinks.projectId, projects.id))
        .where(and(...conditions));

      const rowsByProject = new Map<
        string,
        {
          projectId: string | null;
          projectName: string | null;
          costCents: number;
          inputTokens: number;
          outputTokens: number;
          usageRows: Array<{ usageJson: UsageJson }>;
        }
      >();
      for (const row of rows) {
        const key = row.projectId ?? "unattributed";
        const current = rowsByProject.get(key) ?? {
          projectId: row.projectId,
          projectName: row.projectName,
          costCents: 0,
          inputTokens: 0,
          outputTokens: 0,
          usageRows: [],
        };
        current.costCents += pricedCostCents(row.usageJson);
        current.inputTokens += usageNumber(row.usageJson, "inputTokens", "input_tokens");
        current.outputTokens += usageNumber(row.usageJson, "outputTokens", "output_tokens");
        current.usageRows.push({ usageJson: row.usageJson });
        rowsByProject.set(key, current);
      }

      return Array.from(rowsByProject.values())
        .map((row) => ({
          projectId: row.projectId,
          projectName: row.projectName,
          costCents: row.costCents,
          pricingState: pricingStateForUsageRows(row.usageRows),
          inputTokens: row.inputTokens,
          outputTokens: row.outputTokens,
        }))
        .sort((left, right) => right.costCents - left.costCents);
    },
  };
}
