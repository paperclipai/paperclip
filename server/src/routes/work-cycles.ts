import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { createWorkCycleSchema, updateWorkCycleSchema } from "@paperclipai/shared";
import { validate } from "../middleware/validate.js";
import { workCycleService, logActivity } from "../services/index.js";
import { assertCompanyAccess, getActorInfo } from "./authz.js";

export function workCycleRoutes(db: Db) {
  const router = Router();
  const svc = workCycleService(db);

  router.get("/companies/:companyId/work-cycles", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const projectId = typeof req.query.projectId === "string" && req.query.projectId.trim()
      ? req.query.projectId.trim()
      : null;
    const cycles = await svc.list(companyId, {
      projectId,
      includeCompanyWide: req.query.includeCompanyWide !== "false",
      includeArchived: req.query.includeArchived === "true" || req.query.includeArchived === "1",
    });
    res.json(cycles);
  });

  router.get("/work-cycles/:id", async (req, res) => {
    const id = req.params.id as string;
    const cycle = await svc.getById(id);
    if (!cycle) {
      res.status(404).json({ error: "Cycle not found" });
      return;
    }
    assertCompanyAccess(req, cycle.companyId);
    res.json(cycle);
  });

  router.post("/companies/:companyId/work-cycles", validate(createWorkCycleSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const cycle = await svc.create(companyId, req.body);
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "work_cycle.created",
      entityType: "work_cycle",
      entityId: cycle.id,
      details: { name: cycle.name, projectId: cycle.projectId },
    });
    res.status(201).json(cycle);
  });

  router.patch("/work-cycles/:id", validate(updateWorkCycleSchema), async (req, res) => {
    const id = req.params.id as string;
    const existing = await svc.getById(id);
    if (!existing) {
      res.status(404).json({ error: "Cycle not found" });
      return;
    }
    assertCompanyAccess(req, existing.companyId);
    const cycle = await svc.update(id, req.body);
    if (!cycle) {
      res.status(404).json({ error: "Cycle not found" });
      return;
    }
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: cycle.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "work_cycle.updated",
      entityType: "work_cycle",
      entityId: cycle.id,
      details: req.body,
    });
    res.json(cycle);
  });

  return router;
}
