import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { triggerBriefingQualityClassificationSchema, type FlightCrewBriefing } from "@paperclipai/shared";
import { validate } from "../middleware/validate.js";
import { briefingQualityService } from "../services/index.js";

export function briefingQualityRoutes(db: Db) {
  const router = Router();
  const svc = briefingQualityService(db);

  router.post("/classify", validate(triggerBriefingQualityClassificationSchema), async (req, res) => {
    const { briefingId, briefing } = req.body as {
      briefingId: string;
      briefing: FlightCrewBriefing;
    };
    const result = await svc.classifyAndStore(briefingId, briefing);
    res.json(result);
  });

  router.get("/:briefingId", async (req, res) => {
    const { briefingId } = req.params;
    const result = await svc.getByBriefingId(briefingId);
    if (!result) {
      res.status(404).json({ error: "Quality classification not found for this briefing" });
      return;
    }
    res.json(result);
  });

  router.get("/summary/all", async (_req, res) => {
    const summary = await svc.getSummary();
    res.json(summary);
  });

  return router;
}
