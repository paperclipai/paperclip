import { and, desc, eq, gte, inArray, isNotNull, not, sql } from "drizzle-orm";
import type { Db } from "@ironworksai/db";
import { agents, approvals, heartbeatRuns, knowledgePages } from "@ironworksai/db";
import type { SidebarBadges } from "@ironworksai/shared";
import { DELIVERABLE_DOCUMENT_TYPES } from "@ironworksai/shared";

const ACTIONABLE_APPROVAL_STATUSES = ["pending", "revision_requested"];
const FAILED_HEARTBEAT_STATUSES = ["failed", "timed_out"];

export function sidebarBadgeService(db: Db) {
  return {
    get: async (
      companyId: string,
      extra?: { joinRequests?: number; unreadTouchedIssues?: number },
    ): Promise<SidebarBadges> => {
      const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

      // Run all three badge queries in parallel (was sequential)
      const [actionableApprovals, latestRunByAgent, deliverablesReview] = await Promise.all([
        db
          .select({ count: sql<number>`count(*)` })
          .from(approvals)
          .where(
            and(
              eq(approvals.companyId, companyId),
              inArray(approvals.status, ACTIONABLE_APPROVAL_STATUSES),
            ),
          )
          .then((rows) => Number(rows[0]?.count ?? 0)),

        db
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
              gte(heartbeatRuns.createdAt, thirtyDaysAgo),
            ),
          )
          .orderBy(heartbeatRuns.agentId, desc(heartbeatRuns.createdAt)),

        db
          .select({ count: sql<number>`count(*)` })
          .from(knowledgePages)
          .where(
            and(
              eq(knowledgePages.companyId, companyId),
              eq(knowledgePages.deliverableStatus, "review"),
              isNotNull(knowledgePages.documentType),
              inArray(knowledgePages.documentType, [...DELIVERABLE_DOCUMENT_TYPES]),
            ),
          )
          .then((rows) => Number(rows[0]?.count ?? 0)),
      ]);

      const failedRuns = latestRunByAgent.filter((row) =>
        FAILED_HEARTBEAT_STATUSES.includes(row.runStatus),
      ).length;

      const joinRequests = extra?.joinRequests ?? 0;
      const unreadTouchedIssues = extra?.unreadTouchedIssues ?? 0;
      return {
        inbox: actionableApprovals + failedRuns + joinRequests + unreadTouchedIssues,
        approvals: actionableApprovals,
        failedRuns,
        joinRequests,
        deliverablesReview,
      };
    },
  };
}
