import type { Db } from "@paperclipai/db";
import { createWeeklyReviewRecommendationActionSchema, generateWeeklyReviewSchema } from "@paperclipai/shared";
import { Router } from "express";

import { validate } from "../middleware/validate.js";
import { weeklyReviewGenerationService } from "../services/weekly-review/generation.js";
import { assertBoard, assertCompanyAccess, getActorInfo } from "./authz.js";

export function weeklyReviewRoutes(db: Db) {
  const router = Router();
  const service = weeklyReviewGenerationService(db);

  router.get("/companies/:companyId/weekly-reviews", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertBoard(req);
    assertCompanyAccess(req, companyId);
    res.json(await service.listForCompany(companyId));
  });

  router.post(
    "/companies/:companyId/weekly-reviews/generate",
    validate(generateWeeklyReviewSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertBoard(req);
      assertCompanyAccess(req, companyId);
      const actor = getActorInfo(req);

      res.json(
        await service.generateForCompany(companyId, {
          periodStart: new Date(req.body.periodStart),
          periodEnd: new Date(req.body.periodEnd),
          previousVersionId: req.body.previousVersionId,
          actorUserId: actor.actorType === "user" ? actor.actorId : null,
        }),
      );
    },
  );

  router.get("/weekly-reviews/:reviewId", async (req, res) => {
    assertBoard(req);
    const context = await service.getReviewAccessContext(req.params.reviewId as string);
    assertCompanyAccess(req, context.companyId);
    const payload = await service.getReview(req.params.reviewId as string, { companyId: context.companyId });
    res.json(payload);
  });

  router.post("/weekly-reviews/:reviewId/refresh", async (req, res) => {
    assertBoard(req);
    const reviewId = req.params.reviewId as string;
    const context = await service.getReviewAccessContext(reviewId);
    assertCompanyAccess(req, context.companyId);
    const actor = getActorInfo(req);
    res.json(
      await service.refresh(reviewId, {
        actorUserId: actor.actorType === "user" ? actor.actorId : null,
      }),
    );
  });

  router.get("/weekly-reviews/:reviewId/readiness", async (req, res) => {
    assertBoard(req);
    const reviewId = req.params.reviewId as string;
    const context = await service.getReviewAccessContext(reviewId);
    assertCompanyAccess(req, context.companyId);
    res.json(await service.getReadiness(reviewId));
  });

  router.get("/weekly-review-versions/:versionId", async (req, res) => {
    assertBoard(req);
    const context = await service.getVersionAccessContext(req.params.versionId as string);
    assertCompanyAccess(req, context.companyId);
    const payload = await service.getVersion(req.params.versionId as string, { companyId: context.companyId });
    res.json(payload);
  });

  router.post(
    "/weekly-review-recommendations/:recommendationId/actions",
    validate(createWeeklyReviewRecommendationActionSchema),
    async (req, res) => {
      assertBoard(req);
      const recommendationId = req.params.recommendationId as string;
      const context = await service.getRecommendationActionContext(recommendationId);
      assertCompanyAccess(req, context.companyId);
      const actor = getActorInfo(req);
      const payload = await service.createRecommendationAction(recommendationId, req.body, actor);
      assertCompanyAccess(req, payload.action.companyId);
      res.json(payload);
    },
  );

  return router;
}
