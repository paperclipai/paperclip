import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { rt2KnowledgeOperationsService } from "../services/rt2-knowledge-operations.js";
import { assertCompanyAccess } from "./authz.js";

export function rt2KnowledgeOperationsRoutes(db: Db) {
  const router = Router();
  const service = rt2KnowledgeOperationsService(db);

  router.get("/companies/:companyId/rt2/knowledge/operations/health", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    res.json(await service.getHealth(companyId));
  });

  return router;
}
