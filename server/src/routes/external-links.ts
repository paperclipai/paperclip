import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { createExternalLinkSchema, lookupExternalLinkQuerySchema } from "@paperclipai/shared";
import { validate } from "../middleware/validate.js";
import { externalLinkService } from "../services/external-links.js";
import { assertCompanyAccess } from "./authz.js";
import { issueService } from "../services/index.js";
import { HttpError } from "../errors.js";

export function externalLinksRoutes(db: Db) {
  const router = Router();
  const svc = externalLinkService(db);
  const issueSvc = issueService(db);

  // Register lookup before /:linkId so "lookup" isn't treated as a uuid param
  router.get("/external-links/lookup", async (req, res) => {
    const parsed = lookupExternalLinkQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      throw new HttpError(400, parsed.error.issues[0]?.message ?? "Invalid query parameters");
    }
    const { platform, externalKey } = parsed.data;
    const link = await svc.lookupByPlatformKey(platform, externalKey);
    assertCompanyAccess(req, link.companyId);
    res.json(link);
  });

  router.delete("/external-links/:linkId", async (req, res) => {
    const linkId = req.params.linkId as string;
    const link = await svc.getById(linkId);
    assertCompanyAccess(req, link.companyId);
    await svc.deleteById(linkId);
    res.status(204).end();
  });

  router.post(
    "/issues/:issueId/external-links",
    validate(createExternalLinkSchema),
    async (req, res) => {
      const issueId = req.params.issueId as string;
      const issue = await issueSvc.getById(issueId);
      if (!issue) {
        res.status(404).json({ error: "Issue not found" });
        return;
      }
      assertCompanyAccess(req, issue.companyId);
      const link = await svc.create(issueId, req.body);
      res.status(201).json(link);
    },
  );

  router.get("/issues/:issueId/external-links", async (req, res) => {
    const issueId = req.params.issueId as string;
    const issue = await issueSvc.getById(issueId);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    assertCompanyAccess(req, issue.companyId);
    const links = await svc.listForIssue(issueId);
    res.json(links);
  });

  return router;
}
