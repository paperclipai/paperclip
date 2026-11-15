import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { badRequest } from "../errors.js";
import { assertBoard, assertCompanyAccess } from "./authz.js";
import { createLinkPreviewService } from "../services/link-previews.js";
import { createGitHubLinkPreviewProvider } from "../services/github-link-preview.js";

export function linkPreviewRoutes(db: Db, service = createLinkPreviewService([createGitHubLinkPreviewProvider(db)])) {
  const router = Router();
  router.get("/companies/:companyId/link-preview", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    assertBoard(req);
    const href = req.query.url;
    if (typeof href !== "string" || href.length > 2048) throw badRequest("A link URL is required");
    // Personal repository metadata must never be stored by a proxy or shared browser cache.
    res.set("Cache-Control", "private, no-store");
    res.json(await service.get({ companyId, userId: req.actor.userId ?? null }, href));
  });
  return router;
}
