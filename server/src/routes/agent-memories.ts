import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { upsertAgentMemorySchema, deleteAgentMemorySchema } from "@paperclipai/shared";
import { validate } from "../middleware/validate.js";
import { agentMemoryService, logActivity } from "../services/index.js";
import { assertCompanyAccess, getActorInfo } from "./authz.js";

export function agentMemoryRoutes(db: Db) {
  const router = Router();
  const svc = agentMemoryService(db);

  // List memories for a company (optionally filter by namespace / agentId)
  router.get("/companies/:companyId/memories", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);

    const namespace = req.query.namespace as string | undefined;
    const agentId = req.query.agentId as string | undefined;
    const limitRaw = req.query.limit ? parseInt(req.query.limit as string, 10) : undefined;
    const limit = limitRaw !== undefined && !isNaN(limitRaw) && limitRaw > 0 ? limitRaw : undefined;

    const memories = await svc.list(companyId, { namespace, agentId, limit });
    res.json(memories);
  });

  // List distinct namespaces
  router.get("/companies/:companyId/memories/namespaces", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const namespaces = await svc.listNamespaces(companyId);
    res.json(namespaces);
  });

  // Get a single memory by namespace + key
  router.get("/companies/:companyId/memories/lookup", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);

    const namespace = req.query.namespace as string;
    const key = req.query.key as string;
    if (!namespace || !key) {
      res.status(400).json({ error: "namespace and key query parameters are required" });
      return;
    }

    const memory = await svc.get(companyId, namespace, key);
    if (!memory) {
      res.status(404).json({ error: "Memory not found" });
      return;
    }
    res.json(memory);
  });

  // Get a single memory by id
  router.get("/memories/:id", async (req, res) => {
    const id = req.params.id as string;
    const memory = await svc.getById(id);
    if (!memory) {
      res.status(404).json({ error: "Memory not found" });
      return;
    }
    assertCompanyAccess(req, memory.companyId);
    res.json(memory);
  });

  // Upsert a memory (create or update by namespace + key)
  router.put(
    "/companies/:companyId/memories",
    validate(upsertAgentMemorySchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);

      const actor = getActorInfo(req);
      const memory = await svc.upsert(companyId, {
        agentId: req.body.agentId ?? (actor.agentId || null),
        namespace: req.body.namespace,
        key: req.body.key,
        value: req.body.value,
      });

      if (!memory) {
        res.status(500).json({ error: "Failed to upsert memory" });
        return;
      }

      await logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        action: "memory.upserted",
        entityType: "agent_memory",
        entityId: memory.id,
        details: { namespace: memory.namespace, key: memory.key },
      });

      res.status(200).json(memory);
    },
  );

  // Delete a memory by id
  router.delete("/memories/:id", async (req, res) => {
    const id = req.params.id as string;
    const existing = await svc.getById(id);
    if (!existing) {
      res.status(404).json({ error: "Memory not found" });
      return;
    }
    assertCompanyAccess(req, existing.companyId);

    const actor = getActorInfo(req);
    await svc.deleteById(id);

    await logActivity(db, {
      companyId: existing.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      action: "memory.deleted",
      entityType: "agent_memory",
      entityId: id,
      details: { namespace: existing.namespace, key: existing.key },
    });

    res.status(204).end();
  });

  // Delete a memory by namespace + key
  router.delete("/companies/:companyId/memories", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);

    const parsed = deleteAgentMemorySchema.safeParse({
      namespace: req.query.namespace,
      key: req.query.key,
    });
    if (!parsed.success) {
      res.status(400).json({ error: "namespace and key query parameters are required" });
      return;
    }

    const { namespace, key } = parsed.data;
    const deleted = await svc.delete(companyId, namespace, key);
    if (!deleted) {
      res.status(404).json({ error: "Memory not found" });
      return;
    }

    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      action: "memory.deleted",
      entityType: "agent_memory",
      entityId: deleted.id,
      details: { namespace: deleted.namespace, key: deleted.key },
    });

    res.status(204).end();
  });

  return router;
}
