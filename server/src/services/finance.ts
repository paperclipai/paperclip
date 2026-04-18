import { and, desc, eq, gte, lte, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, costEvents, financeEvents, goals, heartbeatRuns, issues, projects } from "@paperclipai/db";
import { notFound, unprocessable } from "../errors.js";

export interface FinanceDateRange {
  from?: Date;
  to?: Date;
}

export interface FinanceReadScope {
  scopeDepartmentIds?: string[];
}

async function assertBelongsToCompany(
  db: Db,
  table: any,
  id: string,
  companyId: string,
  label: string,
) {
  const row = await db
    .select()
    .from(table)
    .where(eq(table.id, id))
    .then((rows) => rows[0] ?? null);

  if (!row) throw notFound(`${label} not found`);
  if ((row as unknown as { companyId: string }).companyId !== companyId) {
    throw unprocessable(`${label} does not belong to company`);
  }
}

function rangeConditions(companyId: string, range?: FinanceDateRange) {
  const conditions: any[] = [eq(financeEvents.companyId, companyId)];
  if (range?.from) conditions.push(gte(financeEvents.occurredAt, range.from));
  if (range?.to) conditions.push(lte(financeEvents.occurredAt, range.to));
  return conditions;
}

function effectiveFinanceDepartmentIdSql() {
  return sql<string | null>`coalesce(
    (
      select project_row.department_id
      from ${projects} project_row
      where project_row.id = ${financeEvents.projectId}
      limit 1
    ),
    (
      select coalesce(issue_row.department_id, issue_project.department_id)
      from ${issues} issue_row
      left join ${projects} issue_project on issue_project.id = issue_row.project_id
      where issue_row.id = ${financeEvents.issueId}
      limit 1
    ),
    (
      select agent_row.department_id
      from ${agents} agent_row
      where agent_row.id = ${financeEvents.agentId}
      limit 1
    ),
    (
      select coalesce(cost_project.department_id, cost_issue.department_id, cost_issue_project.department_id, cost_agent.department_id)
      from ${costEvents} cost_event_row
      left join ${projects} cost_project on cost_project.id = cost_event_row.project_id
      left join ${issues} cost_issue on cost_issue.id = cost_event_row.issue_id
      left join ${projects} cost_issue_project on cost_issue_project.id = cost_issue.project_id
      left join ${agents} cost_agent on cost_agent.id = cost_event_row.agent_id
      where cost_event_row.id = ${financeEvents.costEventId}
      limit 1
    )
  )`;
}

function scopeCondition(departmentIds: string[], departmentIdSql: ReturnType<typeof sql<string | null>>) {
  return sql`${departmentIdSql} in (${sql.join(departmentIds.map((departmentId) => sql`${departmentId}`), sql`, `)})`;
}

export function financeService(db: Db) {
  const debitExpr = sql<number>`coalesce(sum(case when ${financeEvents.direction} = 'debit' then ${financeEvents.amountCents} else 0 end), 0)::int`;
  const creditExpr = sql<number>`coalesce(sum(case when ${financeEvents.direction} = 'credit' then ${financeEvents.amountCents} else 0 end), 0)::int`;
  const estimatedDebitExpr = sql<number>`coalesce(sum(case when ${financeEvents.direction} = 'debit' and ${financeEvents.estimated} = true then ${financeEvents.amountCents} else 0 end), 0)::int`;
  const effectiveDepartmentId = effectiveFinanceDepartmentIdSql();

  return {
    createEvent: async (companyId: string, data: Omit<typeof financeEvents.$inferInsert, "companyId">) => {
      if (data.agentId) await assertBelongsToCompany(db, agents, data.agentId, companyId, "Agent");
      if (data.issueId) await assertBelongsToCompany(db, issues, data.issueId, companyId, "Issue");
      if (data.projectId) await assertBelongsToCompany(db, projects, data.projectId, companyId, "Project");
      if (data.goalId) await assertBelongsToCompany(db, goals, data.goalId, companyId, "Goal");
      if (data.heartbeatRunId) await assertBelongsToCompany(db, heartbeatRuns, data.heartbeatRunId, companyId, "Heartbeat run");
      if (data.costEventId) await assertBelongsToCompany(db, costEvents, data.costEventId, companyId, "Cost event");

      const event = await db
        .insert(financeEvents)
        .values({
          ...data,
          companyId,
          currency: data.currency ?? "USD",
          direction: data.direction ?? "debit",
          estimated: data.estimated ?? false,
        })
        .returning()
        .then((rows) => rows[0]);

      return event;
    },

    summary: async (companyId: string, range?: FinanceDateRange, scope?: FinanceReadScope) => {
      const conditions = rangeConditions(companyId, range);
      if (scope?.scopeDepartmentIds?.length) {
        conditions.push(scopeCondition(scope.scopeDepartmentIds, effectiveDepartmentId));
      }
      const [row] = await db
        .select({
          debitCents: debitExpr,
          creditCents: creditExpr,
          estimatedDebitCents: estimatedDebitExpr,
          eventCount: sql<number>`count(*)::int`,
        })
        .from(financeEvents)
        .where(and(...conditions));

      return {
        companyId,
        debitCents: Number(row?.debitCents ?? 0),
        creditCents: Number(row?.creditCents ?? 0),
        netCents: Number(row?.debitCents ?? 0) - Number(row?.creditCents ?? 0),
        estimatedDebitCents: Number(row?.estimatedDebitCents ?? 0),
        eventCount: Number(row?.eventCount ?? 0),
      };
    },

    byBiller: async (companyId: string, range?: FinanceDateRange, scope?: FinanceReadScope) => {
      const conditions = rangeConditions(companyId, range);
      if (scope?.scopeDepartmentIds?.length) {
        conditions.push(scopeCondition(scope.scopeDepartmentIds, effectiveDepartmentId));
      }
      return db
        .select({
          biller: financeEvents.biller,
          debitCents: debitExpr,
          creditCents: creditExpr,
          estimatedDebitCents: estimatedDebitExpr,
          eventCount: sql<number>`count(*)::int`,
          kindCount: sql<number>`count(distinct ${financeEvents.eventKind})::int`,
          netCents: sql<number>`(${debitExpr} - ${creditExpr})::int`,
        })
        .from(financeEvents)
        .where(and(...conditions))
        .groupBy(financeEvents.biller)
        .orderBy(desc(sql`(${debitExpr} - ${creditExpr})::int`), financeEvents.biller);
    },

    byKind: async (companyId: string, range?: FinanceDateRange, scope?: FinanceReadScope) => {
      const conditions = rangeConditions(companyId, range);
      if (scope?.scopeDepartmentIds?.length) {
        conditions.push(scopeCondition(scope.scopeDepartmentIds, effectiveDepartmentId));
      }
      return db
        .select({
          eventKind: financeEvents.eventKind,
          debitCents: debitExpr,
          creditCents: creditExpr,
          estimatedDebitCents: estimatedDebitExpr,
          eventCount: sql<number>`count(*)::int`,
          billerCount: sql<number>`count(distinct ${financeEvents.biller})::int`,
          netCents: sql<number>`(${debitExpr} - ${creditExpr})::int`,
        })
        .from(financeEvents)
        .where(and(...conditions))
        .groupBy(financeEvents.eventKind)
        .orderBy(desc(sql`(${debitExpr} - ${creditExpr})::int`), financeEvents.eventKind);
    },

    list: async (companyId: string, range?: FinanceDateRange, limit: number = 100, scope?: FinanceReadScope) => {
      const conditions = rangeConditions(companyId, range);
      if (scope?.scopeDepartmentIds?.length) {
        conditions.push(scopeCondition(scope.scopeDepartmentIds, effectiveDepartmentId));
      }
      return db
        .select()
        .from(financeEvents)
        .where(and(...conditions))
        .orderBy(desc(financeEvents.occurredAt), desc(financeEvents.createdAt))
        .limit(limit);
    },
  };
}
