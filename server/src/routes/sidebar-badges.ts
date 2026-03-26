import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { and, eq, sql } from "drizzle-orm";
import { joinRequests } from "@paperclipai/db";
import {
  computeSidebarAlertsCount,
  computeSidebarInboxCount,
  sidebarBadgeService,
} from "../services/sidebar-badges.js";
import { inboxDismissalService } from "../services/inbox-dismissals.js";
import { chatReadStateService } from "../services/chat-read-states.js";
import { accessService } from "../services/access.js";
import { dashboardService } from "../services/dashboard.js";
import { issueService } from "../services/issues.js";
import { assertCompanyAccess } from "./authz.js";

export function sidebarBadgeRoutes(db: Db) {
  const router = Router();
  const svc = sidebarBadgeService(db);
  const access = accessService(db);
  const inboxDismissals = inboxDismissalService(db);
  const chatReadStates = chatReadStateService(db);
  const dashboard = dashboardService(db);
  const issues = issueService(db);
  const INBOX_ISSUE_STATUSES = "backlog,todo,in_progress,in_review,blocked,done";

  router.get("/companies/:companyId/sidebar-badges", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    let canApproveJoins = false;
    if (req.actor.type === "board") {
      canApproveJoins =
        req.actor.source === "local_implicit" ||
        Boolean(req.actor.isInstanceAdmin) ||
        (await access.canUser(companyId, req.actor.userId, "joins:approve"));
    } else if (req.actor.type === "agent" && req.actor.agentId) {
      canApproveJoins = await access.hasPermission(companyId, "agent", req.actor.agentId, "joins:approve");
    }

    const joinRequestCount = canApproveJoins
      ? await db
        .select({ count: sql<number>`count(*)` })
        .from(joinRequests)
        .where(and(eq(joinRequests.companyId, companyId), eq(joinRequests.status, "pending_approval")))
        .then((rows) => Number(rows[0]?.count ?? 0))
      : 0;

    const unreadTouchedIssues =
      req.actor.type === "board" && typeof req.actor.userId === "string"
        ? await issues.countUnreadTouchedByUser(companyId, req.actor.userId, INBOX_ISSUE_STATUSES)
        : 0;

    const dismissedFailedRunIds =
      req.actor.type === "board" && typeof req.actor.userId === "string"
        ? await inboxDismissals.listItemIdsByType(companyId, req.actor.userId, "failed_run")
        : [];

    const dismissedAlertIds =
      req.actor.type === "board" && typeof req.actor.userId === "string"
        ? await inboxDismissals.listItemIdsByType(companyId, req.actor.userId, "alert")
        : [];

    const boardUserId =
      req.actor.type === "board" && typeof req.actor.userId === "string"
        ? req.actor.userId
        : null;

    const [unreadChatSessions, unreadChatByAgent] = boardUserId
      ? await Promise.all([
          chatReadStates.countUnreadSessions(companyId, boardUserId),
          chatReadStates.countUnreadSessionsByAgent(companyId, boardUserId),
        ])
      : [0, {} as Record<string, number>];

    const badges = await svc.get(companyId, {
      joinRequests: joinRequestCount,
      unreadTouchedIssues,
      dismissedFailedRunIds,
      unreadChatSessions,
      unreadChatByAgent,
    });

    const summary = await dashboard.summary(companyId);
    const hasFailedRuns = badges.failedRuns > 0;
    const dismissedAlertIdSet = new Set(dismissedAlertIds);
    const alertsCount = computeSidebarAlertsCount({
      agentErrorCount: summary.agents.error,
      hasFailedRuns,
      monthBudgetCents: summary.costs.monthBudgetCents,
      monthUtilizationPercent: summary.costs.monthUtilizationPercent,
      dismissedAlertItemIds: dismissedAlertIdSet,
    });
    badges.alerts = alertsCount;
    badges.inbox = computeSidebarInboxCount({
      approvals: badges.approvals,
      failedRuns: badges.failedRuns,
      joinRequests: badges.joinRequests,
      unreadTouchedIssues: badges.unreadTouchedIssues,
      alerts: alertsCount,
    });

    res.json(badges);
  });

  return router;
}
