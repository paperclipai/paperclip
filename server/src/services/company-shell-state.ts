import { and, desc, eq, gte, inArray, lt, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  agents,
  approvals,
  companies,
  costEvents,
  heartbeatRuns,
  joinRequests as joinRequestsTable,
} from "@paperclipai/db";
import type {
  CompanyRailState,
  FailedRunSummary,
  InboxSummary,
  RunActivitySummary,
} from "@paperclipai/shared";
import { LIVE_HEARTBEAT_RUN_FRESHNESS_WINDOW_MS } from "./heartbeat-run-activity.js";

const ACTIONABLE_APPROVAL_STATUSES = ["pending", "revision_requested"];
const FAILED_RUN_STATUSES = ["failed", "timed_out"];
const LIVE_RUN_STATUSES = ["queued", "running"];
const NON_ACTIONABLE_RETRY_STATES = new Set(["scheduled", "retrying"]);

function currentUtcMonthWindow(now = new Date()) {
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  return {
    start: new Date(Date.UTC(year, month, 1, 0, 0, 0, 0)),
    end: new Date(Date.UTC(year, month + 1, 1, 0, 0, 0, 0)),
  };
}

function utcDayString(value: Date) {
  return value.toISOString().slice(0, 10);
}

function utcDayRange(days: number, now = new Date()) {
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0, 0));
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - (days - 1));
  return { start, end };
}

function buildLiveRunFreshnessPredicate() {
  const cutoff = new Date(Date.now() - LIVE_HEARTBEAT_RUN_FRESHNESS_WINDOW_MS).toISOString();
  return sql`
    coalesce(${heartbeatRuns.lastActivityAt}, ${heartbeatRuns.updatedAt}, ${heartbeatRuns.startedAt}, ${heartbeatRuns.createdAt}) >= ${cutoff}::timestamptz
  `;
}

export function companyShellStateService(db: Db) {
  async function countActionableApprovals(companyId: string) {
    const rows = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(approvals)
      .where(
        and(
          eq(approvals.companyId, companyId),
          inArray(approvals.status, ACTIONABLE_APPROVAL_STATUSES),
        ),
      );
    return Number(rows[0]?.count ?? 0);
  }

  async function countJoinRequests(companyId: string) {
    const rows = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(joinRequestsTable)
      .where(
        and(
          eq(joinRequestsTable.companyId, companyId),
          eq(joinRequestsTable.status, "pending_approval"),
        ),
      );
    return Number(rows[0]?.count ?? 0);
  }

  async function listFailedRunSummaries(companyId: string): Promise<FailedRunSummary[]> {
    const rows = await db
      .selectDistinctOn([heartbeatRuns.agentId], {
        id: heartbeatRuns.id,
        agentId: heartbeatRuns.agentId,
        status: heartbeatRuns.status,
        createdAt: heartbeatRuns.createdAt,
        retryState: heartbeatRuns.retryState,
        error: heartbeatRuns.error,
        issueId: sql<string | null>`${heartbeatRuns.contextSnapshot} ->> 'issueId'`.as("issueId"),
      })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.companyId, companyId))
      .orderBy(heartbeatRuns.agentId, desc(heartbeatRuns.createdAt));

    return rows.filter((row): row is FailedRunSummary => {
      return FAILED_RUN_STATUSES.includes(row.status)
        && !NON_ACTIONABLE_RETRY_STATES.has(row.retryState);
    });
  }

  async function countErrorAgents(companyId: string) {
    const rows = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(agents)
      .where(and(eq(agents.companyId, companyId), eq(agents.status, "error")));
    return Number(rows[0]?.count ?? 0);
  }

  async function getMonthlyBudgetSignal(companyId: string, now = new Date()) {
    const companyRow = await db
      .select({ budgetMonthlyCents: companies.budgetMonthlyCents })
      .from(companies)
      .where(eq(companies.id, companyId))
      .then((rows) => rows[0] ?? null);
    const budgetMonthlyCents = Number(companyRow?.budgetMonthlyCents ?? 0);
    if (budgetMonthlyCents <= 0) {
      return { budgetMonthlyCents: 0, monthSpendCents: 0, utilizationPercent: 0 };
    }

    const { start, end } = currentUtcMonthWindow(now);
    const spendRows = await db
      .select({
        monthSpendCents: sql<number>`coalesce(sum(${costEvents.costCents}), 0)::int`,
      })
      .from(costEvents)
      .where(
        and(
          eq(costEvents.companyId, companyId),
          gte(costEvents.occurredAt, start),
          lt(costEvents.occurredAt, end),
        ),
      );
    const monthSpendCents = Number(spendRows[0]?.monthSpendCents ?? 0);
    const utilizationPercent = budgetMonthlyCents > 0
      ? Math.round((monthSpendCents / budgetMonthlyCents) * 100)
      : 0;

    return { budgetMonthlyCents, monthSpendCents, utilizationPercent };
  }

  async function hasLiveRuns(companyId: string) {
    const rows = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(heartbeatRuns)
      .where(
        and(
          eq(heartbeatRuns.companyId, companyId),
          inArray(heartbeatRuns.status, LIVE_RUN_STATUSES),
          buildLiveRunFreshnessPredicate(),
        ),
      );
    return Number(rows[0]?.count ?? 0) > 0;
  }

  async function getInboxSummary(
    companyId: string,
    extra?: { canApproveJoins?: boolean; unreadTouchedIssues?: number },
  ): Promise<InboxSummary> {
    const [
      actionableApprovals,
      failedRunSummaries,
      errorAgents,
      budgetSignal,
    ] = await Promise.all([
      countActionableApprovals(companyId),
      listFailedRunSummaries(companyId),
      countErrorAgents(companyId),
      getMonthlyBudgetSignal(companyId),
    ]);

    const failedRuns = failedRunSummaries.length;
    const joinRequests = extra?.canApproveJoins ? await countJoinRequests(companyId) : 0;
    const mineIssues = extra?.unreadTouchedIssues ?? 0;
    const alerts = Number(errorAgents > 0 && failedRuns === 0)
      + Number(budgetSignal.budgetMonthlyCents > 0 && budgetSignal.utilizationPercent >= 80);

    return {
      inbox: actionableApprovals + failedRuns + joinRequests + mineIssues + alerts,
      approvals: actionableApprovals,
      failedRuns,
      joinRequests,
      mineIssues,
      alerts,
      failedRunSummaries,
    };
  }

  return {
    getInboxSummary,

    async listRailState(
      inputs: Array<{ companyId: string; canApproveJoins?: boolean; unreadTouchedIssues?: number }>,
    ): Promise<CompanyRailState[]> {
      const liveCompanyIds = inputs.length === 0
        ? new Set<string>()
        : new Set(
          (await db
            .select({ companyId: heartbeatRuns.companyId })
            .from(heartbeatRuns)
            .where(
              and(
                inArray(heartbeatRuns.companyId, inputs.map((input) => input.companyId)),
                inArray(heartbeatRuns.status, LIVE_RUN_STATUSES),
                buildLiveRunFreshnessPredicate(),
              ),
            )
            .groupBy(heartbeatRuns.companyId))
            .map((row) => row.companyId),
        );

      const summaries = await Promise.all(
        inputs.map(async (input) => ({
          companyId: input.companyId,
          summary: await getInboxSummary(input.companyId, input),
        })),
      );

      return summaries.map(({ companyId, summary }) => ({
        companyId,
        inboxCount: summary.inbox,
        hasLiveRuns: liveCompanyIds.has(companyId),
      }));
    },

    async getRunActivity(companyId: string, days: number): Promise<RunActivitySummary> {
      const normalizedDays = Math.max(1, Math.min(days, 90));
      const { start, end } = utcDayRange(normalizedDays);
      const dayExpr = sql<string>`to_char(date_trunc('day', timezone('UTC', ${heartbeatRuns.createdAt})), 'YYYY-MM-DD')`;
      const rows = await db
        .select({
          date: dayExpr.as("date"),
          succeeded: sql<number>`count(*) filter (where ${heartbeatRuns.status} = 'succeeded')::int`,
          failed: sql<number>`count(*) filter (where ${heartbeatRuns.status} in ('failed', 'timed_out'))::int`,
          other: sql<number>`count(*) filter (where ${heartbeatRuns.status} not in ('succeeded', 'failed', 'timed_out'))::int`,
          total: sql<number>`count(*)::int`,
        })
        .from(heartbeatRuns)
        .where(
          and(
            eq(heartbeatRuns.companyId, companyId),
            gte(heartbeatRuns.createdAt, start),
            lt(heartbeatRuns.createdAt, new Date(end.getTime() + 24 * 60 * 60 * 1000)),
          ),
        )
        .groupBy(dayExpr)
        .orderBy(dayExpr);

      const buckets = new Map(rows.map((row) => [row.date, {
        date: row.date,
        succeeded: Number(row.succeeded ?? 0),
        failed: Number(row.failed ?? 0),
        other: Number(row.other ?? 0),
        total: Number(row.total ?? 0),
      }]));

      const series = [];
      const cursor = new Date(start);
      while (cursor <= end) {
        const date = utcDayString(cursor);
        series.push(
          buckets.get(date) ?? { date, succeeded: 0, failed: 0, other: 0, total: 0 },
        );
        cursor.setUTCDate(cursor.getUTCDate() + 1);
      }

      return { days: series };
    },

    hasLiveRuns,
  };
}
