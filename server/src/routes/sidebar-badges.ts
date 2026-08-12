import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { and, eq } from "drizzle-orm";
import { inboxDismissals, joinRequests } from "@paperclipai/db";
import { sidebarBadgeService } from "../services/sidebar-badges.js";
import { accessService } from "../services/access.js";
import { dashboardService } from "../services/dashboard.js";
import { collapseDuplicatePendingHumanJoinRequests } from "../lib/join-request-dedupe.js";
import { assertCompanyAccess } from "./authz.js";

function buildDismissedAtByKey(
  dismissals: Array<{ itemKey: string; kind: string; dismissedAt: Date | string; snoozedUntil: Date | string | null }>,
): Map<string, number> {
  const now = Date.now();
  const entries: Array<[string, number]> = [];
  for (const dismissal of dismissals) {
    if (dismissal.kind === "snooze") {
      const snoozedUntil = dismissal.snoozedUntil ? new Date(dismissal.snoozedUntil).getTime() : 0;
      if (Number.isFinite(snoozedUntil) && snoozedUntil > now) entries.push([dismissal.itemKey, Number.MAX_SAFE_INTEGER]);
      continue;
    }
    entries.push([dismissal.itemKey, new Date(dismissal.dismissedAt).getTime()]);
  }
  return new Map(entries);
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
      ? collapseDuplicatePendingHumanJoinRequests(
        await db
          .select({
            id: joinRequests.id,
            requestType: joinRequests.requestType,
            status: joinRequests.status,
            requestingUserId: joinRequests.requestingUserId,
            requestEmailSnapshot: joinRequests.requestEmailSnapshot,
            updatedAt: joinRequests.updatedAt,
            createdAt: joinRequests.createdAt,
          })
          .from(joinRequests)
          .where(and(eq(joinRequests.companyId, companyId), eq(joinRequests.status, "pending_approval")))
      ).map(({ id, updatedAt, createdAt }) => ({
        id,
        updatedAt,
        createdAt,
      }))
      : [];

    const dismissedAtByKey =
      req.actor.type === "board" && req.actor.userId
        ? await db
          .select({
            itemKey: inboxDismissals.itemKey,
            kind: inboxDismissals.kind,
            dismissedAt: inboxDismissals.dismissedAt,
            snoozedUntil: inboxDismissals.snoozedUntil,
          })
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
