import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { assertCompanyAccess } from "./authz.js";
import { researchDocumentService } from "../services/index.js";

export function researchDocumentRoutes(db: Db) {
  const router = Router();
  const svc = researchDocumentService(db);

  router.get("/companies/:companyId/research-documents", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const items = await svc.list(companyId);
    res.json(items);
  });

  router.get("/companies/:companyId/research-documents/:documentId", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const document = await svc.get(companyId, req.params.documentId as string);
    if (!document) {
      res.status(404).json({ error: "Research document not found" });
      return;
    }
    res.json(document);
  });

  return router;
}
