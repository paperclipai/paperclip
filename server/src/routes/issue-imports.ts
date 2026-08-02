import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { applyLinearIssueImportSchema, previewLinearIssueImportSchema } from "@paperclipai/shared";
import { validate } from "../middleware/validate.js";
import { issueImportService } from "../services/issue-imports.js";
import { assertBoard, assertCompanyAccess, getActorInfo } from "./authz.js";

export function issueImportRoutes(db: Db) {
  const router = Router();
  const service = issueImportService(db);

  router.post(
    "/companies/:companyId/issue-imports/preview",
    validate(previewLinearIssueImportSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertBoard(req);
      assertCompanyAccess(req, companyId);
      const actor = getActorInfo(req);
      const result = await service.preview(companyId, req.body, {
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
      });
      res.status(201).json(result);
    },
  );

  router.post(
    "/companies/:companyId/issue-imports/apply",
    validate(applyLinearIssueImportSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertBoard(req);
      assertCompanyAccess(req, companyId);
      const actor = getActorInfo(req);
      const result = await service.apply(companyId, req.body, {
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
      });
      res.json(result);
    },
  );

  router.get("/companies/:companyId/issue-imports/:runId", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertBoard(req);
    assertCompanyAccess(req, companyId);
    const result = await service.getReport(companyId, req.params.runId as string);
    if (!result) {
      res.status(404).json({ error: "Issue import run not found" });
      return;
    }
    res.json(result);
  });

  return router;
}
