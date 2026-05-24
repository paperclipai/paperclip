import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { submitBriefingFeedbackSchema } from "@paperclipai/shared";
import { validate } from "../middleware/validate.js";
import { briefingFeedbackService, scoreAdjustmentEngine } from "../services/index.js";

export function briefingFeedbackRoutes(db: Db) {
  const router = Router();
  const svc = briefingFeedbackService(db);
  const engine = scoreAdjustmentEngine(db);

  router.post("/briefing", validate(submitBriefingFeedbackSchema), async (req, res) => {
    const feedback = await svc.submit({
      briefingId: req.body.briefingId,
      userId: req.body.userId,
      rating: req.body.rating,
      category: req.body.category ?? null,
      freeText: req.body.freeText ?? null,
    });

    let scoreAdjustment = null;
    try {
      scoreAdjustment = await engine.processRating(
        req.body.briefingId,
        req.body.userId,
        req.body.rating,
      );
    } catch (err) {
      console.warn("[score-adjustment-engine] failed to process rating", err);
    }

    res.status(201).json({ feedback, scoreAdjustment });
  });

  router.get("/briefing", async (req, res) => {
    const briefingId = req.query.briefingId as string | undefined;
    if (!briefingId) {
      res.status(400).json({ error: "briefingId query parameter is required" });
      return;
    }
    const feedback = await svc.listByBriefing(briefingId);
    res.json(feedback);
  });

  router.get("/briefing/trends", async (_req, res) => {
    const trends = await svc.getTrends();
    res.json(trends);
  });

  return router;
}
