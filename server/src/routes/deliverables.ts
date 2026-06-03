import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { DELIVERABLE_AUDIENCES, type DeliverableAudience } from "@paperclipai/shared";
import { workProductService, clampDeliverableLimit } from "../services/index.js";
import { getStorageService } from "../storage/index.js";
import { assertBoard, assertCompanyAccess } from "./authz.js";

function sanitizeDispositionFilename(filename: string): string {
  const sanitized = filename.replace(/[\u0000-\u001F\u007F"]/g, "").trim();
  return sanitized.length > 0 ? sanitized : "document.md";
}

export function deliverableRoutes(db: Db) {
  const router = Router();
  const workProductsSvc = workProductService(db);

  router.get("/companies/:companyId/deliverables", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertBoard(req);
    assertCompanyAccess(req, companyId);

    const limit = clampDeliverableLimit(req.query.limit);
    const offsetRaw = Number(req.query.offset);
    const offset = Number.isFinite(offsetRaw) && offsetRaw > 0 ? Math.floor(offsetRaw) : 0;
    const projectId = typeof req.query.projectId === "string" && req.query.projectId.trim().length > 0
      ? req.query.projectId.trim()
      : undefined;
    const agentId = typeof req.query.agentId === "string" && req.query.agentId.trim().length > 0
      ? req.query.agentId.trim()
      : undefined;
    const q = typeof req.query.q === "string" && req.query.q.trim().length > 0
      ? req.query.q.trim()
      : undefined;
    const audience = typeof req.query.audience === "string" && DELIVERABLE_AUDIENCES.includes(req.query.audience as DeliverableAudience)
      ? req.query.audience as DeliverableAudience
      : undefined;

    const items = await workProductsSvc.listDeliverablesForCompany(companyId, {
      limit,
      offset,
      projectId,
      agentId,
      q,
      audience,
    });
    res.json({ items, limit, offset });
  });

  router.get("/deliverables/:id", async (req, res) => {
    const id = req.params.id as string;
    assertBoard(req);
    const deliverable = await workProductsSvc.getDeliverableById(id)
      ?? await workProductsSvc.getWorkflowDeliverableById(id);
    if (!deliverable) {
      res.status(404).json({ error: "Deliverable not found" });
      return;
    }
    assertCompanyAccess(req, deliverable.companyId);
    res.json(deliverable);
  });

  router.get("/deliverables/:id/content", async (req, res, next) => {
    const id = req.params.id as string;
    assertBoard(req);

    const document = await workProductsSvc.getDeliverableDocumentContentById(id);
    if (document) {
      assertCompanyAccess(req, document.companyId);
      res.setHeader("Content-Type", document.contentType);
      const filename = sanitizeDispositionFilename(document.filename);
      res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
      res.status(200).send(document.body);
      return;
    }

    const workflowContent = await workProductsSvc.getWorkflowDeliverableContentById(id);
    if (workflowContent) {
      assertCompanyAccess(req, workflowContent.companyId);
      res.setHeader("Content-Type", workflowContent.contentType);
      const filename = sanitizeDispositionFilename(workflowContent.filename);
      res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
      if (workflowContent.body != null) {
        res.status(200).send(workflowContent.body);
        return;
      }
      if (workflowContent.objectKey) {
        const object = await getStorageService().getObject(workflowContent.companyId, workflowContent.objectKey);
        if (object.contentLength != null) {
          res.setHeader("Content-Length", String(object.contentLength));
        }
        object.stream.on("error", (err) => {
          next(err);
        });
        object.stream.pipe(res);
        return;
      }
      // Deliverable row exists but has no content — respond explicitly rather than falling through.
      res.status(404).json({ error: "Deliverable content not available" });
      return;
    }

    const deliverable = await workProductsSvc.getDeliverableById(id);
    if (!deliverable) {
      res.status(404).json({ error: "Deliverable not found" });
      return;
    }
    assertCompanyAccess(req, deliverable.companyId);
    res.redirect(302, deliverable.contentPath);
  });

  return router;
}
