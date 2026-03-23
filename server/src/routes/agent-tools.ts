import { Router } from "express";
import { agentMetricsService } from "../services/agent-metrics.js";
import type { Db } from "@paperclipai/db";

export function agentToolRoutes(db: Db) {
  const router = Router();
  const metrics = agentMetricsService(db);

  router.get("/companies/:companyId/agent-tools/metrics", async (req, res) => {
    res.json(await metrics.getMetrics(req.params.companyId));
  });

  router.get("/companies/:companyId/agent-tools/active-mission", async (req, res) => {
    res.json(await metrics.getActiveMission(req.params.companyId));
  });

  router.post("/companies/:companyId/agent-tools/propose-action", async (req, res) => {
    const { actionType, description, impactSummary, missionId } = req.body;
    const result = await metrics.proposeAction(req.params.companyId, missionId, {
      actionType, description, impactSummary,
    });
    res.json(result);
  });

  return router;
}
