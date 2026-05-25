import type { Db } from "@paperclipai/db";
import { Router } from "express";

import { modelAssuranceService } from "../services/model-assurance/index.js";
import { assertBoard, assertCompanyAccess } from "./authz.js";

export function modelAssuranceRoutes(db: Db) {
  const router = Router();
  const service = modelAssuranceService(db);

  router.get("/companies/:companyId/agents/:agentId/model-assurance", async (req, res) => {
    const { companyId, agentId } = req.params;
    assertCompanyAccess(req, companyId);

    res.json(await service.getLatestForAgent(companyId, agentId));
  });

  router.post("/companies/:companyId/agents/:agentId/model-assurance/probe", async (req, res) => {
    const { companyId, agentId } = req.params;
    assertBoard(req);
    assertCompanyAccess(req, companyId);

    res.json(await service.probeAgent(companyId, agentId));
  });

  return router;
}
