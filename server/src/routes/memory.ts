import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { setMemorySchema } from "@paperclipai/shared";
import { validate } from "../middleware/validate.js";
import { assertCompanyAccess, getActorInfo } from "./authz.js";
import { memoryService, logActivity } from "../services/index.js";

export function memoryRoutes(db: Db) {
  const router = Router();
  const svc = memoryService(db);

  // List agent memory entries
  router.get("/companies/:companyId/agents/:agentId/memory", async (req, res) => {
    const { companyId, agentId } = req.params;
    assertCompanyAccess(req, companyId as string);
    const entries = await svc.list(agentId as string);
    res.json(entries);
  });

  // Get a single memory entry
  router.get("/companies/:companyId/agents/:agentId/memory/:key", async (req, res) => {
    const { companyId, agentId, key } = req.params;
    assertCompanyAccess(req, companyId as string);
    const entry = await svc.get(agentId as string, key as string);
    if (!entry) {
      res.status(404).json({ error: "Memory entry not found" });
      return;
    }
    res.json(entry);
  });

  // Set (upsert) a memory entry
  router.put(
    "/companies/:companyId/agents/:agentId/memory",
    validate(setMemorySchema),
    async (req, res) => {
      const { companyId, agentId } = req.params;
      assertCompanyAccess(req, companyId as string);

      // Agents can only write to their own memory
      const actor = getActorInfo(req);
      if (actor.actorType === "agent" && actor.agentId !== agentId) {
        res.status(403).json({ error: "Agents can only write to their own memory" });
        return;
      }

      const entry = await svc.set(companyId as string, agentId as string, {
        key: req.body.key,
        value: req.body.value,
        metadata: req.body.metadata,
        ttlSeconds: req.body.ttlSeconds,
      });

      await logActivity(db, {
        companyId: companyId as string,
        actorType: actor.actorType,
        actorId: actor.actorId,
        action: "memory.set",
        entityType: "agent",
        entityId: agentId as string,
        details: { key: req.body.key },
      });

      res.json(entry);
    },
  );

  // Delete a memory entry
  router.delete(
    "/companies/:companyId/agents/:agentId/memory/:key",
    async (req, res) => {
      const { companyId, agentId, key } = req.params;
      assertCompanyAccess(req, companyId as string);

      const actor = getActorInfo(req);
      if (actor.actorType === "agent" && actor.agentId !== agentId) {
        res.status(403).json({ error: "Agents can only delete their own memory" });
        return;
      }

      const deleted = await svc.delete(agentId as string, key as string);

      await logActivity(db, {
        companyId: companyId as string,
        actorType: actor.actorType,
        actorId: actor.actorId,
        action: "memory.deleted",
        entityType: "agent",
        entityId: agentId as string,
        details: { key: key as string },
      });

      res.json(deleted);
    },
  );

  return router;
}
