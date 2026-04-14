import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { evolutionService } from "../services/evolution.js";
import { assertBoard, assertCompanyAccess } from "./authz.js";

export function evolutionRoutes(db: Db) {
  const router = Router();
  const svc = evolutionService(db);

  // --- Variants ---

  router.post("/companies/:companyId/evolution/variants", async (req, res) => {
    assertBoard(req);
    assertCompanyAccess(req, req.params.companyId);
    const result = await svc.createVariant({ companyId: req.params.companyId, ...req.body });
    res.status(201).json(result);
  });

  router.get("/companies/:companyId/agents/:agentId/evolution/variants", async (req, res) => {
    assertCompanyAccess(req, req.params.companyId);
    const result = await svc.listVariants({ companyId: req.params.companyId, agentId: req.params.agentId });
    res.json(result);
  });

  // --- Runs ---

  router.post("/companies/:companyId/evolution/runs", async (req, res) => {
    assertBoard(req);
    assertCompanyAccess(req, req.params.companyId);
    const result = await svc.createRun({ companyId: req.params.companyId, ...req.body });
    res.status(201).json(result);
  });

  router.get("/companies/:companyId/evolution/runs", async (req, res) => {
    assertCompanyAccess(req, req.params.companyId);
    const { status, limit } = req.query;
    const result = await svc.listRuns({
      companyId: req.params.companyId,
      status: status as string,
      limit: limit ? Number(limit) : undefined,
    });
    res.json(result);
  });

  router.get("/companies/:companyId/evolution/runs/:runId", async (req, res) => {
    assertCompanyAccess(req, req.params.companyId);
    const result = await svc.getRun(req.params.runId);
    res.json(result);
  });

  // --- Task Results ---

  router.post("/evolution/runs/:runId/results", async (req, res) => {
    assertBoard(req);
    const result = await svc.recordTaskResult({ runId: req.params.runId, ...req.body });
    res.status(201).json(result);
  });

  // --- Finalize ---

  router.post("/evolution/runs/:runId/finalize", async (req, res) => {
    assertBoard(req);
    const result = await svc.finalizeRun(req.params.runId);
    res.json(result);
  });

  // --- Promote ---

  router.post("/evolution/runs/:runId/promote", async (req, res) => {
    assertBoard(req);
    const { variantId } = req.body;
    const result = await svc.promoteVariant({ runId: req.params.runId, variantId });
    res.json(result);
  });

  return router;
}
