import { and, desc, eq, gte, inArray, not, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, approvals, companies, costEvents, heartbeatRuns } from "@paperclipai/db";
import type { SidebarBadges } from "@paperclipai/shared";

const ACTIONABLE_APPROVAL_STATUSES = ["pending", "revision_requested"];
const FAILED_HEARTBEAT_STATUSES = ["failed", "timed_out"];

function normalizeTimestamp(value: Date | string | null | undefined): number {
  if (!value) return 0;
  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function isDismissed(
  dismissedAtByKey: ReadonlyMap<string, number>,
  itemKey: string,
  activityAt: Date | string | null | undefined,
) {
  const dismissedAt = dismissedAtByKey.get(itemKey);
  if (dismissedAt == null) return false;
  return dismissedAt >= normalizeTimestamp(activityAt);
}

export function sidebarBadgeService(db: Db) {
  return {
    get: async (
      companyId: string,
      extra?: {
        dismissals?: ReadonlyMap<string, number>;
        joinRequests?: Array<{ id: string; updatedAt: Date | string | null; createdAt: Date | string }>;
        unreadTouchedIssues?: number;
      },
    ): Promise<SidebarBadges> => {
      const actionableApprovals = await db
        .select({ id: approvals.id, updatedAt: approvals.updatedAt })
        .from(approvals)
        .where(
          and(
            eq(approvals.companyId, companyId),
            inArray(approvals.status, ACTIONABLE_APPROVAL_STATUSES),
          ),
        )
        .then((rows) =>
          rows.filter((row) => !isDismissed(extra?.dismissals ?? new Map(), `approval:${row.id}`, row.updatedAt)).length
        );

      const latestRunByAgent = await db
        .selectDistinctOn([heartbeatRuns.agentId], {
          id: heartbeatRuns.id,
          runStatus: heartbeatRuns.status,
          createdAt: heartbeatRuns.createdAt,
        })
        .from(heartbeatRuns)
        .innerJoin(agents, eq(heartbeatRuns.agentId, agents.id))
        .where(
          and(
            eq(heartbeatRuns.companyId, companyId),
            eq(agents.companyId, companyId),
            not(eq(agents.status, "terminated")),
          ),
        )
        .orderBy(heartbeatRuns.agentId, desc(heartbeatRuns.createdAt));

      const failedRuns = latestRunByAgent.filter((row) =>
        FAILED_HEARTBEAT_STATUSES.includes(row.runStatus)
        && !isDismissed(extra?.dismissals ?? new Map(), `run:${row.id}`, row.createdAt),
      ).length;
      // Sidebar badges poll frequently, so collect only the two alert inputs
      // instead of loading the full dashboard summary and its 14-day run chart.
      const monthStart = new Date();
      monthStart.setUTCDate(1);
      monthStart.setUTCHours(0, 0, 0, 0);
      const [errorAgentCount, monthBudgetCents, monthSpendCents] = await Promise.all([
        db
          .select({ count: sql<number>`count(*)` })
          .from(agents)
          .where(and(eq(agents.companyId, companyId), eq(agents.status, "error")))
          .then((rows) => Number(rows[0]?.count ?? 0)),
        db
          .select({ monthBudgetCents: companies.budgetMonthlyCents })
          .from(companies)
          .where(eq(companies.id, companyId))
          .then((rows) => Number(rows[0]?.monthBudgetCents ?? 0)),
        db
          .select({
            monthSpendCents: sql<number>`coalesce(sum(${costEvents.costCents}), 0)::double precision`,
          })
          .from(costEvents)
          .where(and(eq(costEvents.companyId, companyId), gte(costEvents.occurredAt, monthStart)))
          .then((rows) => Number(rows[0]?.monthSpendCents ?? 0)),
      ]);
      const monthUtilizationPercent =
        monthBudgetCents > 0 ? Number(((monthSpendCents / monthBudgetCents) * 100).toFixed(2)) : 0;
      const alertsCount =
        (errorAgentCount > 0 && failedRuns === 0 ? 1 : 0) +
        (monthBudgetCents > 0 && monthUtilizationPercent >= 80 ? 1 : 0);

      const joinRequests = (extra?.joinRequests ?? []).filter((row) =>
        !isDismissed(
          extra?.dismissals ?? new Map(),
          `join:${row.id}`,
          row.updatedAt ?? row.createdAt,
        )
      ).length;
      const unreadTouchedIssues = extra?.unreadTouchedIssues ?? 0;
      return {
        inbox: actionableApprovals + failedRuns + joinRequests + unreadTouchedIssues + alertsCount,
        approvals: actionableApprovals,
        failedRuns,
        joinRequests,
      };
    },
  };
}
