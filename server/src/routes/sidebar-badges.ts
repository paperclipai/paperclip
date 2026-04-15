import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { INBOX_MINE_ISSUE_STATUS_FILTER } from "@paperclipai/shared";
import { issueService } from "../services/issues.js";
import { sidebarBadgeService } from "../services/sidebar-badges.js";
import { accessService } from "../services/access.js";
import { boardBriefService } from "../services/board-brief.js";
import { assertCompanyAccess } from "./authz.js";

export function sidebarBadgeRoutes(db: Db) {
  const router = Router();
  const svc = sidebarBadgeService(db);
  const access = accessService(db);
  const briefs = boardBriefService(db);
  const issueContext = issueService(db);

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

    const brief = await briefs.build(companyId);
    const unreadTouchedIssues = req.actor.type === "board" && req.actor.userId
      ? await issueContext.countUnreadTouchedByUser(
        companyId,
        req.actor.userId,
        INBOX_MINE_ISSUE_STATUS_FILTER,
      )
      : 0;
    const badges = await svc.get(companyId, brief, {
      canApproveJoins,
      unreadTouchedIssues,
    });

    res.json(badges);
  });

  return router;
}
