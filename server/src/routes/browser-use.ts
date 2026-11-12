import { Router } from "express";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { issues, type Db } from "@paperclipai/db";
import {
  browserUseControlSchema,
  browserUseSettingsSchema,
  browserUseViewportSchema,
  browserUseViewerSchema,
} from "@paperclipai/shared";
import {
  assertBoard,
  assertCompanyAccess,
  getActorInfo,
  getAccessibleResource,
} from "./authz.js";
import { browserUseService } from "../services/browser-use.js";

const issueIdSchema = z.string().uuid();

export function browserUseRoutes(db: Db, service = browserUseService(db)) {
  const router = Router();
  router.use("/issues/:issueId/browsers", async (req, res, next) => {
    assertBoard(req);
    if (
      req.params.issueId !== req.params.issueId.trim() ||
      !issueIdSchema.safeParse(req.params.issueId).success
    ) {
      res.status(404).json({ error: "Task not found" });
      return;
    }
    const [issue] = await db
      .select({ companyId: issues.companyId })
      .from(issues)
      .where(eq(issues.id, req.params.issueId))
      .limit(1);
    if (!(await getAccessibleResource(req, res, issue, "Task not found")))
      return;
    res.locals.browserCompanyId = issue.companyId;
    res.setHeader("Cache-Control", "no-store");
    next();
  });
  router.get("/issues/:issueId/browsers", async (req, res) => {
    res.json(
      await service.list(
        res.locals.browserCompanyId,
        req.params.issueId,
        getActorInfo(req).actorId,
      ),
    );
  });
  router.get(
    "/issues/:issueId/browsers/:browserId/viewer",
    async (req, res) => {
      res.setHeader("Referrer-Policy", "no-referrer");
      res.json(
        await service.viewer(
          res.locals.browserCompanyId,
          req.params.issueId,
          req.params.browserId,
          getActorInfo(req).actorId,
          req.query.viewerId === undefined
            ? undefined
            : browserUseViewerSchema.parse({ viewerId: req.query.viewerId })
                .viewerId,
        ),
      );
    },
  );
  router.post(
    "/issues/:issueId/browsers/:browserId/presence",
    async (req, res) => {
      res.json(
        await service.presence(
          res.locals.browserCompanyId,
          req.params.issueId,
          req.params.browserId,
          getActorInfo(req).actorId,
        ),
      );
    },
  );
  router.post(
    "/issues/:issueId/browsers/:browserId/viewport",
    async (req, res) => {
      const viewport = browserUseViewportSchema.parse(req.body);
      res.json(
        await service.resize(
          res.locals.browserCompanyId,
          req.params.issueId,
          req.params.browserId,
          getActorInfo(req).actorId,
          viewport,
        ),
      );
    },
  );
  router.post(
    "/issues/:issueId/browsers/:browserId/viewport/release",
    async (req, res) => {
      const { viewerId } = browserUseViewerSchema.parse(req.body);
      res.json(
        await service.releaseViewport(
          res.locals.browserCompanyId,
          req.params.issueId,
          req.params.browserId,
          getActorInfo(req).actorId,
          viewerId,
        ),
      );
    },
  );
  router.post(
    "/issues/:issueId/browsers/:browserId/control",
    async (req, res) => {
      const { action } = browserUseControlSchema.parse(req.body);
      const { s } = await service.humanSession(
        res.locals.browserCompanyId,
        req.params.issueId,
        req.params.browserId,
        getActorInfo(req).actorId,
      );
      await service.control(s, action, getActorInfo(req).actorId);
      res.json({ accepted: true });
    },
  );
  router.get(
    "/companies/:companyId/browser-use-cloud/grants/:grantId/profiles",
    async (req, res) => {
      assertBoard(req);
      assertCompanyAccess(req, req.params.companyId);
      res.setHeader("Cache-Control", "no-store");
      res.json(
        await service.availableProfiles(
          req.params.companyId,
          req.params.grantId,
          getActorInfo(req).actorId,
        ),
      );
    },
  );
  router.get(
    "/companies/:companyId/browser-use-cloud/grants/:grantId/settings",
    async (req, res) => {
      assertBoard(req);
      assertCompanyAccess(req, req.params.companyId);
      await service.humanGrant(
        req.params.companyId,
        req.params.grantId,
        getActorInfo(req).actorId,
      );
      res.json(
        await service.getSettings(req.params.companyId, req.params.grantId),
      );
    },
  );
  router.put(
    "/companies/:companyId/browser-use-cloud/grants/:grantId/settings",
    async (req, res) => {
      assertBoard(req);
      assertCompanyAccess(req, req.params.companyId);
      res.json(
        await service.saveSettings(
          req.params.companyId,
          req.params.grantId,
          getActorInfo(req).actorId,
          browserUseSettingsSchema.parse(req.body),
        ),
      );
    },
  );
  return router;
}
