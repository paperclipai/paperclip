import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { createCompanyKnowledgeSchema, updateCompanyKnowledgeSchema } from "@paperclipai/shared";
import { validate } from "../middleware/validate.js";
import { companyKnowledgeService, logActivity } from "../services/index.js";
import { assertCompanyAccess, getActorInfo } from "./authz.js";

export function companyKnowledgeRoutes(db: Db) {
  const router = Router();
  const svc = companyKnowledgeService(db);

  router.get("/companies/:companyId/knowledge", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const result = await svc.list(companyId);
    res.json(result);
  });

  router.get("/knowledge/:id", async (req, res) => {
    const id = req.params.id as string;
    const knowledge = await svc.getById(id);
    if (!knowledge) {
      res.status(404).json({ error: "Knowledge not found" });
      return;
    }
    assertCompanyAccess(req, knowledge.companyId);
    res.json(knowledge);
  });

  router.post("/companies/:companyId/knowledge", validate(createCompanyKnowledgeSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const knowledge = await svc.create(companyId, req.body);
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      action: "knowledge.created",
      entityType: "company_knowledge",
      entityId: knowledge.id,
      details: { title: knowledge.title },
    });
    res.status(201).json(knowledge);
  });

  router.patch("/knowledge/:id", validate(updateCompanyKnowledgeSchema), async (req, res) => {
    const id = req.params.id as string;
    const existing = await svc.getById(id);
    if (!existing) {
      res.status(404).json({ error: "Knowledge not found" });
      return;
    }
    assertCompanyAccess(req, existing.companyId);
    const knowledge = await svc.update(id, req.body);
    if (!knowledge) {
      res.status(404).json({ error: "Knowledge not found" });
      return;
    }

    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: knowledge.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      action: "knowledge.updated",
      entityType: "company_knowledge",
      entityId: knowledge.id,
      details: req.body,
    });

    res.json(knowledge);
  });

  router.delete("/knowledge/:id", async (req, res) => {
    const id = req.params.id as string;
    const existing = await svc.getById(id);
    if (!existing) {
      res.status(404).json({ error: "Knowledge not found" });
      return;
    }
    assertCompanyAccess(req, existing.companyId);
    const knowledge = await svc.remove(id);
    if (!knowledge) {
      res.status(404).json({ error: "Knowledge not found" });
      return;
    }

    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: knowledge.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      action: "knowledge.deleted",
      entityType: "company_knowledge",
      entityId: knowledge.id,
    });

    res.json(knowledge);
  });

  return router;
}
