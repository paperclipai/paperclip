import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { approvals, heartbeatRuns, joinRequests as joinRequestsTable } from "@paperclipai/db";
import type { BoardBrief, SidebarBadges } from "@paperclipai/shared";

const ACTIONABLE_APPROVAL_STATUSES = ["pending", "revision_requested"];
const FAILED_RUN_STATUSES = ["failed", "timed_out"];

export function sidebarBadgeService(db: Db) {
  return {
    get: async (
      companyId: string,
      brief: BoardBrief,
      extra?: { canApproveJoins?: boolean; unreadTouchedIssues?: number },
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

      const canApproveJoins = extra?.canApproveJoins ?? false;
      const joinRequests = canApproveJoins
        ? await db
          .select({ count: sql<number>`count(*)` })
          .from(joinRequestsTable)
          .where(and(eq(joinRequestsTable.companyId, companyId), eq(joinRequestsTable.status, "pending_approval")))
          .then((rows) => Number(rows[0]?.count ?? 0))
        : 0;
      const latestRunsByAgent = await db
        .selectDistinctOn([heartbeatRuns.agentId], {
          agentId: heartbeatRuns.agentId,
          status: heartbeatRuns.status,
        })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.companyId, companyId))
        .orderBy(heartbeatRuns.agentId, desc(heartbeatRuns.createdAt));
      const failedRuns = latestRunsByAgent.filter((run) => FAILED_RUN_STATUSES.includes(run.status)).length;
      const unreadTouchedIssues = extra?.unreadTouchedIssues ?? 0;
      const criticalIncidents = brief.incidents.filter((incident) => incident.severity === "critical").length;
      return {
        inbox: actionableApprovals + failedRuns + joinRequests + criticalIncidents + unreadTouchedIssues,
        approvals: actionableApprovals,
        failedRuns,
        joinRequests,
      };
    },
  };
}
