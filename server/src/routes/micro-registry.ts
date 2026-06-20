import { Router, type Request } from "express";
import { z } from "zod";
import type { Db } from "@paperclipai/db";
import { microRegistryService } from "../services/micro-registry.js";
import { assertCompanyAccess } from "./authz.js";

const createPodSchema = z.object({
  paperclipIssueId: z.string().uuid().optional().nullable(),
  identifier: z.string().trim().min(1).max(120),
  title: z.string().trim().min(1).max(240),
  source: z.enum(["paper", "operator", "ledger_gap", "monitoring_signal", "postmortem", "external_request"]),
  thesis: z.string().trim().min(1),
  ownerAgentId: z.string().uuid().optional().nullable(),
  lifecycleState: z.string().trim().min(1).optional(),
  dependencies: z.array(z.unknown()).optional(),
});

const createExperimentSchema = z.object({
  paperclipIssueId: z.string().uuid().optional().nullable(),
  identifier: z.string().trim().min(1).max(120),
  title: z.string().trim().min(1).max(240),
  hypothesis: z.string().trim().min(1),
  sourceKind: z.string().trim().min(1).max(80),
  sourceUrl: z.string().trim().url().optional().nullable(),
  lifecycleState: z.string().trim().min(1).optional(),
  maxImprovementAttempts: z.number().int().min(1).max(5).optional(),
  holdingPeriodMinMinutes: z.number().int().min(1).optional(),
  holdingPeriodMaxMinutes: z.number().int().min(1).optional().nullable(),
  metrics: z.record(z.string(), z.unknown()).optional(),
});

const updateVerdictSchema = z.object({
  verdict: z.enum(["promote", "revise", "kill", "hold"]),
  verdictReason: z.string().trim().min(1),
  lifecycleState: z.string().trim().min(1).optional(),
});

const createDependencyRequestSchema = z.object({
  podId: z.string().uuid().optional().nullable(),
  experimentId: z.string().uuid().optional().nullable(),
  kind: z.string().trim().min(1).max(80),
  title: z.string().trim().min(1).max(240),
  description: z.string().trim().optional().nullable(),
  routedToAgentId: z.string().uuid().optional().nullable(),
  paperclipIssueId: z.string().uuid().optional().nullable(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

const createEvidencePackSchema = z.object({
  podId: z.string().uuid().optional().nullable(),
  experimentId: z.string().uuid().optional().nullable(),
  title: z.string().trim().min(1).max(240),
  artifactUri: z.string().trim().min(1),
  summary: z.string().trim().optional().nullable(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

const createPromotionRequestSchema = z.object({
  podId: z.string().uuid().optional().nullable(),
  experimentId: z.string().uuid().optional().nullable(),
  evidencePackId: z.string().uuid().optional().nullable(),
  target: z.string().trim().min(1).max(120),
  rationale: z.string().trim().min(1),
  riskNotes: z.string().trim().optional().nullable(),
  paperclipIssueId: z.string().uuid().optional().nullable(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

function actorForAudit(req: Request) {
  const actor = req.actor;
  return {
    agentId: actor?.type === "agent" ? actor.agentId : null,
    userId: actor?.type === "board" ? actor.userId ?? "board" : null,
  };
}

export function microRegistryRoutes(db: Db) {
  const router = Router();
  const svc = microRegistryService(db);

  router.get("/companies/:companyId/micro-registry", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    res.json(await svc.overview(companyId));
  });

  router.post("/companies/:companyId/micro-registry/pods", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const input = createPodSchema.parse(req.body);
    const created = await svc.createPod(companyId, input, actorForAudit(req));
    res.status(201).json(created);
  });

  router.post("/companies/:companyId/micro-registry/pods/:podId/experiments", async (req, res) => {
    const companyId = req.params.companyId as string;
    const podId = req.params.podId as string;
    assertCompanyAccess(req, companyId);
    const input = createExperimentSchema.parse(req.body);
    const created = await svc.createExperiment(companyId, podId, input, actorForAudit(req));
    res.status(201).json(created);
  });

  router.patch("/companies/:companyId/micro-registry/experiments/:experimentId/verdict", async (req, res) => {
    const companyId = req.params.companyId as string;
    const experimentId = req.params.experimentId as string;
    assertCompanyAccess(req, companyId);
    const input = updateVerdictSchema.parse(req.body);
    res.json(await svc.updateExperimentVerdict(companyId, experimentId, input));
  });

  router.post("/companies/:companyId/micro-registry/dependency-requests", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const input = createDependencyRequestSchema.parse(req.body);
    res.status(201).json(await svc.createDependencyRequest(companyId, input));
  });

  router.post("/companies/:companyId/micro-registry/evidence-packs", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const input = createEvidencePackSchema.parse(req.body);
    res.status(201).json(await svc.createEvidencePack(companyId, input));
  });

  router.post("/companies/:companyId/micro-registry/promotion-requests", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const input = createPromotionRequestSchema.parse(req.body);
    res.status(201).json(await svc.createPromotionRequest(companyId, input));
  });

  return router;
}
