import { Router } from "express";
import type { Db } from "@paperclipai/db";
import {
  companyDocumentListQuerySchema,
  createDocumentLinkSchema,
  isUuidLike,
  updateDocumentMetadataSchema,
} from "@paperclipai/shared";
import { validate } from "../middleware/validate.js";
import { accessService, documentService, logActivity, projectService } from "../services/index.js";
import { assertCompanyAccess, getActorInfo } from "./authz.js";

export function documentRoutes(db: Db) {
  const router = Router();
  const documents = documentService(db);
  const projects = projectService(db);
  const access = accessService(db);

  // Document ids are UUID-keyed. Reject malformed ids early so they surface as a
  // structured 400 instead of bubbling up as a Postgres "invalid input syntax for
  // type uuid" error (which would become an opaque 500). See PAP-10582.
  router.param("documentId", (req, res, next, value) => {
    if (!isUuidLike(value)) {
      res.status(400).json({ error: "Invalid document id format" });
      return;
    }
    next();
  });

  router.get("/companies/:companyId/documents", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const query = companyDocumentListQuerySchema.parse(req.query);
    res.json(await documents.listCompanyDocuments(companyId, query));
  });

  router.get("/projects/:projectId/documents", async (req, res) => {
    const projectId = req.params.projectId as string;
    const project = await projects.getById(projectId);
    if (!project) {
      res.status(404).json({ error: "Project not found" });
      return;
    }
    assertCompanyAccess(req, project.companyId);
    const decision = await access.decide({
      actor: req.actor,
      action: "project:read",
      resource: { type: "project", companyId: project.companyId, projectId: project.id },
    });
    if (!decision.allowed) {
      res.status(403).json({ error: "Project is outside this actor's authorization boundary" });
      return;
    }
    const query = companyDocumentListQuerySchema.parse({
      ...req.query,
      projectId: project.id,
    });
    res.json(await documents.listCompanyDocuments(project.companyId, query));
  });

  router.get("/companies/:companyId/documents/:documentId", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const document = await documents.getCompanyDocumentById(companyId, req.params.documentId as string);
    if (!document) {
      res.status(404).json({ error: "Document not found" });
      return;
    }
    res.json(document);
  });

  router.get("/companies/:companyId/documents/:documentId/backlinks", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    res.json(await documents.listDocumentBacklinks(companyId, req.params.documentId as string));
  });

  router.patch(
    "/companies/:companyId/documents/:documentId",
    validate(updateDocumentMetadataSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const documentId = req.params.documentId as string;
      assertCompanyAccess(req, companyId);
      const actor = getActorInfo(req);
      const document = await documents.updateDocumentMetadata({
        companyId,
        documentId,
        ...req.body,
        updatedByAgentId: actor.agentId,
        updatedByUserId: actor.actorType === "user" ? actor.actorId : null,
      });
      await logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: "document.metadata_updated",
        entityType: "document",
        entityId: document.id,
        details: {
          status: document.status,
          documentType: document.documentType,
          ownerAgentId: document.ownerAgentId,
          ownerUserId: document.ownerUserId,
          archivedAt: document.archivedAt,
        },
      });
      res.json(document);
    },
  );

  router.post(
    "/companies/:companyId/documents/:documentId/links",
    validate(createDocumentLinkSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const documentId = req.params.documentId as string;
      assertCompanyAccess(req, companyId);
      const actor = getActorInfo(req);
      const link = await documents.createDocumentLink({
        companyId,
        documentId,
        targetType: req.body.targetType,
        targetId: req.body.targetId,
        relationship: req.body.relationship,
        createdByAgentId: actor.agentId,
        createdByUserId: actor.actorType === "user" ? actor.actorId : null,
      });
      await logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: "document.link_created",
        entityType: "document",
        entityId: documentId,
        details: link
          ? {
              linkId: link.id,
              targetType: link.targetType,
              targetId: link.targetId,
              relationship: link.relationship,
            }
          : null,
      });
      res.status(201).json(link);
    },
  );

  router.delete("/companies/:companyId/documents/:documentId/links/:linkId", async (req, res) => {
    const companyId = req.params.companyId as string;
    const documentId = req.params.documentId as string;
    const linkId = req.params.linkId as string;
    assertCompanyAccess(req, companyId);
    const removed = await documents.deleteDocumentLink(companyId, documentId, linkId);
    if (!removed) {
      res.status(404).json({ error: "Document link not found" });
      return;
    }
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "document.link_deleted",
      entityType: "document",
      entityId: documentId,
      details: {
        linkId: removed.id,
        targetType: removed.targetType,
        targetId: removed.targetId,
        relationship: removed.relationship,
      },
    });
    res.status(204).end();
  });

  return router;
}
