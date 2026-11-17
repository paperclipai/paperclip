import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { LINK_PREVIEW_BATCH_LIMIT } from "@paperclipai/shared";
import { createLinkPreviewStore } from "../services/link-preview-store.js";
import { badRequest, tooManyRequests } from "../errors.js";
import { createInviteRateLimiter, type InviteRateLimiter } from "../services/invite-rate-limit.js";
import { assertBoard, assertCompanyAccess } from "./authz.js";
import { createLinkPreviewService } from "../services/link-previews.js";
import { createGitHubLinkPreviewProvider } from "../services/github-link-preview.js";

export function linkPreviewRoutes(db: Db, service = createLinkPreviewService([createGitHubLinkPreviewProvider(db)], { store: createLinkPreviewStore(db) }),
  limiter: InviteRateLimiter = createInviteRateLimiter({ maxRequests: 600 })) {
  const router = Router();
  router.get("/companies/:companyId/link-preview", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    assertBoard(req);
    const href = req.query.url;
    if (typeof href !== "string" || href.length > 2048) throw badRequest("A link URL is required");
    // Personal repository metadata must never be stored by a proxy or shared browser cache.
    res.set("Cache-Control", "private, no-store");
    const limit = limiter.consume(JSON.stringify([companyId, req.actor.userId ?? null]));
    res.set("X-RateLimit-Limit", String(limit.limit));
    res.set("X-RateLimit-Remaining", String(limit.remaining));
    if (!limit.allowed) {
      res.set("Retry-After", String(limit.retryAfterSeconds));
      throw tooManyRequests("Link preview rate limit exceeded");
    }
    res.json(await service.get({ companyId, userId: req.actor.userId ?? null }, href));
  });
  // Read-only batch: page hydration never waits for a remote provider.
  router.get("/companies/:companyId/link-previews/cached", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    assertBoard(req);
    const urls = typeof req.query.url === "string" ? [req.query.url] : req.query.url;
    if (!Array.isArray(urls) || !urls.length || urls.length > LINK_PREVIEW_BATCH_LIMIT
      || urls.some(url => typeof url !== "string" || url.length > 2048)) throw badRequest("A bounded list of link URLs is required");
    res.set("Cache-Control", "private, no-store");
    res.json(await service.cached({ companyId, userId: req.actor.userId ?? null }, urls as string[]));
  });
  return router;
}
