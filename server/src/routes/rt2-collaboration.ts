import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { rt2CollaborationService, rt2QualityService } from "../services/rt2-collaboration.js";
import { assertCompanyAccess } from "./authz.js";
import { z } from "zod";
import { validate } from "../middleware/validate.js";

const recordScoreSchema = z.object({
  deliverableId: z.string().uuid().optional(),
  taskIssueId: z.string().uuid(),
  evaluator: z.string(),
  evalType: z.string(),
  score: z.number().int().min(-100).max(100),
  category: z.string(),
  rationale: z.string().optional(),
});

export function rt2CollaborationRoutes(db: Db) {
  const router = Router();
  const collaborationSvc = rt2CollaborationService(db);
  const qualitySvc = rt2QualityService(db);

  router.get("/companies/:companyId/rt2/collaboration/health", async (req, res) => {
    const companyId = req.params.companyId as string;
    const projectId = String(req.query.projectId ?? "").trim();

    assertCompanyAccess(req, companyId);

    if (!projectId) {
      res.status(400).json({ error: "projectId is required" });
      return;
    }

    const health = await collaborationSvc.getTeamHealth(companyId, projectId);
    res.json(health);
  });

  router.get("/companies/:companyId/rt2/collaboration/dependencies", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);

    const dependencies = await collaborationSvc.getCrossTeamDependencies(companyId);
    res.json(dependencies);
  });

  router.get("/companies/:companyId/rt2/collaboration/workload", async (req, res) => {
    const companyId = req.params.companyId as string;
    const projectId = String(req.query.projectId ?? "").trim();

    assertCompanyAccess(req, companyId);

    if (!projectId) {
      res.status(400).json({ error: "projectId is required" });
      return;
    }

    const workload = await collaborationSvc.getWorkloadBalance(companyId, projectId);
    res.json(workload);
  });

  router.get("/companies/:companyId/rt2/quality/metrics", async (req, res) => {
    const companyId = req.params.companyId as string;
    const projectId = String(req.query.projectId ?? "").trim();

    assertCompanyAccess(req, companyId);

    if (!projectId) {
      res.status(400).json({ error: "projectId is required" });
      return;
    }

    const metrics = await qualitySvc.getQualityMetrics(companyId, projectId);
    res.json(metrics);
  });

  router.get("/companies/:companyId/rt2/quality/trends", async (req, res) => {
    const companyId = req.params.companyId as string;
    const projectId = String(req.query.projectId ?? "").trim();

    assertCompanyAccess(req, companyId);

    if (!projectId) {
      res.status(400).json({ error: "projectId is required" });
      return;
    }

    const trends = await qualitySvc.getQualityTrends(companyId, projectId);
    res.json(trends);
  });

  router.get("/companies/:companyId/rt2/quality/gates", async (req, res) => {
    const companyId = req.params.companyId as string;
    const projectId = String(req.query.projectId ?? "").trim();

    assertCompanyAccess(req, companyId);

    if (!projectId) {
      res.status(400).json({ error: "projectId is required" });
      return;
    }

    const gates = await qualitySvc.getQualityGateStatus(companyId, projectId);
    res.json(gates);
  });

  // Record a quality score (shadow mode: positive scores are active immediately)
  router.post("/companies/:companyId/rt2/quality/scores", validate(recordScoreSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    const body = req.body;

    assertCompanyAccess(req, companyId);

    const score = await qualitySvc.recordQualityScore(companyId, {
      deliverableId: body.deliverableId,
      taskIssueId: body.taskIssueId,
      evaluator: body.evaluator,
      evalType: body.evalType,
      score: body.score,
      category: body.category,
      rationale: body.rationale,
    });

    res.status(201).json(score);
  });

  // Get quality scores for a task
  router.get("/companies/:companyId/rt2/quality/scores", async (req, res) => {
    const companyId = req.params.companyId as string;
    const taskIssueId = String(req.query.taskIssueId ?? "").trim();
    const deliverableId = String(req.query.deliverableId ?? "").trim();

    assertCompanyAccess(req, companyId);

    if (!taskIssueId && !deliverableId) {
      res.status(400).json({ error: "taskIssueId or deliverableId is required" });
      return;
    }

    const scores = await qualitySvc.getQualityScores(companyId, { taskIssueId, deliverableId });
    res.json(scores);
  });

  // Get quality summary for a project (shadow mode summary)
  router.get("/companies/:companyId/rt2/quality/summary", async (req, res) => {
    const companyId = req.params.companyId as string;
    const projectId = String(req.query.projectId ?? "").trim();

    assertCompanyAccess(req, companyId);

    if (!projectId) {
      res.status(400).json({ error: "projectId is required" });
      return;
    }

    const summary = await qualitySvc.getQualitySummary(companyId, projectId);
    res.json(summary);
  });

  return router;
}