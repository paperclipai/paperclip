import { Router } from "express";
import type { Db } from "@paperclipai/db";
import {
  companyRolloutCreateSchema,
  companyRolloutTargetSelectionSchema,
} from "@paperclipai/shared";
import { validate } from "../middleware/validate.js";
import { companyRolloutService } from "../services/company-rollouts.js";
import { assertCompanyAccess, assertInstanceAdmin } from "./authz.js";

export function companyRolloutRoutes(db: Db) {
  const router = Router();
  const svc = companyRolloutService(db);

  router.get("/companies/:sourceCompanyId/rollouts", async (req, res) => {
    assertInstanceAdmin(req);
    const sourceCompanyId = req.params.sourceCompanyId as string;
    assertCompanyAccess(req, sourceCompanyId);
    const releases = await svc.listReleases(sourceCompanyId);
    res.json(releases);
  });

  router.post("/companies/:sourceCompanyId/rollouts", validate(companyRolloutCreateSchema), async (req, res) => {
    assertInstanceAdmin(req);
    const sourceCompanyId = req.params.sourceCompanyId as string;
    assertCompanyAccess(req, sourceCompanyId);
    const release = await svc.createRelease(sourceCompanyId, req.body, req.actor.type === "board" ? req.actor.userId : null);
    res.status(201).json(release);
  });

  router.get("/company-rollouts/:releaseId", async (req, res) => {
    assertInstanceAdmin(req);
    const releaseId = req.params.releaseId as string;
    const detail = await svc.getReleaseDetail(releaseId);
    assertCompanyAccess(req, detail.release.sourceCompanyId);
    res.json(detail);
  });

  router.post("/company-rollouts/:releaseId/preview", validate(companyRolloutTargetSelectionSchema), async (req, res) => {
    assertInstanceAdmin(req);
    const releaseId = req.params.releaseId as string;
    const preview = await svc.previewRelease(releaseId, req.body, req.actor.type === "board" ? req.actor.userId : null);
    assertCompanyAccess(req, preview.release.sourceCompanyId);
    res.json(preview);
  });

  router.post("/company-rollouts/:releaseId/apply", validate(companyRolloutTargetSelectionSchema), async (req, res) => {
    assertInstanceAdmin(req);
    const releaseId = req.params.releaseId as string;
    const result = await svc.applyRelease(releaseId, req.body, req.actor.type === "board" ? req.actor.userId : null);
    assertCompanyAccess(req, result.release.sourceCompanyId);
    res.json(result);
  });

  return router;
}
