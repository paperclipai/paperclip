import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { qualityService } from "../services/index.js";

export function qualityRoutes(db: Db) {
  const router = Router();
  const svc = qualityService(db);

  router.get("/scorecards", async (_req, res) => {
    const scorecard = await svc.getScorecard();
    res.json(scorecard);
  });

  router.get("/escalations", async (req, res) => {
    const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : 50;
    const escalations = await svc.getEscalations(limit);
    res.json(escalations);
  });

  router.get("/metrics", async (req, res) => {
    const days = req.query.days ? parseInt(req.query.days as string, 10) : 30;
    const metrics = await svc.getMetrics(days);
    res.json(metrics);
  });

  router.get("/crew-scores", async (_req, res) => {
    const scores = await svc.getCrewScores();
    res.json(scores);
  });

  router.get("/gate-pass-rates", async (_req, res) => {
    const rates = await svc.getGatePassRates();
    res.json(rates);
  });

  return router;
}
