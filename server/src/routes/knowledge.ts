import { Router } from "express";
import type { Db } from "@paperclipai/db";
import {
  createKnowledgeDocumentSchema,
  listKnowledgeDocumentsQuerySchema,
  updateKnowledgeDocumentSchema,
} from "@paperclipai/shared";
import { validate } from "../middleware/validate.js";
import { knowledgeService, logActivity } from "../services/index.js";
import { assertCompanyAccess, getActorInfo } from "./authz.js";

export function knowledgeRoutes(db: Db) {
  const router = Router();
  const svc = knowledgeService(db);

  router.get("/companies/:companyId/knowledge-documents", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const parsed = listKnowledgeDocumentsQuerySchema.safeParse(req.query ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid knowledge document query", details: parsed.error.issues });
      return;
    }
    const documents = await svc.list(companyId, parsed.data);
    res.json(documents);
  });

  router.post("/companies/:companyId/knowledge-documents", validate(createKnowledgeDocumentSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const actor = getActorInfo(req);
    const document = await svc.create(companyId, {
      ...req.body,
      createdByAgentId: actor.agentId,
      createdByUserId: actor.actorType === "user" ? actor.actorId : null,
    });
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "knowledge_document.created",
      entityType: "knowledge_document",
      entityId: document.id,
      details: {
        title: document.title,
        category: document.category,
        tagCount: document.tags.length,
      },
    });
    res.status(201).json(document);
  });

  router.get("/knowledge-documents/:documentId", async (req, res) => {
    const documentId = req.params.documentId as string;
    const document = await svc.getById(documentId);
    if (!document) {
      res.status(404).json({ error: "Knowledge document not found" });
      return;
    }
    assertCompanyAccess(req, document.companyId);
    res.json(document);
  });

  router.patch("/knowledge-documents/:documentId", validate(updateKnowledgeDocumentSchema), async (req, res) => {
    const documentId = req.params.documentId as string;
    const existing = await svc.getById(documentId);
    if (!existing) {
      res.status(404).json({ error: "Knowledge document not found" });
      return;
    }
    assertCompanyAccess(req, existing.companyId);
    const actor = getActorInfo(req);
    const document = await svc.update(documentId, existing.companyId, req.body);
    await logActivity(db, {
      companyId: existing.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "knowledge_document.updated",
      entityType: "knowledge_document",
      entityId: documentId,
      details: req.body,
    });
    res.json(document);
  });

  router.delete("/knowledge-documents/:documentId", async (req, res) => {
    const documentId = req.params.documentId as string;
    const existing = await svc.getById(documentId);
    if (!existing) {
      res.status(404).json({ error: "Knowledge document not found" });
      return;
    }
    assertCompanyAccess(req, existing.companyId);
    const actor = getActorInfo(req);
    await svc.remove(documentId, existing.companyId);
    await logActivity(db, {
      companyId: existing.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "knowledge_document.deleted",
      entityType: "knowledge_document",
      entityId: documentId,
      details: { title: existing.title, category: existing.category },
    });
    res.json({ ok: true });
  });

  return router;
}