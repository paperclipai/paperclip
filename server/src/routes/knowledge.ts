import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { createKnowledgeEntrySchema, updateKnowledgeEntrySchema } from "@paperclipai/shared";
import { validate } from "../middleware/validate.js";
import { assertCompanyAccess, getActorInfo } from "./authz.js";
import { knowledgeService, logActivity } from "../services/index.js";

export function knowledgeRoutes(db: Db) {
  const router = Router();
  const svc = knowledgeService(db);

  // List knowledge entries
  router.get("/companies/:companyId/knowledge", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const entries = await svc.list(companyId, {
      category: req.query.category as string | undefined,
      status: req.query.status as string | undefined,
      search: req.query.search as string | undefined,
    });
    res.json(entries);
  });

  // Get a single knowledge entry
  router.get("/knowledge/:id", async (req, res) => {
    const entry = await svc.getById(req.params.id as string);
    if (!entry) {
      res.status(404).json({ error: "Knowledge entry not found" });
      return;
    }
    assertCompanyAccess(req, entry.companyId);
    res.json(entry);
  });

  // Create a knowledge entry
  router.post(
    "/companies/:companyId/knowledge",
    validate(createKnowledgeEntrySchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const actor = getActorInfo(req);

      const entry = await svc.create(
        companyId,
        {
          category: req.body.category,
          title: req.body.title,
          content: req.body.content,
          metadata: req.body.metadata,
          status: req.body.status,
        },
        { agentId: actor.agentId, userId: actor.actorType === "user" ? actor.actorId : null },
      );

      await logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        action: "knowledge.created",
        entityType: "knowledge",
        entityId: entry.id,
        details: { title: entry.title, category: entry.category },
      });

      res.status(201).json(entry);
    },
  );

  // Update a knowledge entry
  router.patch(
    "/knowledge/:id",
    validate(updateKnowledgeEntrySchema),
    async (req, res) => {
      const entry = await svc.getById(req.params.id as string);
      if (!entry) {
        res.status(404).json({ error: "Knowledge entry not found" });
        return;
      }
      assertCompanyAccess(req, entry.companyId);
      const actor = getActorInfo(req);

      const updated = await svc.update(req.params.id as string, {
        category: req.body.category,
        title: req.body.title,
        content: req.body.content,
        metadata: req.body.metadata,
        status: req.body.status,
      });

      await logActivity(db, {
        companyId: entry.companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        action: "knowledge.updated",
        entityType: "knowledge",
        entityId: entry.id,
        details: { title: updated?.title },
      });

      res.json(updated);
    },
  );

  // Delete a knowledge entry
  router.delete("/knowledge/:id", async (req, res) => {
    const entry = await svc.getById(req.params.id as string);
    if (!entry) {
      res.status(404).json({ error: "Knowledge entry not found" });
      return;
    }
    assertCompanyAccess(req, entry.companyId);
    const actor = getActorInfo(req);

    const removed = await svc.remove(req.params.id as string);

    await logActivity(db, {
      companyId: entry.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      action: "knowledge.deleted",
      entityType: "knowledge",
      entityId: entry.id,
      details: { title: entry.title },
    });

    res.json(removed);
  });

  return router;
}
