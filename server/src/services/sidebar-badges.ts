import { and, desc, eq, inArray, isNull, not, or, sql, type SQL } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, approvals, heartbeatRuns } from "@paperclipai/db";
import type { SidebarBadges } from "@paperclipai/shared";
import { authorizationService, type AuthorizationActor } from "./authorization.js";
import { getHeartbeatRunReadDecisions } from "./heartbeat-run-privacy.js";

const ACTIONABLE_APPROVAL_STATUSES = ["pending", "revision_requested"];

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
  const authorization = authorizationService(db);
  return {
    get: async (
      companyId: string,
      extra?: {
        currentUserId?: string | null;
        dismissals?: ReadonlyMap<string, number>;
        joinRequests?: Array<{ id: string; updatedAt: Date | string | null; createdAt: Date | string }>;
        unreadTouchedIssues?: number;
        approvalReadCondition?: SQL<boolean>;
        actor?: AuthorizationActor;
      },
    ): Promise<SidebarBadges> => {
      const actionableApprovals = await db
        .select({ id: approvals.id, updatedAt: approvals.updatedAt })
        .from(approvals)
        .where(
          and(
            eq(approvals.companyId, companyId),
            inArray(approvals.status, ACTIONABLE_APPROVAL_STATUSES),
            extra?.approvalReadCondition,
          ),
        )
        .then((rows) =>
          rows.filter((row) => !isDismissed(extra?.dismissals ?? new Map(), `approval:${row.id}`, row.updatedAt)).length
        );

      const recentRuns = db
        .select({
          id: heartbeatRuns.id,
          agentId: heartbeatRuns.agentId,
          scopeKind: heartbeatRuns.scopeKind,
          issueId: heartbeatRuns.issueId,
          status: heartbeatRuns.status,
          responsibleUserId: heartbeatRuns.responsibleUserId,
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
        .orderBy(desc(heartbeatRuns.createdAt))
        .limit(200)
        .as("recent_runs");

      const observedRuns = db.select({
        id: recentRuns.id,
        agentId: recentRuns.agentId,
        scopeKind: recentRuns.scopeKind,
        issueId: recentRuns.issueId,
        status: recentRuns.status,
        responsibleUserId: recentRuns.responsibleUserId,
        createdAt: recentRuns.createdAt,
        observedOrder: sql<number>`row_number() over ()`.as("observed_order"),
      }).from(recentRuns).as("observed_runs");
      const rankedRuns = db.select({
        id: observedRuns.id,
        scopeKind: observedRuns.scopeKind,
        issueId: observedRuns.issueId,
        status: observedRuns.status,
        responsibleUserId: observedRuns.responsibleUserId,
        createdAt: observedRuns.createdAt,
        agentRunRank: sql<number>`row_number() over (partition by ${observedRuns.agentId} order by ${observedRuns.createdAt} desc, ${observedRuns.observedOrder})`.as("agent_run_rank"),
      }).from(observedRuns).as("ranked_runs");
      const mineCondition = extra?.currentUserId === undefined
        ? undefined
        : !extra.currentUserId
          ? sql<boolean>`false`
          : extra.currentUserId === "local-board"
            ? or(eq(rankedRuns.responsibleUserId, "local-board"), isNull(rankedRuns.responsibleUserId), eq(rankedRuns.responsibleUserId, ""))
            : eq(rankedRuns.responsibleUserId, extra.currentUserId);
      const candidates = await db.select({
        id: rankedRuns.id,
        scopeKind: rankedRuns.scopeKind,
        issueId: rankedRuns.issueId,
        createdAt: rankedRuns.createdAt,
      }).from(rankedRuns).where(and(
        eq(rankedRuns.agentRunRank, 1),
        inArray(rankedRuns.status, ["failed", "timed_out"]),
        mineCondition,
      ));
      const failures = candidates.filter((row) =>
        !isDismissed(extra?.dismissals ?? new Map(), `run:${row.id}`, row.createdAt),
      );
      const failedRuns = extra?.actor
        ? (await getHeartbeatRunReadDecisions(db, authorization, extra.actor, failures.map((row) => ({ ...row, companyId })))).filter(Boolean).length
        : failures.length;

      const joinRequests = (extra?.joinRequests ?? []).filter((row) =>
        !isDismissed(
          extra?.dismissals ?? new Map(),
          `join:${row.id}`,
          row.updatedAt ?? row.createdAt,
        )
      ).length;
      const unreadTouchedIssues = extra?.unreadTouchedIssues ?? 0;
      return {
        inbox: actionableApprovals + failedRuns + joinRequests + unreadTouchedIssues,
        approvals: actionableApprovals,
        failedRuns,
        joinRequests,
      };
    },
  };
}
