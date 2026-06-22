import { and, desc, eq, inArray, isNull, not, notInArray } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, approvals, heartbeatRuns, issueThreadInteractions, issues } from "@paperclipai/db";
import { AWAITING_HUMAN_INTERACTION_KINDS } from "@paperclipai/shared";
import type { SidebarBadges } from "@paperclipai/shared";

const ACTIONABLE_APPROVAL_STATUSES = ["pending", "revision_requested"];
const FAILED_HEARTBEAT_STATUSES = ["failed", "timed_out"];
// Issue statuses on which a pending interaction is no longer actionable by a human.
const TERMINAL_ISSUE_STATUSES = ["done", "cancelled"];

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

      const joinRequests = (extra?.joinRequests ?? []).filter((row) =>
        !isDismissed(
          extra?.dismissals ?? new Map(),
          `join:${row.id}`,
          row.updatedAt ?? row.createdAt,
        )
      ).length;
      const unreadTouchedIssues = extra?.unreadTouchedIssues ?? 0;

      // Pending agent->human asks (confirmations, questions, task suggestions) that pause an
      // issue in In Review. Without this they generate no inbox signal and strand silently.
      // Counted per issue (not per interaction) so an issue with several pending asks reads as
      // one item — matching the grouped "Waiting on you" row in the Inbox.
      const awaitingHuman = await db
        .select({
          id: issueThreadInteractions.id,
          issueId: issueThreadInteractions.issueId,
          updatedAt: issueThreadInteractions.updatedAt,
        })
        .from(issueThreadInteractions)
        .innerJoin(issues, eq(issueThreadInteractions.issueId, issues.id))
        .where(
          and(
            eq(issueThreadInteractions.companyId, companyId),
            eq(issueThreadInteractions.status, "pending"),
            inArray(issueThreadInteractions.kind, [...AWAITING_HUMAN_INTERACTION_KINDS]),
            isNull(issues.hiddenAt),
            notInArray(issues.status, TERMINAL_ISSUE_STATUSES),
          ),
        )
        .then((rows) => {
          const issueIds = new Set<string>();
          for (const row of rows) {
            if (isDismissed(extra?.dismissals ?? new Map(), `interaction:${row.id}`, row.updatedAt)) continue;
            issueIds.add(row.issueId);
          }
          return issueIds.size;
        });

      return {
        inbox: actionableApprovals + failedRuns + joinRequests + unreadTouchedIssues + awaitingHuman,
        approvals: actionableApprovals,
        failedRuns,
        joinRequests,
        awaitingHuman,
      };
    },
  };
}
