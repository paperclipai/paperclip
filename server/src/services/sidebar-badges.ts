import { and, desc, eq, inArray, not, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, approvals, heartbeatRuns, issues } from "@paperclipai/db";
import type { SidebarBadges } from "@paperclipai/shared";

const ACTIONABLE_APPROVAL_STATUSES = ["pending", "revision_requested"];
const FAILED_HEARTBEAT_STATUSES = ["failed", "timed_out"];
const RUNNABLE_STATUSES = ["todo", "in_progress"];
const NON_RUNNABLE_STATUSES = ["backlog", "blocked"];

export function sidebarBadgeService(db: Db) {
  return {
    get: async (
      companyId: string,
      extra?: { joinRequests?: number; unreadTouchedIssues?: number },
    ): Promise<SidebarBadges> => {
      const actionableApprovals = await db
        .select({ count: sql<number>`count(*)` })
        .from(approvals)
        .where(
          and(
            eq(approvals.companyId, companyId),
            inArray(approvals.status, ACTIONABLE_APPROVAL_STATUSES),
          ),
        )
        .then((rows) => Number(rows[0]?.count ?? 0));

      const latestRunByAgent = await db
        .selectDistinctOn([heartbeatRuns.agentId], {
          runStatus: heartbeatRuns.status,
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
        FAILED_HEARTBEAT_STATUSES.includes(row.runStatus),
      ).length;

      // Detect starved agents: agents with 0 runnable issues but with backlog/blocked work
      const activeAgentIds = await db
        .select({ id: agents.id })
        .from(agents)
        .where(
          and(
            eq(agents.companyId, companyId),
            not(eq(agents.status, "terminated")),
          ),
        )
        .then((rows) => rows.map((r) => r.id));

      let starvedAgents = 0;
      if (activeAgentIds.length > 0) {
        const runnableCounts = await db
          .select({
            agentId: issues.assigneeAgentId,
            count: sql<number>`count(*)`,
          })
          .from(issues)
          .where(
            and(
              eq(issues.companyId, companyId),
              inArray(issues.assigneeAgentId, activeAgentIds),
              inArray(issues.status, RUNNABLE_STATUSES),
            ),
          )
          .groupBy(issues.assigneeAgentId);

        const runnableByAgent = new Set(
          runnableCounts
            .filter((r) => Number(r.count) > 0)
            .map((r) => r.agentId),
        );

        const starvedIds = activeAgentIds.filter(
          (id) => !runnableByAgent.has(id),
        );

        if (starvedIds.length > 0) {
          const nonRunnableCount = await db
            .select({ count: sql<number>`count(distinct ${issues.assigneeAgentId})` })
            .from(issues)
            .where(
              and(
                eq(issues.companyId, companyId),
                inArray(issues.assigneeAgentId, starvedIds),
                inArray(issues.status, NON_RUNNABLE_STATUSES),
              ),
            )
            .then((rows) => Number(rows[0]?.count ?? 0));

          starvedAgents = nonRunnableCount;
        }
      }

      const joinRequests = extra?.joinRequests ?? 0;
      const unreadTouchedIssues = extra?.unreadTouchedIssues ?? 0;
      return {
        inbox: actionableApprovals + failedRuns + joinRequests + unreadTouchedIssues + starvedAgents,
        approvals: actionableApprovals,
        failedRuns,
        joinRequests,
        starvedAgents,
      };
    },
  };
}
