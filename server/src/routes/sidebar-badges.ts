import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { and, eq } from "drizzle-orm";
import { inboxDismissals, joinRequests } from "@paperclipai/db";
import { sidebarBadgeService } from "../services/sidebar-badges.js";
import { accessService } from "../services/access.js";
import { dashboardService } from "../services/dashboard.js";
import { assertCompanyAccess } from "./authz.js";

function buildDismissedAtByKey(
  dismissals: Array<{ itemKey: string; dismissedAt: Date | string }>,
): Map<string, number> {
  return new Map(
    dismissals.map((dismissal) => [dismissal.itemKey, new Date(dismissal.dismissedAt).getTime()]),
  );
}

export function sidebarBadgeRoutes(db: Db) {
  const router = Router();
  const svc = sidebarBadgeService(db);
  const access = accessService(db);
  const dashboard = dashboardService(db);

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

    const visibleJoinRequests = canApproveJoins
      ? await db
        .select({
          id: joinRequests.id,
          updatedAt: joinRequests.updatedAt,
          createdAt: joinRequests.createdAt,
        })
        .from(joinRequests)
        .where(and(eq(joinRequests.companyId, companyId), eq(joinRequests.status, "pending_approval")))
      : [];

    const dismissedAtByKey =
      req.actor.type === "board" && req.actor.userId
        ? await db
          .select({ itemKey: inboxDismissals.itemKey, dismissedAt: inboxDismissals.dismissedAt })
          .from(inboxDismissals)
          .where(and(eq(inboxDismissals.companyId, companyId), eq(inboxDismissals.userId, req.actor.userId)))
          .then(buildDismissedAtByKey)
        : new Map<string, number>();

    const badges = await svc.get(companyId, {
      dismissals: dismissedAtByKey,
      joinRequests: visibleJoinRequests,
    });
    const summary = await dashboard.summary(companyId);
    const hasFailedRuns = badges.failedRuns > 0;
    const alertsCount =
      (summary.agents.error > 0 && !hasFailedRuns ? 1 : 0) +
      (summary.costs.monthBudgetCents > 0 && summary.costs.monthUtilizationPercent >= 80 ? 1 : 0);
    badges.inbox = badges.failedRuns + alertsCount + badges.joinRequests + badges.approvals;

    res.json(badges);
  });

  return router;
}
