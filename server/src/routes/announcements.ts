import { Router } from "express";
import { eq } from "drizzle-orm";
import { companies, type Db } from "@paperclipai/db";
import { ANNOUNCEMENT_ANIMATION_CSP, announcementIdSchema, dismissAnnouncementSchema } from "@paperclipai/shared";
import { badRequest, forbidden, notFound } from "../errors.js";
import { validate } from "../middleware/validate.js";
import { assertAuthenticated, assertBoard, hasCompanyAccess } from "./authz.js";
import { announcementService } from "../services/announcements.js";
import { announcementFeedService, type AnnouncementFeedOptions } from "../services/announcement-feed.js";

export function announcementRoutes(db: Db, options: AnnouncementFeedOptions) {
  const router = Router();
  const feed = announcementFeedService(options);
  const service = announcementService(db);
  router.use("/announcements", (req, res, next) => {
    assertAuthenticated(req);
    assertBoard(req);
    if (!req.actor.userId) throw forbidden("Board user context required");
    res.setHeader("Cache-Control", "private, no-store");
    next();
  });
  router.get("/announcements/current", async (req, res) => {
    const announcement = await feed.current();
    if (announcement) await service.registerPublication(announcement.id);
    res.json(announcement && !await service.isDismissed(req.actor.userId!, announcement.id) ? announcement : null);
  });
  router.get("/announcements/:id/image", async (req, res) => {
    const id = announcementIdSchema.safeParse(req.params.id);
    if (!id.success) throw badRequest("Invalid announcement ID");
    const image = await feed.image(id.data);
    if (!image) throw notFound("Announcement image unavailable");
    res.setHeader("Content-Type", image.contentType);
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.send(image.bytes);
  });
  router.get("/announcements/:id/animation", async (req, res) => {
    const id = announcementIdSchema.safeParse(req.params.id);
    if (!id.success) throw badRequest("Invalid announcement ID");
    const animation = await feed.animation(id.data);
    if (!animation) throw notFound("Announcement animation unavailable");
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Content-Security-Policy", `sandbox; ${ANNOUNCEMENT_ANIMATION_CSP}`);
    res.setHeader("Referrer-Policy", "no-referrer");
    res.send(animation.bytes);
  });
  router.post("/announcements/:id/dismiss", validate(dismissAnnouncementSchema), async (req, res) => {
    const id = announcementIdSchema.safeParse(req.params.id);
    if (!id.success) throw badRequest("Invalid announcement ID");
    const { companyId } = req.body;
    // This writes the caller's personal preference. Viewers may dismiss it;
    // company read membership supplies audit context, not write authority.
    if (!hasCompanyAccess(req, companyId)) throw notFound("Company not found");
    if (!await db.query.companies.findFirst({ where: eq(companies.id, companyId), columns: { id: true } })) {
      throw notFound("Company not found");
    }
    if (!await service.dismiss(req.actor.userId!, id.data, companyId)) throw notFound("Announcement not found");
    res.status(204).end();
  });
  return router;
}
