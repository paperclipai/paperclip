import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { createMemorySchema, queryMemoriesSchema } from "@paperclipai/shared";
import { validate } from "../middleware/validate.js";
import { memoryService, logActivity } from "../services/index.js";
import { assertCompanyAccess, getActorInfo } from "./authz.js";

export function memoryRoutes(db: Db) {
  const router = Router();
  const svc = memoryService(db);

  router.get("/companies/:companyId/memories", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const filters = queryMemoriesSchema.parse(req.query);
    const result = await svc.list(companyId, filters);
    res.json(result);
  });

  router.post("/companies/:companyId/memories", validate(createMemorySchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const actor = getActorInfo(req);

    const data = {
      ...req.body,
      sourceAgentId: actor.agentId ?? undefined,
      sourceRunId: actor.runId ?? undefined,
    };

    const memory = await svc.create(companyId, data);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      action: "memory.created",
      entityType: "memory",
      entityId: memory.id,
      details: { category: memory.category, scopeType: memory.scopeType },
    });
    res.status(201).json(memory);
  });

  router.delete("/memories/:id", async (req, res) => {
    const id = req.params.id as string;
    const existing = await svc.getById(id);
    if (!existing) {
      res.status(404).json({ error: "Memory not found" });
      return;
    }
    assertCompanyAccess(req, existing.companyId);
    const memory = await svc.remove(id);
    if (!memory) {
      res.status(404).json({ error: "Memory not found" });
      return;
    }

    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: memory.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      action: "memory.deleted",
      entityType: "memory",
      entityId: memory.id,
    });

    res.json(memory);
  });

  return router;
}
