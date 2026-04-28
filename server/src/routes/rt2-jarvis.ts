import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { rt2JarvisService } from "../services/rt2-jarvis.js";
import { assertCompanyAccess } from "./authz.js";

export function rt2JarvisRoutes(db: Db) {
  const router = Router();
  const svc = rt2JarvisService(db);

  router.get("/companies/:companyId/rt2/jarvis/tasks/:taskIssueId/advice", async (req, res) => {
    const companyId = req.params.companyId as string;
    const taskIssueId = req.params.taskIssueId as string;
    assertCompanyAccess(req, companyId);
    const advice = await svc.getTaskAdvice(companyId, taskIssueId);
    res.json(advice);
  });

  router.get("/companies/:companyId/rt2/jarvis/tasks/:taskIssueId/breakdown", async (req, res) => {
    const companyId = req.params.companyId as string;
    const taskIssueId = req.params.taskIssueId as string;
    assertCompanyAccess(req, companyId);
    const breakdown = await svc.getTaskBreakdown(companyId, taskIssueId);
    res.json(breakdown);
  });

  router.get("/companies/:companyId/rt2/jarvis/insights", async (req, res) => {
    const companyId = req.params.companyId as string;
    const projectId = String(req.query.projectId ?? "").trim();

    assertCompanyAccess(req, companyId);

    if (!projectId) {
      res.status(400).json({ error: "projectId is required" });
      return;
    }

    const insights = await svc.getProjectInsights(companyId, projectId);
    res.json(insights);
  });

  return router;
}
