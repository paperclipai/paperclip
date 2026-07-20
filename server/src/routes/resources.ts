import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { createResourceSchema, updateResourceSchema } from "@paperclipai/shared";
import { validate } from "../middleware/validate.js";
import { resourceService, logActivity } from "../services/index.js";
import { assertCompanyAccess, getActorInfo } from "./authz.js";

export function resourceRoutes(db: Db) {
  const router = Router();
  const svc = resourceService(db);

  function visibleCompanyIds(req: Parameters<typeof assertCompanyAccess>[0]) {
    if (req.actor.type === "agent") return req.actor.companyId ? [req.actor.companyId] : [];
    if (req.actor.source === "local_implicit" || req.actor.isInstanceAdmin) return undefined;
    return req.actor.companyIds ?? [];
  }

  router.get("/companies/:companyId/resources", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const includeArchived = req.query.includeArchived === "true";
    res.json(await svc.list(companyId, includeArchived));
  });

  router.post("/companies/:companyId/resources", validate(createResourceSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const created = await svc.create(companyId, req.body);
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "resource.created",
      entityType: "resource",
      entityId: created.id,
      details: { key: created.key, type: created.type },
    });
    res.status(201).json(created);
  });

  router.get("/resources/:id", async (req, res) => {
    const resource = await svc.getById(req.params.id as string, visibleCompanyIds(req));
    if (!resource) {
      res.status(404).json({ error: "Resource not found" });
      return;
    }
    assertCompanyAccess(req, resource.companyId);
    res.json(resource);
  });

  router.patch("/resources/:id", validate(updateResourceSchema), async (req, res) => {
    const companyIds = visibleCompanyIds(req);
    const existing = await svc.getById(req.params.id as string, companyIds);
    if (!existing) {
      res.status(404).json({ error: "Resource not found" });
      return;
    }
    assertCompanyAccess(req, existing.companyId);
    const updated = await svc.update(existing.id, req.body, companyIds);
    if (!updated) {
      res.status(404).json({ error: "Resource not found" });
      return;
    }
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: existing.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "resource.updated",
      entityType: "resource",
      entityId: existing.id,
      details: { key: updated.key },
    });
    res.json(updated);
  });

  router.delete("/resources/:id", async (req, res) => {
    const companyIds = visibleCompanyIds(req);
    const existing = await svc.getById(req.params.id as string, companyIds);
    if (!existing) {
      res.status(404).json({ error: "Resource not found" });
      return;
    }
    assertCompanyAccess(req, existing.companyId);
    const archived = await svc.archive(existing.id, companyIds);
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: existing.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "resource.archived",
      entityType: "resource",
      entityId: existing.id,
      details: { key: existing.key },
    });
    res.json(archived);
  });

  return router;
}
