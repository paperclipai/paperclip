import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { LINK_PREVIEW_BATCH_LIMIT } from "@paperclipai/shared";
import { createLinkPreviewStore } from "../services/link-preview-store.js";
import { badRequest } from "../errors.js";
import { assertBoard, assertCompanyAccess } from "./authz.js";
import { createLinkPreviewService } from "../services/link-previews.js";
import { createGitHubLinkPreviewProvider } from "../services/github-link-preview.js";

export function linkPreviewRoutes(db: Db, service = createLinkPreviewService([createGitHubLinkPreviewProvider(db)], { store: createLinkPreviewStore(db) })) {
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
  // Read-only batch: page hydration never waits for a remote provider.
  router.post("/companies/:companyId/link-previews/cached", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    assertBoard(req);
    const urls = req.body?.urls;
    if (!Array.isArray(urls) || urls.length > LINK_PREVIEW_BATCH_LIMIT
      || urls.some(url => typeof url !== "string" || url.length > 2048)) throw badRequest("A bounded list of link URLs is required");
    res.set("Cache-Control", "private, no-store");
    res.json(await service.cached({ companyId, userId: req.actor.userId ?? null }, urls));
  });
  return router;
}
