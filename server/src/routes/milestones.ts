import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { createMilestoneSchema, updateMilestoneSchema } from "@paperclipai/shared";
import { validate } from "../middleware/validate.js";
import { createMilestonesService, logActivity } from "../services/index.js";
import { assertCompanyAccess, getActorInfo } from "./authz.js";

export function milestoneRoutes(db: Db) {
  const router = Router();
  const svc = createMilestonesService(db);

  router.get("/companies/:companyId/milestones", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const projectId = req.query.projectId as string | undefined;
    const result = await svc.list(companyId, projectId);
    res.json(result);
  });

  router.get("/milestones/:id", async (req, res) => {
    const id = req.params.id as string;
    const milestone = await svc.getById(id);
    if (!milestone) {
      res.status(404).json({ error: "Milestone not found" });
      return;
    }
    assertCompanyAccess(req, milestone.companyId);
    res.json(milestone);
  });

  router.post("/companies/:companyId/milestones", validate(createMilestoneSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const milestone = await svc.create(companyId, req.body);
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      action: "milestone.created",
      entityType: "milestone",
      entityId: milestone.id,
      details: { name: milestone.name },
    });
    res.status(201).json(milestone);
  });

  router.patch("/milestones/:id", validate(updateMilestoneSchema), async (req, res) => {
    const id = req.params.id as string;
    const existing = await svc.getById(id);
    if (!existing) {
      res.status(404).json({ error: "Milestone not found" });
      return;
    }
    assertCompanyAccess(req, existing.companyId);
    const milestone = await svc.update(id, req.body);
    if (!milestone) {
      res.status(404).json({ error: "Milestone not found" });
      return;
    }
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: milestone.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      action: "milestone.updated",
      entityType: "milestone",
      entityId: milestone.id,
      details: req.body,
    });
    res.json(milestone);
  });

  router.delete("/milestones/:id", async (req, res) => {
    const id = req.params.id as string;
    const existing = await svc.getById(id);
    if (!existing) {
      res.status(404).json({ error: "Milestone not found" });
      return;
    }
    assertCompanyAccess(req, existing.companyId);
    const removed = await svc.remove(id);
    if (!removed) {
      res.status(404).json({ error: "Milestone not found" });
      return;
    }
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: existing.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      action: "milestone.deleted",
      entityType: "milestone",
      entityId: existing.id,
    });
    res.json({ success: true });
  });

  return router;
}
