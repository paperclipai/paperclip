import { and, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { approvals } from "@paperclipai/db";
import type { BoardBrief, SidebarBadges } from "@paperclipai/shared";

const ACTIONABLE_APPROVAL_STATUSES = ["pending", "revision_requested"];

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
      const visibleActionQueue = brief.actionQueue.filter((item) =>
        canApproveJoins || item.kind !== "join_request"
      );
      const failedRuns = visibleActionQueue.filter((item) => item.kind === "run").length;
      const joinRequests = canApproveJoins
        ? visibleActionQueue.filter((item) => item.kind === "join_request").length
        : 0;
      const unreadTouchedIssues = extra?.unreadTouchedIssues ?? 0;
      const criticalIncidents = brief.incidents.filter((incident) => incident.severity === "critical").length;
      return {
        inbox: visibleActionQueue.length + criticalIncidents + unreadTouchedIssues,
        approvals: actionableApprovals,
        failedRuns,
        joinRequests,
      };
    },
  };
}
