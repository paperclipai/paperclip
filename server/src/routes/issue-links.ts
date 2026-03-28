import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { createIssueLinkSchema } from "@paperclipai/shared";
import { validate } from "../middleware/validate.js";
import { issueLinkService, logActivity } from "../services/index.js";
import { assertCompanyAccess, getActorInfo } from "./authz.js";
import { issueService } from "../services/index.js";

export function issueLinkRoutes(db: Db) {
  const router = Router();
  const svc = issueLinkService(db);
  const issueSvc = issueService(db);

  // GET /api/issues/:issueId/links — List all links for an issue
  router.get("/issues/:issueId/links", async (req, res) => {
    const { issueId } = req.params;
    const issue = await issueSvc.getById(issueId as string);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    assertCompanyAccess(req, issue.companyId);
    const links = await svc.listForIssue(issueId as string);
    res.json(links);
  });

  // POST /api/issues/:issueId/links — Create a link from this issue to a target
  router.post(
    "/issues/:issueId/links",
    validate(createIssueLinkSchema),
    async (req, res) => {
      const { issueId } = req.params;
      const issue = await issueSvc.getById(issueId as string);
      if (!issue) {
        res.status(404).json({ error: "Issue not found" });
        return;
      }
      assertCompanyAccess(req, issue.companyId);

      const actor = getActorInfo(req);
      const link = await svc.create(
        issueId as string,
        req.body,
        { agentId: actor.agentId, userId: actor.actorType === "user" ? actor.actorId : null },
      );

      await logActivity(db, {
        companyId: issue.companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: "issue_link.created",
        entityType: "issue_link",
        entityId: link!.id,
        details: {
          sourceId: issueId,
          targetId: req.body.targetId,
          linkType: req.body.linkType ?? "triggers",
        },
      });

      res.status(201).json(link);
    },
  );

  // DELETE /api/issue-links/:linkId — Remove a link
  router.delete("/issue-links/:linkId", async (req, res) => {
    const { linkId } = req.params;
    const link = await svc.getById(linkId as string);
    if (!link) {
      res.status(404).json({ error: "Issue link not found" });
      return;
    }
    assertCompanyAccess(req, link.companyId);

    const removed = await svc.remove(linkId as string);
    const actor = getActorInfo(req);

    await logActivity(db, {
      companyId: link.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "issue_link.deleted",
      entityType: "issue_link",
      entityId: link.id,
      details: {
        sourceId: link.sourceId,
        targetId: link.targetId,
        linkType: link.linkType,
      },
    });

    res.json(removed);
  });

  return router;
}
