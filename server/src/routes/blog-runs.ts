import { Router } from "express";
import { z } from "zod";
import type { Db } from "@paperclipai/db";
import { validate } from "../middleware/validate.js";
import { blogRunService, blogRunWorkerService, projectService } from "../services/index.js";
import { assertCompanyAccess } from "./authz.js";

const createBlogRunSchema = z.object({
  issueId: z.string().uuid().nullable().optional(),
  topic: z.string().trim().min(1),
  lane: z.string().trim().optional(),
  targetSite: z.string().trim().optional(),
  approvalMode: z.string().trim().optional(),
  publishMode: z.string().trim().optional(),
  contextJson: z.record(z.string(), z.unknown()).optional(),
});

const completeStepSchema = z.object({
  attemptId: z.string().uuid(),
  resultJson: z.record(z.string(), z.unknown()).optional(),
  artifacts: z.array(z.object({
    artifactKind: z.string().trim().min(1),
    contentType: z.string().trim().min(1),
    storageKind: z.string().trim().optional(),
    storagePath: z.string().trim().optional(),
    bodyPreview: z.string().trim().optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  })).optional(),
});

const failStepSchema = z.object({
  attemptId: z.string().uuid(),
  errorCode: z.string().trim().optional(),
  errorMessage: z.string().trim().optional(),
});

const requestPublishApprovalSchema = z.object({
  targetSlug: z.string().trim().min(1),
  siteId: z.string().trim().optional(),
  artifactHash: z.string().trim().min(1),
  normalizedDomHash: z.string().trim().min(1),
  policyVersion: z.string().trim().optional(),
  approvalKeyHash: z.string().trim().min(1),
  approvalPayload: z.record(z.string(), z.unknown()).optional(),
  approvedByAgentId: z.string().uuid().optional(),
  approvedByUserId: z.string().trim().optional(),
  publishIdempotencyKey: z.string().trim().min(1),
});

const requestResumeReviewSchema = z.object({
  recoveryAction: z.string().trim().min(1),
  evidenceRefs: z.array(z.string().trim().min(1)).min(1),
  requestedBy: z.string().trim().min(1),
  notes: z.array(z.string().trim().min(1)).optional(),
});

const requestPublishApprovalFromRunSchema = z.object({
  approvedByUserId: z.string().trim().optional(),
});

const markResumableSchema = z.object({
  specialistAcknowledgedBy: z.string().trim().min(1),
  operatorReviewedBy: z.string().trim().min(1),
  evidenceRefs: z.array(z.string().trim().min(1)).min(1),
  confirmedRequirements: z.array(z.string().trim().min(1)).min(1),
  notes: z.array(z.string().trim().min(1)).optional(),
});

export function blogRunRoutes(db: Db) {
  const router = Router();
  const svc = blogRunService(db);
  const worker = blogRunWorkerService(db);
  const projectsSvc = projectService(db);

  router.get("/companies/:companyId/blog-runs", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const limit = Math.min(Math.max(Number(req.query.limit ?? 5) || 5, 1), 20);
    const activeOnly = String(req.query.mode ?? "active").trim().toLowerCase() !== "all";
    const runs = await svc.listForCompany(companyId, { limit, activeOnly });
    res.json(runs);
  });

  router.post("/projects/:projectId/blog-runs", validate(createBlogRunSchema), async (req, res) => {
    const projectId = Array.isArray(req.params.projectId) ? req.params.projectId[0] : req.params.projectId;
    const project = await projectsSvc.getById(projectId);
    if (!project) {
      res.status(404).json({ error: "Project not found" });
      return;
    }
    assertCompanyAccess(req, project.companyId);
    const created = await svc.create({
      companyId: project.companyId,
      projectId: project.id,
      issueId: req.body.issueId ?? null,
      topic: req.body.topic,
      lane: req.body.lane,
      targetSite: req.body.targetSite,
      approvalMode: req.body.approvalMode,
      publishMode: req.body.publishMode,
      contextJson: req.body.contextJson,
    });
    res.status(201).json(created);
  });

  router.get("/blog-runs/:id", async (req, res) => {
    const runId = req.params.id as string;
    const detail = await svc.getDetail(runId);
    if (!detail) {
      res.status(404).json({ error: "Blog run not found" });
      return;
    }
    assertCompanyAccess(req, detail.run.companyId);
    res.json(detail);
  });

  router.post("/blog-runs/:id/claim-step", async (req, res) => {
    const runId = req.params.id as string;
    const run = await svc.getById(runId);
    if (!run) {
      res.status(404).json({ error: "Blog run not found" });
      return;
    }
    assertCompanyAccess(req, run.companyId);
    const claimed = await svc.claimNextStep(run.id);
    res.json(claimed);
  });

  router.post("/blog-runs/:id/run-next", async (req, res) => {
    const runId = req.params.id as string;
    const run = await svc.getById(runId);
    if (!run) {
      res.status(404).json({ error: "Blog run not found" });
      return;
    }
    assertCompanyAccess(req, run.companyId);
    const result = await worker.runNext(run.id);
    res.json(result);
  });

  router.post("/blog-runs/:id/steps/:stepKey/complete", validate(completeStepSchema), async (req, res) => {
    const runId = req.params.id as string;
    const stepKey = req.params.stepKey as string;
    const run = await svc.getById(runId);
    if (!run) {
      res.status(404).json({ error: "Blog run not found" });
      return;
    }
    assertCompanyAccess(req, run.companyId);
    const result = await svc.completeStep(run.id, stepKey, req.body);
    res.json(result);
  });

  router.post("/blog-runs/:id/steps/:stepKey/fail", validate(failStepSchema), async (req, res) => {
    const runId = req.params.id as string;
    const stepKey = req.params.stepKey as string;
    const run = await svc.getById(runId);
    if (!run) {
      res.status(404).json({ error: "Blog run not found" });
      return;
    }
    assertCompanyAccess(req, run.companyId);
    const result = await svc.failStep(run.id, stepKey, req.body);
    res.json(result);
  });

  router.post("/blog-runs/:id/request-publish-approval", validate(requestPublishApprovalSchema), async (req, res) => {
    const runId = req.params.id as string;
    const run = await svc.getById(runId);
    if (!run) {
      res.status(404).json({ error: "Blog run not found" });
      return;
    }
    assertCompanyAccess(req, run.companyId);
    const result = await svc.requestPublishApproval(run.id, req.body);
    res.json(result);
  });

  router.post("/blog-runs/:id/request-publish-approval-from-run", validate(requestPublishApprovalFromRunSchema), async (req, res) => {
    const runId = req.params.id as string;
    const run = await svc.getById(runId);
    if (!run) {
      res.status(404).json({ error: "Blog run not found" });
      return;
    }
    assertCompanyAccess(req, run.companyId);
    const result = await svc.requestPublishApprovalFromRun(run.id, req.body);
    res.json(result);
  });

  router.post("/blog-runs/:id/request-resume-review", validate(requestResumeReviewSchema), async (req, res) => {
    const runId = req.params.id as string;
    const run = await svc.getById(runId);
    if (!run) {
      res.status(404).json({ error: "Blog run not found" });
      return;
    }
    assertCompanyAccess(req, run.companyId);
    const result = await svc.requestResumeReview(run.id, req.body);
    res.json(result);
  });

  router.post("/blog-runs/:id/mark-resumable", validate(markResumableSchema), async (req, res) => {
    const runId = req.params.id as string;
    const run = await svc.getById(runId);
    if (!run) {
      res.status(404).json({ error: "Blog run not found" });
      return;
    }
    assertCompanyAccess(req, run.companyId);
    const result = await svc.markResumable(run.id, req.body);
    res.json(result);
  });

  return router;
}
