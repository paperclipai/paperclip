import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { workProductService, clampDeliverableLimit } from "../services/index.js";
import { assertBoard, assertCompanyAccess } from "./authz.js";

export function deliverableRoutes(db: Db) {
  const router = Router();
  const workProductsSvc = workProductService(db);

  router.get("/companies/:companyId/deliverables", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertBoard(req);
    assertCompanyAccess(req, companyId);

    const limit = clampDeliverableLimit(req.query.limit);
    const offsetRaw = Number(req.query.offset);
    const offset = Number.isFinite(offsetRaw) && offsetRaw > 0 ? Math.floor(offsetRaw) : 0;
    const projectId = typeof req.query.projectId === "string" && req.query.projectId.trim().length > 0
      ? req.query.projectId.trim()
      : undefined;
    const agentId = typeof req.query.agentId === "string" && req.query.agentId.trim().length > 0
      ? req.query.agentId.trim()
      : undefined;
    const q = typeof req.query.q === "string" && req.query.q.trim().length > 0
      ? req.query.q.trim()
      : undefined;

    const items = await workProductsSvc.listDeliverablesForCompany(companyId, {
      limit,
      offset,
      projectId,
      agentId,
      q,
    });
    res.json({ items, limit, offset });
  });

  router.get("/deliverables/:id", async (req, res) => {
    const id = req.params.id as string;
    assertBoard(req);
    const deliverable = await workProductsSvc.getDeliverableById(id);
    if (!deliverable) {
      res.status(404).json({ error: "Deliverable not found" });
      return;
    }
    assertCompanyAccess(req, deliverable.companyId);
    res.json(deliverable);
  });

  return router;
}
