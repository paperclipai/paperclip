import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { listRt2ProjectGraphSchema } from "@paperclipai/shared";
import { badRequest } from "../errors.js";
import { validate } from "../middleware/validate.js";
import { rt2TaskMeshService } from "../services/rt2-task-mesh.js";
import { assertCompanyAccess } from "./authz.js";

export function rt2TaskMeshRoutes(db: Db) {
  const router = Router();
  const svc = rt2TaskMeshService(db);

  router.get("/companies/:companyId/rt2/graph", validate(listRt2ProjectGraphSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    const projectId = req.query.projectId as string;

    if (!projectId) {
      throw badRequest("projectId is required");
    }

    assertCompanyAccess(req, companyId);

    const graph = await svc.getProjectGraph(companyId, projectId);
    res.json(graph);
  });

  // M2.5: Get full graph report with God Nodes and Surprising Connections
  router.get("/companies/:companyId/rt2/graph-report", async (req, res) => {
    const companyId = req.params.companyId as string;
    const projectId = req.query.projectId as string;

    if (!projectId) {
      throw badRequest("projectId is required");
    }

    assertCompanyAccess(req, companyId);

    const report = await svc.getProjectGraphReport(companyId, projectId);
    res.json(report);
  });

  return router;
}